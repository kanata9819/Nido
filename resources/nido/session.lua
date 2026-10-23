local channel = ...
vim.g.nido_channel = channel
-- Keep plugin/LSP notices out of the grid and avoid Neovim's hit-enter prompt.
vim.notify = function(message, level, opts)
  vim.rpcnotify(channel, 'nido:message', tostring(message), level or vim.log.levels.INFO,
    opts and opts.title or (message == 'No locations found' and 'Code navigation' or 'Nido'))
end
local edit_ticks = {}
vim.api.nvim_create_autocmd({'TextChanged', 'TextChangedI', 'TextChangedP'}, {
  callback = function(event)
    local tick = vim.api.nvim_buf_get_changedtick(event.buf)
    -- Temporary :normal scrolling can report the same edit again in another mode.
    if edit_ticks[event.buf] == tick then
      return
    end
    edit_ticks[event.buf] = tick
    vim.rpcnotify(channel, 'nido:edit')
  end,
})
vim.api.nvim_create_autocmd('BufWipeout', {callback=function(event) edit_ticks[event.buf] = nil end})
-- Publish viewport movement during redraw, before its flush. WinScrolled runs
-- after the flush and would leave a stale scroll notification in the next frame.
local views = {}
vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace('nido_viewport'), {
  on_win = function(_, win, buffer)
    local info = vim.fn.getwininfo(win)[1]
    local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    local previous = views[win]
    views[win] = {buffer=buffer, height=info.height, width=info.width,
      topline=view.topline, skipcol=view.skipcol, leftcol=view.leftcol, topfill=view.topfill}
    if not previous or previous.buffer ~= buffer then
      vim.rpcnotify(channel, 'nido:buffer', win, buffer)
    end
    if not previous or previous.buffer ~= buffer or previous.height ~= info.height
        or previous.width ~= info.width
        -- Deleting lines can remove the old viewport; it has no valid scroll distance.
        or previous.topline > vim.api.nvim_buf_line_count(buffer) then
      return false
    end
    local columns = view.leftcol - previous.leftcol
    if view.topline == previous.topline and view.skipcol == previous.skipcol
        and view.topfill == previous.topfill and columns == 0 then
      return false
    end
    local rows = require('nido_scroll').view_distance(win, previous, view)
    local top, left = info.winrow - 1, info.wincol - 1
    -- Horizontal scrolling leaves line numbers and signs fixed in place.
    vim.rpcnotify(channel, 'nido:scroll', {
      1, top, top + info.height, rows == 0 and left + info.textoff or left,
      left + info.width, rows, columns, view.topline <= 1 and view.skipcol == 0,
    })
    return false
  end,
})
vim.api.nvim_create_autocmd('WinClosed', {callback=function(event)
  views[tonumber(event.match)] = nil
end})
-- LSP messages belong in Nido's nonblocking notification, not Neovim's hit-enter prompt.
vim.lsp.handlers['window/showMessage'] = function(_, params, ctx)
  local client = vim.lsp.get_client_by_id(ctx.client_id)
  local severity = vim.lsp.protocol.MessageType[params.type] or 'Info'
  local message = ('LSP[%s][%s] %s'):format(client and client.name or ctx.client_id, severity, params.message)
  local log = ({vim.lsp.log.error, vim.lsp.log.warn, vim.lsp.log.info, vim.lsp.log.debug})[params.type]
  if log then
    log(message)
  end
  local level = ({vim.log.levels.ERROR, vim.log.levels.WARN, vim.log.levels.INFO, vim.log.levels.DEBUG})[params.type]
  vim.notify(message, level, {title = 'Language server'})
end
local pending = false
local progress = {}
local diagnostics = vim.empty_dict()
local diagnostics_dirty = true
local problems = {}
local diagnostics_version = 0
local published_diagnostics_version = -1
local buffers = {}
local buffers_dirty = true
local publish
local search_cache, search_pending
local search_delay = 16
local function search_context()
  local pattern = vim.fn.getreg('/')
  if vim.v.hlsearch ~= 1 or pattern == '' or vim.bo.buftype ~= '' then
    return nil
  end
  local cursor = vim.api.nvim_win_get_cursor(0)
  local context = table.concat({vim.api.nvim_get_current_buf(), vim.api.nvim_buf_get_changedtick(0),
    pattern, tostring(vim.o.ignorecase), tostring(vim.o.smartcase),
    tostring(vim.o.magic), vim.bo.iskeyword, vim.o.regexpengine}, '\0')
  return {context=context, key=context .. '\0' .. cursor[1] .. ':' .. cursor[2], pattern=pattern}
