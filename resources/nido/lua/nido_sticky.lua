local M = {}
local api = vim.api
local entries, pending, published, color_pending = {}, {}, {}, {}

local function redraw()
  -- Outline changes do not dirty buffer rows, so force decoration providers to run again.
  vim.schedule(function() vim.cmd.redraw({bang=true}) end)
end

local function fallback(buffer, lines)
  local scopes = {}
  for _, pair in ipairs(require('nido_brackets').pairs(buffer)) do
    if pair.first.bracket == '{' then
      local first = pair.first.row + 1
      if lines[first]:match('^%s*{%s*$') then
        for previous = first - 1, math.max(1, first - 20), -1 do
          if lines[previous]:match('%S') and not lines[previous]:match('^%s*[%)%]%}]')
              and not lines[previous]:match('^%s*[/#]')
              and vim.fn.indent(previous) <= vim.fn.indent(first) then
            first = previous
            break
          end
        end
      end
      scopes[#scopes + 1] = {line=first, ending=pair.last.row + 1}
    end
  end
  if #scopes == 0 then
    -- Indentation is the fallback for languages without brace scopes or an outline server.
    local stack, previous, previous_indent = {}, nil, 0
    for row, text in ipairs(lines) do
      if text:match('%S') and not text:match('^%s*[/#]') then
        local indent = vim.fn.indent(row)
        while #stack > 0 and indent <= stack[#stack].indent do
          local scope = table.remove(stack)
          scopes[#scopes + 1] = {line=scope.line, ending=previous}
        end
        if previous and indent > previous_indent then
          stack[#stack + 1] = {line=previous, indent=previous_indent}
        end
        previous, previous_indent = row, indent
      end
    end
    for _, scope in ipairs(stack) do
      scopes[#scopes + 1] = {line=scope.line, ending=previous}
    end
  end
  return scopes
end

local function sort(scopes)
  table.sort(scopes, function(a, b)
    return a.line < b.line or (a.line == b.line and a.ending > b.ending)
  end)
  return scopes
end

local function refresh(buffer)
  if not api.nvim_buf_is_valid(buffer) or not api.nvim_buf_is_loaded(buffer)
      or vim.bo[buffer].buftype ~= '' then
    entries[buffer] = nil
    redraw()
    return
  end
  local tick = api.nvim_buf_get_changedtick(buffer)
  if api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then
    entries[buffer] = {tick=tick, lines={}, scopes={}, highlights={}}
    redraw()
    return
  end
  local lines = api.nvim_buf_get_lines(buffer, 0, -1, false)
  -- Match the existing bracket scanner's bound; never scan a huge file during scrolling.
  local scopes = api.nvim_buf_call(buffer, function() return fallback(buffer, lines) end)
  local entry = {tick=tick, lines=lines, scopes=sort(scopes), highlights={}}
  entries[buffer] = entry
  redraw()
  for _, client in ipairs(vim.lsp.get_clients({bufnr=buffer, method='textDocument/documentSymbol'})) do
    if client.initialized then
      client:request('textDocument/documentSymbol', {textDocument={uri=vim.uri_from_bufnr(buffer)}}, function(err, result)
        if err or not result or entries[buffer] ~= entry or not api.nvim_buf_is_valid(buffer)
            or api.nvim_buf_get_changedtick(buffer) ~= tick then return end
        local outline = {}
        local function visit(items)
          for _, item in ipairs(items) do
            local range = item.range or (item.location and item.location.range)
            if range and (not item.location or item.location.uri == vim.uri_from_bufnr(buffer)) then
              local first = (item.selectionRange or range).start.line + 1
              local last = range['end'].line + (range['end'].character > 0 and 1 or 0)
              if last > first and first <= #lines then
                outline[#outline + 1] = {line=first, ending=math.min(last, #lines)}
              end
            end
            if item.children then visit(item.children) end
          end
        end
        visit(result)
        if #outline > 0 then entry.scopes = sort(outline); entry.highlights = {}; redraw() end
      end, buffer)
      break
    end
  end
end

local function schedule(buffer)
  local ticket = {}
  pending[buffer] = ticket
  -- Structure is cached between edits; wheel frames only read it and their screen positions.
  vim.defer_fn(function()
    if pending[buffer] ~= ticket then return end
    pending[buffer] = nil
    refresh(buffer)
  end, 120)
end

local function highlight(entry, buffer, line)
  if not entry.highlights[line] then
    local text = entry.lines[line] or ''
    entry.highlights[line] = require('nido_references').highlight(buffer, line, {text})[1]
  end
  return entry.highlights[line]
end

local function recolor(buffer)
  if color_pending[buffer] or not entries[buffer] then return end
  color_pending[buffer] = true
  -- Token notifications can arrive during redraw, once per token. Repaint once afterwards.
  vim.schedule(function()
    color_pending[buffer] = nil
    local entry = entries[buffer]
    if not entry or next(entry.highlights) == nil then return end
    entry.highlights = {}
    redraw()
  end)
end

function M.publish(window, buffer)
  if not vim.g.nido_channel or window ~= api.nvim_get_current_win() then return false end
  local info = vim.fn.getwininfo(window)[1]
  if not info then return false end
  local state = {window=window, buffer=buffer, top=info.winrow - 1, left=info.wincol - 1,
    width=info.width, height=info.height, gutter=info.textoff, tabstop=vim.bo[buffer].tabstop,
    leftcol=0, scopes={}}
  local entry = entries[buffer]
  if entry and entry.tick == api.nvim_buf_get_changedtick(buffer)
      and vim.bo[buffer].buftype == '' and api.nvim_win_get_config(window).relative == '' then
    api.nvim_win_call(window, function()
      local view = vim.fn.winsaveview()
      state.leftcol = view.leftcol
      for _, scope in ipairs(entry.scopes) do
        if scope.line <= vim.fn.line('w$') and scope.ending >= view.topline
            and not (vim.fn.foldclosed(scope.line) >= 0 and vim.fn.foldclosedend(scope.line) >= scope.ending) then
          local first = vim.fn.screenpos(window, scope.line, 1)
          local last = vim.fn.screenpos(window, scope.ending, 1)
          if scope.line < view.topline or (first.row > 0 and first.row - 1 < state.top + 10) then
            state.scopes[#state.scopes + 1] = {line=scope.line, ending=scope.ending,
              top=scope.line < view.topline and -1 or first.row - 1,
              bottom=last.row > 0 and last.row - 1 or state.top + info.height + 10,
              text=highlight(entry, buffer, scope.line), endText=highlight(entry, buffer, scope.ending)}
          end
        end
      end
    end)
  elseif vim.bo[buffer].buftype == '' and not pending[buffer] then
    schedule(buffer)
  end
  if not vim.deep_equal(published[window], state) then
    published[window] = state
    vim.rpcnotify(vim.g.nido_channel, 'nido:sticky_scroll', state)
  end
  return false
end

function M.jump(window, buffer, line)
  if window ~= api.nvim_get_current_win() or buffer ~= api.nvim_get_current_buf()
      or vim.bo.buftype ~= '' or line < 1 or line > api.nvim_buf_line_count(buffer) then return false end
  require('nido_scroll').restore()
  api.nvim_win_set_cursor(window, {line, 0})
  vim.cmd.normal({args={'zv'}, bang=true})
  require('nido_scroll').center()
  return true
end

api.nvim_set_decoration_provider(api.nvim_create_namespace('nido_sticky'), {on_win=function(_, win, buffer)
  return M.publish(win, buffer)
end})
api.nvim_create_autocmd({'BufWinEnter', 'FileType', 'Syntax', 'TextChanged', 'TextChangedI', 'TextChangedP', 'LspAttach', 'LspDetach'}, {
  callback=function(event) schedule(event.buf) end,
})
api.nvim_create_autocmd('LspTokenUpdate', {callback=function(event) recolor(event.buf) end})
api.nvim_create_autocmd('LspRequest', {callback=function(event)
  local request = event.data.request
  -- A response containing only offscreen tokens does not emit LspTokenUpdate.
  if request.type == 'complete' and request.method:match('^textDocument/semanticTokens/') then
    recolor(event.buf)
  end
end})
api.nvim_create_autocmd('ColorScheme', {callback=function()
  for buffer in pairs(entries) do schedule(buffer) end
end})
api.nvim_create_autocmd('BufWipeout', {callback=function(event)
  entries[event.buf], pending[event.buf], color_pending[event.buf] = nil, nil, nil
end})
api.nvim_create_autocmd('WinClosed', {callback=function(event) published[tonumber(event.match)] = nil end})
api.nvim_create_autocmd('UIEnter', {callback=function()
  -- A newly attached renderer needs the current state even when the viewport is unchanged.
  published = {}
  redraw()
end})
schedule(api.nvim_get_current_buf())
return M
