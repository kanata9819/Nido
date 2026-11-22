-- Sticky scroll and method separators. Finds each buffer's scopes (functions, classes,
-- blocks): first from bracket pairs, then from the language server's document symbols when
-- available. publish() sends the scopes around the top of the window to the renderer, which
-- pins their header lines above the editor (StickyScroll.tsx).
local M = {}
local api = vim.api
-- Per buffer: the scopes found (`entries`), the delayed refresh, what was last published,
-- and the delayed recoloring.
local entries, pending, published, color_pending = {}, {}, {}, {}
local edits = {}
--- Cancel a buffer's delayed refresh.
local function cancel_pending(buffer)
  local ticket = pending[buffer]
  pending[buffer] = nil
  if ticket and ticket.timer and not ticket.timer:is_closing() then
    ticket.timer:stop()
    ticket.timer:close()
  end
end
-- Per buffer, the document symbol request in flight.
local outlines = {}
local method_separators = false
local method_namespace = api.nvim_create_namespace('nido_method_separators')
local scope_namespace = api.nvim_create_namespace('nido_sticky_scopes')
local script_filetypes = {typescript=true, typescriptreact=true, javascript=true, javascriptreact=true}

--- Cancel a buffer's document symbol request.
local function cancel_outline(buffer)
  local request = outlines[buffer]
  outlines[buffer] = nil
  if request and request.id then request.client:cancel_request(request.id) end
end

local function redraw()
  -- Outline changes do not dirty buffer rows, so force decoration providers to run again.
  vim.schedule(function() vim.cmd.redraw({bang=true}) end)
end

local function indent_content(text)
  return text:find('%S') ~= nil and not text:find('^%s*[/#]')
end

--- Scopes from the buffer's {} pairs, with the header line found above a lone {.
local function fallback(lines, pairs)
  local scopes = {}
  for _, pair in ipairs(pairs) do
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
  local indentation = #scopes == 0
  if indentation then
    -- Indentation is the fallback for languages without brace scopes or an outline server.
    local stack, previous, previous_indent = {}, nil, 0
    for row, text in ipairs(lines) do
      if indent_content(text) then
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
  return scopes, indentation
end

--- Accumulate changed rows without reading buffer text in the edit callback.
local function watch_edits(buffer)
  if not edits[buffer] and not api.nvim_buf_attach(buffer, false, {
    on_lines = function(_, buf, tick, first, last, new_last)
      local edit = edits[buf]
      if not edit then return true end
      edit.first = math.min(edit.first or first, first)
      edit.last = math.max(edit.last or last, last)
      edit.tick = tick
      edit.full = edit.full or last ~= new_last
    end,
    on_reload = function(_, buf) if edits[buf] then edits[buf].full = true end end,
    on_detach = function(_, buf) edits[buf] = nil end,
  }) then return end
  edits[buffer] = {}
end

--- Body edits with the same indentation leave the existing scope ranges and endpoints intact.
local function reuse_indentation(buffer, entry, tick, pairs)
  local edit = edits[buffer]
  local indent = entry and entry.indent
  if not indent or not edit or edit.full or vim.bo[buffer].tabstop ~= indent.tabstop
      or vim.bo[buffer].vartabstop ~= indent.vartabstop then return false end
  for _, pair in ipairs(pairs) do
    if pair.first.bracket == '{' then return false end
  end
  if entry.tick == tick then return true end
  -- shortcut: only compare a small changed span with no line-count change, rescan structural edits.
  if edit.tick ~= tick or not edit.first or edit.last - edit.first > 128 then return false end
  local lines = api.nvim_buf_get_lines(buffer, edit.first, edit.last, false)
  for index, after in ipairs(lines) do
    local row = edit.first + index
    local before = entry.lines[row]
    if not before or indent.endpoints[row] or indent_content(before) ~= indent_content(after)
        or before:match('^%s*') ~= after:match('^%s*') then return false end
  end
  for index, text in ipairs(lines) do entry.lines[edit.first + index] = text end
  entry.tick, entry.methods = tick, nil
  edits[buffer] = {}
  return true