end
local function search_status()
  local request = search_context()
  if not request then
    search_cache = nil
    search_pending = nil
    search_delay = 16
    return false
  end
  if search_cache and search_cache.key == request.key then
    -- Moving back to the cached position also invalidates a different queued count.
    search_pending = nil
    return search_cache.value
  end
  if not search_pending or search_pending.key ~= request.key then
    request.started = search_pending and search_pending.started or vim.uv.hrtime()
    search_pending = request
    -- Keep full-buffer regex scans off the immediate cursor/input notification.
    -- Slow counts wait for nearby inputs, but continuous movement still updates
    -- at least every 120ms (plus the event loop's timer scheduling).
    local delay = math.min(search_delay, math.max(0, 120 - (vim.uv.hrtime() - request.started) / 1e6))
    vim.defer_fn(function()
      if search_pending ~= request then return end
      local current = search_context()
      search_pending = nil
      if not current or current.key ~= request.key then
        publish()
        return
      end
      local started = vim.uv.hrtime()
      local ok, count = pcall(vim.fn.searchcount, {recompute=1, maxcount=9999, timeout=10})
      search_delay = math.min(80, math.max(16, (vim.uv.hrtime() - started) / 1e6 * 8))
      local value = ok and {pattern=request.pattern, current=count.current or 0,
        total=count.total or 0, incomplete=count.incomplete or 0} or false
      search_cache = {context=request.context, key=request.key, value=value}
      publish()
    end, delay)
  end
  if search_cache and search_cache.context == request.context then return search_cache.value end
  return {pattern=request.pattern, current=0, total=0, incomplete=1}
end
local function refresh_diagnostics()
  if not diagnostics_dirty then
    return
  end
  diagnostics_dirty = false
  diagnostics = vim.empty_dict()
  problems = {}
  diagnostics_version = diagnostics_version + 1
  for _, diagnostic in ipairs(vim.diagnostic.get()) do
    if vim.api.nvim_buf_is_valid(diagnostic.bufnr) then
      local path = vim.api.nvim_buf_get_name(diagnostic.bufnr)
      if path ~= '' then
        table.insert(problems, {
          path = path,
          line = diagnostic.lnum + 1,
          column = diagnostic.col + 1,
          severity = diagnostic.severity,
          message = diagnostic.message,
          source = diagnostic.source or '',
        })
      end
    end
    if diagnostic.severity <= vim.diagnostic.severity.WARN and vim.api.nvim_buf_is_valid(diagnostic.bufnr) then
      local name = vim.api.nvim_buf_get_name(diagnostic.bufnr)
      if name ~= '' then
        diagnostics[name] = math.min(diagnostics[name] or diagnostic.severity, diagnostic.severity)
      end
    end
  end
end

local function lsp_status()
  local clients = {}
  local tasks = {}
  local buffer = vim.api.nvim_get_current_buf()
  -- get_clients({bufnr=0}) filters the same live list by attached_buffers.
  -- Reuse this enumeration without caching initialization, progress or exits.
  for _, client in ipairs(vim.lsp.get_clients()) do
    if not client.initialized then
      table.insert(tasks, client.name .. ': 起動中…')
    end
    if client.initialized and client.attached_buffers[buffer] then
      table.insert(clients, client.name)
    end
    for _, value in pairs(progress[client.id] or {}) do
      local message = client.name .. ': ' .. (value.title or '読み込み中')
      if value.message and value.message ~= '' then
        message = message .. ' — ' .. value.message
      end
      if value.percentage then
        message = message .. ' (' .. value.percentage .. '%)'
      end
      table.insert(tasks, message)
    end
  end
  table.sort(tasks)
  return table.concat(clients, ', '), table.concat(tasks, ' / ')
end

publish = function()
  if pending then
    return
  end
  pending = true
  vim.schedule(function()
    pending = false
    refresh_diagnostics()
    local changed_buffers = buffers_dirty
    if changed_buffers then
      buffers_dirty = false
      buffers = {}
      for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_valid(buffer) and vim.bo[buffer].buflisted then
          table.insert(buffers, {
            id = buffer,
            name = vim.api.nvim_buf_get_name(buffer),
            modified = vim.bo[buffer].modified,
          })
        end
      end
    end
    local scroll = require('nido_scroll')
    local pos = scroll.cursor() or vim.api.nvim_win_get_cursor(0)
    local ending = vim.g.nido and require('nido_eol').detect() or nil
    if ending == 'Mixed' and not vim.b.nido_mixed_notified then
      vim.b.nido_mixed_notified = true
      vim.rpcnotify(channel, 'nido:message',
        'Mixed line endings detected. Choose LF or CRLF in the status bar to normalize, then save.')
    end
    local clients, tasks = lsp_status()
    local empty = #buffers == 1 and buffers[1].id == vim.api.nvim_get_current_buf()
      and buffers[1].name == '' and not buffers[1].modified and vim.bo.buftype == ''
      and vim.api.nvim_buf_line_count(0) == 1 and vim.api.nvim_get_current_line() == ''
      and #vim.api.nvim_tabpage_list_wins(0) == 1
    local state = {
      search = search_status(),
      diagnosticsVersion = diagnostics_version,
      scrollCursor = scroll.screen_cursor() or vim.NIL,
      scrollPercent = math.min(100, math.floor(100 * (vim.fn.line('w0') - 1)
        / math.max(1, vim.api.nvim_buf_line_count(0) - (vim.fn.line('w$') - vim.fn.line('w0') + 1)) + 0.5)),
      current = vim.api.nvim_get_current_buf(),
      lineEnding = ending or vim.NIL,
      lsp = clients,
      lspProgress = tasks,
      empty = empty,
      mode = vim.api.nvim_get_mode().mode,
      line = pos[1],
      column = pos[2] + 1,
      filetype = vim.bo.filetype,
    }
    -- Keep cursor updates small even in projects with thousands of diagnostics.
    if diagnostics_version ~= published_diagnostics_version then
      state.problems = problems
      state.diagnostics = diagnostics
      published_diagnostics_version = diagnostics_version
    end
    if changed_buffers then state.buffers = buffers end
    vim.rpcnotify(channel, 'nido:state', state)
  end)
end

vim.api.nvim_create_autocmd({ 'DiagnosticChanged', 'BufDelete', 'BufWipeout', 'BufFilePost' }, {
  callback = function()
    diagnostics_dirty = true
    publish()
  end,
})
vim.api.nvim_create_autocmd('LspProgress', {
  callback = function(event)
    local id, params = event.data.client_id, event.data.params
    local value = params.value
    if type(value) ~= 'table' or not value.kind then
      return
    end
    progress[id] = progress[id] or {}
    if value.kind == 'end' then
      progress[id][params.token] = nil
      if next(progress[id]) == nil then
        progress[id] = nil
      end
    else
      progress[id][params.token] = vim.tbl_extend('force', progress[id][params.token] or {}, value)
    end
    publish()
  end,
})
vim.api.nvim_create_autocmd({
  'BufEnter', 'BufAdd', 'BufDelete', 'BufWipeout', 'BufModifiedSet', 'BufFilePost', 'BufWritePost',
}, {callback=function() buffers_dirty = true; publish() end})
vim.api.nvim_create_autocmd('OptionSet', {
  pattern={'buflisted', 'modified'}, callback=function() buffers_dirty = true; publish() end,
})
vim.api.nvim_create_autocmd({
  'BufEnter', 'BufAdd', 'BufDelete', 'BufModifiedSet', 'BufFilePost', 'BufWritePost',
  'ModeChanged', 'CursorMoved', 'CursorMovedI', 'FileType', 'TextChanged', 'TextChangedI', 'CmdlineLeave',
  'WinEnter', 'WinClosed', 'WinScrolled', 'WinResized', 'LspAttach', 'LspDetach',
}, { callback = publish })
vim.api.nvim_create_autocmd('User', { pattern = { 'NidoLineEndings', 'NidoScroll', 'NidoSearch' }, callback = publish })
vim.api.nvim_create_autocmd('OptionSet', { pattern = { 'fileformat', 'endofline' }, callback = publish })
publish()
