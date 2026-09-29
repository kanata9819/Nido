local channel = ...
vim.g.nido_channel = channel
vim.api.nvim_create_autocmd({'TextChanged', 'TextChangedI', 'TextChangedP'}, {
  callback = function() vim.rpcnotify(channel, 'nido:edit') end,
})
-- Single-grid UIs can receive a full repaint instead of grid_scroll on upward scrolling.
vim.api.nvim_create_autocmd('WinScrolled', {
  callback = function()
    for id, change in pairs(vim.v.event) do
      local win = tonumber(id)
      if win and change.height == 0 and change.width == 0
          and (change.topline ~= 0 or change.skipcol ~= 0 or change.leftcol ~= 0) then
        local info = vim.fn.getwininfo(win)[1]
        local before = info.topline - change.topline
        if before >= 1 and before <= vim.api.nvim_buf_line_count(info.bufnr) then
          local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
          local old_skip = math.max(0, view.skipcol - change.skipcol)
          local forward = change.topline > 0 or (change.topline == 0 and change.skipcol > 0)
          local rows = 0
          if change.topline ~= 0 or change.skipcol ~= 0 then
            rows = vim.api.nvim_win_text_height(win, {
              start_row = (forward and before or info.topline) - 1,
              end_row = (forward and info.topline or before) - 1,
              start_vcol = forward and old_skip or view.skipcol,
              end_vcol = forward and view.skipcol or old_skip,
            }).all
            if not forward then
              rows = -rows
            end
          end
          local top = info.winrow - 1
          local left = info.wincol - 1
          -- Horizontal scrolling leaves line numbers and signs fixed in place.
          local text_left = rows == 0 and left + info.textoff or left
          vim.rpcnotify(channel, 'nido:scroll', {
            1, top, top + info.height, text_left, left + info.width, rows, change.leftcol
          })
        end
      end
    end
  end,
})
-- LSP messages belong in Nido's nonblocking notification, not Neovim's hit-enter prompt.
vim.lsp.handlers['window/showMessage'] = function(_, params, ctx)
  local client = vim.lsp.get_client_by_id(ctx.client_id)
  local severity = vim.lsp.protocol.MessageType[params.type] or 'Info'
  local message = ('LSP[%s][%s] %s'):format(client and client.name or ctx.client_id, severity, params.message)
  local log = ({vim.lsp.log.error, vim.lsp.log.warn, vim.lsp.log.info, vim.lsp.log.debug})[params.type]
  if log then
    log(message)
  end
  vim.rpcnotify(channel, 'nido:message', message)
end
local pending = false
local progress = {}
local diagnostics = vim.empty_dict()
local diagnostics_dirty = true
local problems = {}
local diagnostics_version = 0
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
  for _, client in ipairs(vim.lsp.get_clients()) do
    if not client.initialized then
      table.insert(tasks, client.name .. ': 起動中…')
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
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = 0 })) do
    if client.initialized then
      table.insert(clients, client.name)
    end
  end
  return table.concat(clients, ', '), table.concat(tasks, ' / ')
end

local function publish()
  if pending then
    return
  end
  pending = true
  vim.schedule(function()
    pending = false
    refresh_diagnostics()
    local buffers = {}
    for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(buffer) and vim.bo[buffer].buflisted then
        table.insert(buffers, {
          id = buffer,
          name = vim.api.nvim_buf_get_name(buffer),
          modified = vim.bo[buffer].modified,
        })
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
    vim.rpcnotify(channel, 'nido:state', {
      search = (function()
        if vim.v.hlsearch ~= 1 or vim.fn.getreg('/') == '' or vim.bo.buftype ~= '' then return false end
        -- ponytail: cap counting at 9999 matches/10 ms; show a partial count for huge files.
        local ok, count = pcall(vim.fn.searchcount, {recompute=1, maxcount=9999, timeout=10})
        if not ok then return false end
        return {pattern=vim.fn.getreg('/'), current=count.current or 0, total=count.total or 0, incomplete=count.incomplete or 0}
      end)(),
      problems = problems,
      diagnosticsVersion = diagnostics_version,
      scrollCursor = scroll.screen_cursor(),
      scrollPercent = math.min(100, math.floor(100 * (vim.fn.line('w0') - 1)
        / math.max(1, vim.api.nvim_buf_line_count(0) - (vim.fn.line('w$') - vim.fn.line('w0') + 1)) + 0.5)),
      diagnostics = diagnostics,
      buffers = buffers,
      current = vim.api.nvim_get_current_buf(),
      lineEnding = ending,
      lsp = clients,
      lspProgress = tasks,
      empty = empty,
      mode = vim.api.nvim_get_mode().mode,
      line = pos[1],
      column = pos[2] + 1,
      filetype = vim.bo.filetype,
    })
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
  'BufEnter', 'BufAdd', 'BufDelete', 'BufModifiedSet', 'BufFilePost', 'BufWritePost',
  'ModeChanged', 'CursorMoved', 'CursorMovedI', 'FileType', 'TextChanged', 'TextChangedI', 'CmdlineLeave',
  'WinEnter', 'WinClosed', 'WinScrolled', 'WinResized', 'LspAttach', 'LspDetach',
}, { callback = publish })
vim.api.nvim_create_autocmd('User', { pattern = { 'NidoLineEndings', 'NidoScroll', 'NidoSearch' }, callback = publish })
vim.api.nvim_create_autocmd('OptionSet', { pattern = { 'fileformat', 'endofline' }, callback = publish })
publish()