end

--- Order scopes by their first line, outer scopes first.
local function sort(scopes)
  table.sort(scopes, function(a, b)
    return a.line < b.line or (a.line == b.line and a.ending > b.ending)
  end)
  return scopes
end

local function previous_nonspace(text, column)
  while column > 0 and text:sub(column, column):match('%s') do column = column - 1 end
  return column
end

--- The column before `column` after skipping `word` (async, return) and spaces, if it is there.
local function skip_word(text, before, word)
  local length = #word
  if before >= length and text:sub(before - length + 1, before) == word
      and (before == length or not text:sub(before - length, before - length):match('[%w_$]')) then
    return previous_nonspace(text, before - length), true
  end
  return before, false
end

--- Whether the function starting at `column` is returned as a value, such as a cleanup.
local function returned_function(text, column)
  local before = skip_word(text, previous_nonspace(text, column - 1), 'async')
  local _, found = skip_word(text, before, 'return')
  return found
end

local function function_callback(text, from)
  local start = text:find('%f[%w]function%s*%*?%s*[%w_$]*%s*%(', from or 1)
  if not start then return false end
  local before = skip_word(text, previous_nonspace(text, start - 1), 'async')
  local token = before > 0 and text:sub(before, before) or ''
  return token == '(' or token == ',' or returned_function(text, start)
    or (before == 0 and text:sub(start):match('^function%s*%*?%s*%(')), start
end

--- The lines that start a function, found by text matching, for method separators.
local function fallback_methods(lines)
  local methods = {}
  local script = script_filetypes[vim.bo.filetype]
  local control = {['if']=true, ['else']=true, ['elseif']=true, ['for']=true, ['while']=true,
    ['switch']=true, ['catch']=true, ['with']=true, ['match']=true, ['return']=true}
  for line, text in ipairs(lines) do
    local first = text:match('^%s*([%w_$]+)')
    local name = text:match('([%w_$]+)%s*%b()%s*[^;]*{%s*$')
    local callback, from = false, 0
    if script then
      repeat
        local candidate, start = function_callback(text, from + 1)
        if not start then break end
        callback, from = candidate, start
      until not callback
    end
    if not callback and (text:match('%f[%w]fn%s+[%a_]')
        or text:match('%f[%w]def%s+[%a_]') or text:match('%f[%w]function%s*[%w_$.:%(]')
        or (name and first and not control[name] and not control[first]
          and not text:find('=', 1, true))) then
      local ignored = false
      for _, id in ipairs(vim.fn.synstack(line, text:find('%S') or 1)) do
        local name = vim.fn.synIDattr(id, 'name'):lower()
        if name:find('comment') or name:find('string') then ignored = true; break end
      end
      if not ignored then methods[#methods + 1] = line end
    end
  end
  return methods
end

--- Store the method separator lines and redraw when they changed.
local function set_methods(buffer, entry, methods)
  entry.methods = methods
  api.nvim_buf_clear_namespace(buffer, method_namespace, 0, -1)
  for _, line in ipairs(methods or {}) do
    local text = entry.lines[line] or ''
    local first = text:find('%S')
    if first then
      -- Native ranges follow edits and invalidate when the whole header is deleted.
      api.nvim_buf_set_extmark(buffer, method_namespace, line - 1, first - 1,
        {end_col=#text, invalidate=true})
    end
  end
end

--- Store a buffer's scopes and redraw when they changed.
local function set_scopes(buffer, entry, scopes)
  entry.scope_marks = {}
  api.nvim_buf_clear_namespace(buffer, scope_namespace, 0, -1)
  for _, scope in ipairs(sort(scopes)) do
    local text, ending = entry.lines[scope.line] or '', entry.lines[scope.ending] or ''
    local first = text:find('%S')
    if first then
      if entry.indent then
        entry.indent.endpoints[scope.line], entry.indent.endpoints[scope.ending] = true, true
      end
      local id = api.nvim_buf_set_extmark(buffer, scope_namespace, scope.line - 1, first - 1,
        {end_row=scope.ending - 1, end_col=#ending, invalidate=true})
      -- Separate endpoint ranges invalidate deleted headers instead of pinning their neighbors.
      entry.scope_marks[id] = {
        header=api.nvim_buf_set_extmark(buffer, scope_namespace, scope.line - 1, first - 1,
          {end_col=#text, invalidate=true}),
        ending=api.nvim_buf_set_extmark(buffer, scope_namespace, scope.ending - 1, 0,
          {end_col=#ending, invalidate=true}),
      }
    end
  end
end

--- Find a buffer's scopes again: bracket scopes now, document symbols when they arrive.
local function refresh(buffer)
  cancel_outline(buffer)
  if not api.nvim_buf_is_valid(buffer) or not api.nvim_buf_is_loaded(buffer)
      or vim.bo[buffer].buftype ~= '' then
    entries[buffer] = nil
    redraw()
    return
  end
  local tick = api.nvim_buf_get_changedtick(buffer)
  if api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then
    entries[buffer] = {tick=tick, lines={}, methods={}, highlights={}}
    set_methods(buffer, entries[buffer], {})
    set_scopes(buffer, entries[buffer], {})
    redraw()
    return
  end
  local previous = entries[buffer]
  local clients = vim.lsp.get_clients({bufnr=buffer, method='textDocument/documentSymbol'})
  local brace_pairs = require('nido_brackets').pairs(buffer)
  local cache_indent = not method_separators and #clients == 0
  if cache_indent and reuse_indentation(buffer, previous, tick, brace_pairs) then
    return
  end
  -- Bracket analysis can finish after this edit's first scope refresh.
  local lines = previous and previous.tick == tick and previous.lines
    or api.nvim_buf_get_lines(buffer, 0, -1, false)
  -- Match the existing bracket scanner's bound; never scan a huge file during scrolling.
  local scopes, indentation
  api.nvim_buf_call(buffer, function() scopes, indentation = fallback(lines, brace_pairs) end)
  local entry = {tick=tick, lines=lines,
    methods=method_separators and api.nvim_buf_call(buffer, function() return fallback_methods(lines) end) or nil,
    highlights=previous and previous.highlights or {},
    scope_marks=previous and previous.scope_marks or {}}
  if cache_indent and indentation then
    entry.indent = {endpoints={}, tabstop=vim.bo[buffer].tabstop, vartabstop=vim.bo[buffer].vartabstop}
    watch_edits(buffer)
  end
  entries[buffer] = entry
  redraw()
  local requested = false
  for _, client in ipairs(clients) do
    if client.initialized then
      requested = true
      local request = {client=client}
      outlines[buffer] = request
      local ok, id = client:request('textDocument/documentSymbol', {textDocument={uri=vim.uri_from_bufnr(buffer)}}, function(err, result)
        if outlines[buffer] ~= request then return end
        outlines[buffer] = nil
        if err or not result or entries[buffer] ~= entry or not api.nvim_buf_is_valid(buffer)
            or api.nvim_buf_get_changedtick(buffer) ~= tick then return end
        local outline, methods, seen = {}, {}, {}
        local function visit(items)
          for _, item in ipairs(items) do
            local range = item.range or (item.location and item.location.range)
            if range and (not item.location or item.location.uri == vim.uri_from_bufnr(buffer)) then
              local first = (item.selectionRange or range).start.line + 1
              local last = range['end'].line + (range['end'].character > 0 and 1 or 0)
              -- TS servers expose inline callbacks as synthetic "... callback" functions.
              -- Keep their sticky scopes without adding method separators.
              local callback = false
              if script_filetypes[vim.bo[buffer].filetype] and item.kind == 12 then
                callback = (item.name or ''):match(' callback$')
                if not callback then
                  local text = lines[range.start.line + 1] or ''
                  local column = vim.str_byteindex(text, client.offset_encoding or 'utf-16', range.start.character, false)
                  -- A returned arrow function, such as an effect's cleanup, is a value too.
                  callback = function_callback(text, column + 1) or returned_function(text, column + 1)
                end
              end
              if (item.kind == 6 or item.kind == 9 or item.kind == 12)
                  and not callback and first <= #lines and not seen[first] then
                seen[first] = true
                methods[#methods + 1] = first
              end
              if last > first and first <= #lines then
                outline[#outline + 1] = {line=first, ending=math.min(last, #lines)}
              end
            end
            if item.children then visit(item.children) end
          end
        end
        visit(result)
        set_scopes(buffer, entry, outline)
        table.sort(methods)
        set_methods(buffer, entry, methods)
        redraw()
      end, buffer)
      request.id = id
      if not ok and outlines[buffer] == request then outlines[buffer] = nil end
      break
    end
  end
  -- Retain tracked separators until the new outline replaces them, including empty replies.
  if not requested or not previous then
    set_methods(buffer, entry, entry.methods)
    set_scopes(buffer, entry, scopes)
  end
end

--- Refresh a buffer shortly after it changes.
local function schedule(buffer)
  cancel_outline(buffer)
  cancel_pending(buffer)
  local ticket = {}
  pending[buffer] = ticket
  -- Structure is cached between edits; wheel frames only read it and their screen positions.
  ticket.timer = vim.defer_fn(function()
    if pending[buffer] ~= ticket then return end
    pending[buffer] = nil
    refresh(buffer)
  end, 120)
end

--- The colored text of a scope's header (or end) line, cached until the line changes.
local function highlight(entry, buffer, line, scope, key)
  local text = api.nvim_buf_get_lines(buffer, line - 1, line, false)[1] or ''
  if scope.colors ~= entry.highlights then
    scope.colors, scope.header_colors, scope.ending_colors = entry.highlights, nil, nil
  end
  local cached = scope[key] or entry.highlights[line]
  local columns = cached and cached.text == text and cached.columns
  if not columns then
    columns = {}
    local column = 0
    for character in text:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
      columns[#columns + 1] = column
      column = column + #character
    end
  end
  local tokens, count, changed = {}, 0,
    not cached or cached.text ~= text or cached.tabstop ~= vim.bo[buffer].tabstop
  -- An unchanged header can move before the LSP replaces its old coordinates.
  -- Keep its colors until the response invalidates the cache for the new row.
  if not cached or cached.line == line or changed then
    for _, column in ipairs(columns) do
      for _, token in ipairs(vim.lsp.semantic_tokens.get_at_pos(buffer, line - 1, column) or {}) do
        if not tokens[token] then
          tokens[token], count = true, count + 1
          changed = changed or not cached.tokens[token]
        end
      end
    end
    changed = changed or count ~= cached.token_count
  end
  if changed then
    local spans, column = {}, 0
    for _, span in ipairs(require('nido_references').highlight(buffer, line, {text})[1]) do
      for character in span.text:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
        local previous = spans[#spans]
        if previous and vim.fn.strdisplaywidth(previous.text .. character,
            column - previous.cells) == previous.cells then
          previous.text = previous.text .. character
        else
          local cells = vim.fn.strdisplaywidth(character, column)
          spans[#spans + 1] = {text=character, color=span.color, cells=cells}
          column = column + cells
        end
      end
    end
    cached = {text=text, line=line, columns=columns, tokens=tokens, token_count=count,
      tabstop=vim.bo[buffer].tabstop, spans=spans}
  end
  scope[key], entry.highlights[line] = cached, cached
  return cached.spans
end

--- Drop cached colors after highlighting changed, for example when semantic tokens arrive.
local function recolor(buffer)
  if color_pending[buffer] or not entries[buffer] then return end
  color_pending[buffer] = true
  -- Coalesce semantic replies and let their handlers update the token data first.
  vim.schedule(function()
    color_pending[buffer] = nil
    local entry = entries[buffer]
    if not entry or next(entry.highlights) == nil then return end
    entry.highlights = {}
    redraw()
  end)
end

--- Send the sticky scroll state of the current window to the renderer.
function M.publish(window, buffer)
  if not vim.g.nido_channel or window ~= api.nvim_get_current_win() then return false end
  local info = vim.fn.getwininfo(window)[1]
  if not info then return false end
  local state = {window=window, buffer=buffer, top=info.winrow - 1, left=info.wincol - 1,
    width=info.width, height=info.height, gutter=info.textoff, tabstop=vim.bo[buffer].tabstop,
    leftcol=0, scopes={}, separators={}, relativeTo=vim.wo[window].relativenumber
      and (require('nido_scroll').cursor() or api.nvim_win_get_cursor(window))[1] or nil}
  local entry = entries[buffer]
  local current = entry and entry.tick == api.nvim_buf_get_changedtick(buffer)
  if entry
      and vim.bo[buffer].buftype == '' and api.nvim_win_get_config(window).relative == '' then
    api.nvim_win_call(window, function()
      local view = vim.fn.winsaveview()
      local last_line = vim.fn.line('w$')
      state.leftcol = view.leftcol
      for _, mark in ipairs(api.nvim_buf_get_extmarks(buffer, scope_namespace,
          {view.topline - 1, 0}, {last_line - 1, -1}, {details=true, overlap=true})) do
        local scope = entry.scope_marks[mark[1]]
        if scope and not mark[4].invalid then
          local header = api.nvim_buf_get_extmark_by_id(buffer, scope_namespace, scope.header, {details=true})
          local ending = api.nvim_buf_get_extmark_by_id(buffer, scope_namespace, scope.ending, {details=true})
          if header[3] and ending[3] and not header[3].invalid and not ending[3].invalid then
            local line, finish = header[1] + 1, ending[1] + 1
            if line < finish
                and not (vim.fn.foldclosed(line) >= 0 and vim.fn.foldclosedend(line) >= finish) then
              local first = vim.fn.screenpos(window, line, 1)
              local last = vim.fn.screenpos(window, finish, 1)
              if line < view.topline or (first.row > 0 and first.row - 1 < state.top + 10) then
                state.scopes[#state.scopes + 1] = {line=line, ending=finish,
                  top=line < view.topline and -1 or first.row - 1,
                  bottom=last.row > 0 and last.row - 1 or state.top + info.height + 10,
                  text=highlight(entry, buffer, line, scope, 'header_colors'),
                  endText=highlight(entry, buffer, finish, scope, 'ending_colors')}
              end
            end
          end
        end
      end
      sort(state.scopes)
      -- Reuse the cached outline; disabled separators do no screen-position work.
      if method_separators then
        local previous_line
        for _, mark in ipairs(api.nvim_buf_get_extmarks(buffer, method_namespace,
            {view.topline - 1, 0}, {last_line - 1, -1}, {details=true})) do
          local line = mark[2] + 1
          if not mark[4].invalid and line ~= previous_line then
            previous_line = line
            local folded = vim.fn.foldclosed(line)
            if folded == -1 or folded == line then
              local position = vim.fn.screenpos(window, line, 1)
              if position.row > 0 then
                state.separators[#state.separators + 1] = {line=line, row=position.row - 1}
              end
            end
          end
        end
      end
    end)
  end
  if not current and vim.bo[buffer].buftype == '' and not pending[buffer] then
    schedule(buffer)
  end
  if not vim.deep_equal(published[window], state) then
    published[window] = state
    vim.rpcnotify(vim.g.nido_channel, 'nido:sticky_scroll', state)
  end
  return false
end

--- Turn the separator lines between functions on or off.
function M.set_method_separators(enabled)
  if method_separators == enabled then return end
  method_separators = enabled
  if enabled then
    for buffer, entry in pairs(entries) do
      if not entry.methods and api.nvim_buf_is_valid(buffer) then
        if entry.tick == api.nvim_buf_get_changedtick(buffer) then
          set_methods(buffer, entry, api.nvim_buf_call(buffer, function() return fallback_methods(entry.lines) end))
        else
          schedule(buffer)
        end
      end
    end
  end
  redraw()
end

--- Jump to a sticky header's line; returns whether the cursor moved.
function M.jump(window, buffer, line)
  if window ~= api.nvim_get_current_win() or buffer ~= api.nvim_get_current_buf()
      or vim.bo.buftype ~= '' or line < 1 or line > api.nvim_buf_line_count(buffer) then return false end
  require('nido_scroll').restore()
  api.nvim_win_set_cursor(window, {line, 0})
  vim.cmd.normal({args={'zv'}, bang=true})
  require('nido_scroll').center()
  return true
end

-- The state is published once a redraw has finished, as bracket guides are (nido_brackets):
-- during on_win the statuscolumn can still be growing, so the gutter width read then could be
-- a column short, and a scroll prefetch draws other views whose scopes and rows are not the
-- real view's. Either briefly drew the sticky headers and separators out of place.
local pending_publish
api.nvim_set_decoration_provider(api.nvim_create_namespace('nido_sticky'), {
  on_win = function(_, win, buffer)
    if not require('nido_scroll').prefetching and win == api.nvim_get_current_win() then
      pending_publish = {win, buffer}
    end
    return false
  end,
  on_end = function()
    local pending = pending_publish
    pending_publish = nil
    if not pending or not api.nvim_win_is_valid(pending[1]) or not api.nvim_buf_is_valid(pending[2]) then
      return
    end
    -- An interrupted highlight keeps the last complete sticky frame until the next redraw.
    local ok, result = pcall(M.publish, pending[1], pending[2])
    if not ok and not tostring(result):find('Keyboard interrupt', 1, true) then
      error(result)
    end
  end,
})
api.nvim_create_autocmd({'BufWinEnter', 'FileType', 'Syntax', 'TextChanged', 'TextChangedI', 'TextChangedP', 'LspAttach', 'LspDetach'}, {
  callback=function(event)
    if not event.event:match('^TextChanged') then
      if entries[event.buf] then entries[event.buf].highlights = {} end
      if edits[event.buf] then edits[event.buf].full = true end
    end
    schedule(event.buf)
  end,
})
api.nvim_create_autocmd('User', {pattern='NidoBracketsUpdated', callback=function(event)
  -- A long parse can finish after the initial indentation fallback was cached.
  if not pending[event.data.buffer] then schedule(event.data.buffer) end
end})
api.nvim_create_autocmd('LspRequest', {callback=function(event)
  local request = event.data.request
  -- Cached colors already include offscreen tokens. Painting those same tokens
  -- during scrolling emits LspTokenUpdate, but only a new response changes them.
  if request.type == 'complete' and request.method:match('^textDocument/semanticTokens/') then
    recolor(event.buf)
  end
end})
api.nvim_create_autocmd('ColorScheme', {callback=function()
  for buffer, entry in pairs(entries) do
    entry.highlights = {}
    if edits[buffer] then edits[buffer].full = true end
    schedule(buffer)
  end
end})
api.nvim_create_autocmd({'BufUnload', 'BufWipeout'}, {callback=function(event)
  cancel_outline(event.buf)
  cancel_pending(event.buf)
  entries[event.buf], pending[event.buf], color_pending[event.buf] = nil, nil, nil
end})
api.nvim_create_autocmd('VimLeavePre', {callback=function()
  for buffer in pairs(pending) do cancel_pending(buffer) end
end})
api.nvim_create_autocmd('WinClosed', {callback=function(event) published[tonumber(event.match)] = nil end})
api.nvim_create_autocmd('UIEnter', {callback=function()
  -- A newly attached renderer needs the current state even when the viewport is unchanged.
  published = {}
  redraw()
end})
schedule(api.nvim_get_current_buf())
return M
