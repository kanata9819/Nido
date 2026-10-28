local api = vim.api
local namespace = api.nvim_create_namespace('nido_brackets')
local colors = { '#FFD700', '#DA70D6', '#179FFF' }
local closing = { [')'] = '(', [']'] = '[', ['}'] = '{' }
local pending = {}
local function cancel_pending(buffer)
  local ticket = pending[buffer]
  pending[buffer] = nil
  if ticket and ticket.timer and not ticket.timer:is_closing() then
    ticket.timer:stop()
    ticket.timer:close()
  end
end
local pairs_by_buffer = {}
local match_indices = {}
local scope_indices = {}
local index = require('nido_bracket_index')
local parsed_ticks = {}
local marks_by_buffer = {}
local published_guides
local guide_context
local matched
local match_namespace = api.nvim_create_namespace('nido_bracket_match')

local function invalidate_position(buffer, position)
  position.invalid = true
  if match_indices[buffer] then match_indices[buffer].invalidate(position) end
  if scope_indices[buffer] then scope_indices[buffer].invalidate(position) end
  if matched and matched.buffer == buffer
      and (matched.pair.first.invalid or matched.pair.last.invalid) then
    api.nvim_buf_clear_namespace(buffer, match_namespace, 0, -1)
    matched = nil
  end
end

local function match_brackets()
  local buffer = api.nvim_get_current_buf()
  local cursor = require('nido_scroll').cursor() or api.nvim_win_get_cursor(0)
  local active
  if vim.fn.mode():match('^[niR]') and vim.bo.buftype == '' then
    active = match_indices[buffer] and match_indices[buffer].innermost(cursor[1] - 1, cursor[2])
  end
  local next_match = active and {buffer=buffer, pair=active} or nil
  if vim.deep_equal(matched, next_match) then return end
  if matched and api.nvim_buf_is_valid(matched.buffer) then
    api.nvim_buf_clear_namespace(matched.buffer, match_namespace, 0, -1)
  end
  matched = next_match
  if active then
    for _, position in ipairs({active.first, active.last}) do
      api.nvim_buf_set_extmark(buffer, match_namespace, position.row, position.column, {
        end_col=position.column + 1, hl_group='NidoBracketMatch', priority=160,
      })
    end
  end
end

local function ignored(row, column)
  for _, id in ipairs(vim.fn.synstack(row, column)) do
    local name = vim.fn.synIDattr(id, 'name'):lower()
    if name:find('comment') or name:find('string') or name:find('character') then
      return true
    end
  end
  return false
end

for right, left in pairs(closing) do
  vim.keymap.set('i', left, function()
    local column = vim.fn.col('.') - 1
    local next = api.nvim_get_current_line():sub(column + 1, column + 1)
    if vim.bo.buftype == '' and not ignored(vim.fn.line('.'), math.max(1, column))
        and (next == '' or next:match('[%s%)%]%}]')) then
      return left .. right .. '<Left>'
    end
    return left
  end, {expr=true})
  vim.keymap.set('i', right, function()
    local column = vim.fn.col('.')
    if vim.bo.buftype == '' and api.nvim_get_current_line():sub(column, column) == right then
      return '<Right>'
    end
    return right
  end, {expr=true})
end
vim.keymap.set('i', '<BS>', function()
  local column = vim.fn.col('.') - 1
  local line = api.nvim_get_current_line()
  if vim.bo.buftype == '' and closing[line:sub(column + 1, column + 1)] == line:sub(column, column) then
    return '<Del><BS>'
  end
  return '<BS>'
end, {expr=true})

vim.keymap.set('i', '<CR>', function()
  local line = api.nvim_get_current_line()
  local column = vim.fn.col('.') - 1
  local before, after = line:sub(1, column), line:sub(column + 1)
  if vim.bo.buftype ~= '' or not before:match('{%s*$') or not after:match('^%s*}')
      or ignored(vim.fn.line('.'), column - #(before:match('%s*$'))) then
    return '<CR>'
  end
  local outer = line:match('^%s*')
  local width = vim.fn.indent('.') + vim.fn.shiftwidth()
  local inner = vim.bo.expandtab and string.rep(' ', width)
      or string.rep('\t', math.floor(width / vim.bo.tabstop)) .. string.rep(' ', width % vim.bo.tabstop)
  local row = vim.fn.line('.') - 1
  local cancel = vim.fn.pumvisible() == 1 and '<C-e>' or ''
  return cancel .. string.format(
    '<Cmd>lua vim.api.nvim_buf_set_text(0, %d, %d, %d, %d, {"", %q, %q}); vim.api.nvim_win_set_cursor(0, {%d, %d})<CR>',
    row, column - #(before:match('%s*$')), row, column + #(after:match('^%s*')),
    inner, outer, row + 2, #inner)
end, {expr=true})

local function set_colors()
  for level, color in ipairs(colors) do
    api.nvim_set_hl(0, 'NidoBracket' .. level, { fg = color })
  end
  -- The GUI renders this underline attribute as a border without replacing bracket colors.
  api.nvim_set_hl(0, 'NidoBracketMatch', {underline=true, sp='#ffffff'})
  api.nvim_set_hl(0, 'MatchParen', {})
end

local function update(buffer, ticket)
  if not api.nvim_buf_is_valid(buffer) or not api.nvim_buf_is_loaded(buffer) then
    pending[buffer] = nil
    return
  end
  local tick = api.nvim_buf_get_changedtick(buffer)
  if parsed_ticks[buffer] == tick then
    pending[buffer] = nil
    match_brackets()
    return
  end
  if vim.bo[buffer].buftype ~= ''
      or api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then
    pairs_by_buffer[buffer] = {}
    match_indices[buffer], scope_indices[buffer] = nil, nil
    api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    match_brackets()
    -- Keep an existing attachment so returning to ordinary text cannot register it twice.
    marks_by_buffer[buffer] = marks_by_buffer[buffer] and {}
    parsed_ticks[buffer], pending[buffer] = tick, nil
    return
  end
  if not marks_by_buffer[buffer] then
    api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    marks_by_buffer[buffer] = {}
    api.nvim_buf_attach(buffer, false, {
      on_lines = function(_, buf, _, first, last, new_last)
        local marks = marks_by_buffer[buf]
        if not marks then return true end
        local changed = {}
        for row=first,last-1 do
          changed[row] = marks[row]
          marks[row] = nil
        end
        if new_last ~= last then
          local shifted = {}
          for row, items in pairs(marks) do
            local target = row >= last and row + new_last - last or row
            shifted[target] = items
            for _, mark in pairs(items) do mark.position.row = target end
          end
          marks = shifted
        end
        local lines = next(changed) and api.nvim_buf_get_lines(buf, first, new_last, false) or {}
        local invalid = {}
        -- Preserve moved brackets until reparsing; deleted ranges must not color their new neighbors.
        for _, items in pairs(changed) do
          for _, mark in pairs(items) do
            local pos = api.nvim_buf_get_extmark_by_id(buf, namespace, mark.id, {details=true})
            local line = pos[1] and lines[pos[1] - first + 1]
            if line and pos[3].end_row == pos[1] and pos[3].end_col == pos[2] + 1
                and line:sub(pos[2] + 1, pos[2] + 1) == mark.text then
              mark.position.row, mark.position.column = pos[1], pos[2]
              marks[pos[1]] = marks[pos[1]] or {}
              marks[pos[1]][pos[2]] = mark
            else
              invalid[#invalid + 1] = mark.position
              api.nvim_buf_del_extmark(buf, namespace, mark.id)
            end
          end
        end
        -- Recompute bounds only after all surviving endpoints have their native coordinates.
        for _, position in ipairs(invalid) do invalidate_position(buf, position) end
        marks_by_buffer[buf] = marks
      end,
      on_detach = function(_, buf)
        marks_by_buffer[buf], parsed_ticks[buf] = nil, nil
        pairs_by_buffer[buf] = nil
        match_indices[buf], scope_indices[buf] = nil, nil
      end,
    })
  end
  local marks = marks_by_buffer[buffer]
  local version = {}
  local function highlight(position, group, text)
    local row = marks[position.row]
    if not row then row = {}; marks[position.row] = row end
    local mark = row[position.column]
    if not mark or mark.group ~= group then
      local id = api.nvim_buf_set_extmark(buffer, namespace, position.row, position.column, {
        id=mark and mark.id or nil,
        end_col=position.column + 1, hl_group=group, priority=150,
      })
      mark = {id=id, group=group, position=mark and mark.position or position}
      row[position.column] = mark
    end
    mark.text = text
    mark.position.bracket = text
    mark.version = version
    return mark.position
  end
  -- Keep full syntax correctness while giving input a turn between bounded chunks.
  local task = coroutine.create(function()
    local work, started = 0, vim.uv.hrtime()
    local function yield_if_busy()
      work = work + 1
      if work % 256 == 0 and vim.uv.hrtime() - started >= 4000000 then
        coroutine.yield()
        started = vim.uv.hrtime()
      end
    end
    local matches, scopes = {}, {}
    local stack = {}
    for row, line in ipairs(api.nvim_buf_get_lines(buffer, 0, -1, false)) do
      for column, bracket in line:gmatch('()([%(%)%[%]{}])') do
        if not ignored(row, column) then
          if not closing[bracket] then
            stack[#stack + 1] = { row = row - 1, column = column - 1, bracket = bracket }
          elseif #stack > 0 and stack[#stack].bracket == closing[bracket] then
            local group = 'NidoBracket' .. ((#stack - 1) % #colors + 1)
            local opening = table.remove(stack)
            opening = highlight(opening, group, opening.bracket)
            local ending = highlight({row=row - 1, column=column - 1}, group, bracket)
            table.insert(matches, {
              first=opening, last=ending,
            })
            if opening.row < row - 1 then
              table.insert(scopes, {
                first=opening, last=ending,
                color=colors[(#stack % #colors) + 1],
              })
            end
          end
        end
        yield_if_busy()
      end
      yield_if_busy()
    end
    for row, items in pairs(marks) do
      for column, mark in pairs(items) do
        if mark.version ~= version then
          invalidate_position(buffer, mark.position)
          api.nvim_buf_del_extmark(buffer, namespace, mark.id)
          items[column] = nil
        end
        yield_if_busy()
      end
      if next(items) == nil then marks[row] = nil end
    end
    -- Build within the same yielding task; incomplete or obsolete indices stay private.
    local matches_index = index.new(matches, yield_if_busy)
    local scopes_index = index.new(scopes, yield_if_busy)
    match_indices[buffer], scope_indices[buffer] = matches_index, scopes_index
    pairs_by_buffer[buffer], parsed_ticks[buffer] = scopes, tick
  end)
  local function resume()
    if pending[buffer] ~= ticket then return end
    if not api.nvim_buf_is_valid(buffer) or not api.nvim_buf_is_loaded(buffer)
        or api.nvim_buf_get_changedtick(buffer) ~= tick then
      pending[buffer] = nil
      return
    end
    local ok, err
    api.nvim_buf_call(buffer, function() ok, err = coroutine.resume(task) end)
    if not ok then
      if tostring(err):find('Keyboard interrupt', 1, true) then
        -- A cancelled coroutine is dead; restart only if no newer edit superseded it.
        ticket.timer = vim.defer_fn(function()
          if pending[buffer] == ticket then update(buffer, ticket) end
        end, 80)
      else
        pending[buffer] = nil
        vim.notify('Bracket analysis failed: ' .. tostring(err), vim.log.levels.ERROR)
      end
    elseif coroutine.status(task) == 'dead' then
      pending[buffer] = nil
      match_brackets()
      api.nvim_exec_autocmds('User', {pattern='NidoBracketsUpdated', data={buffer=buffer}})
    else
      ticket.timer = vim.defer_fn(resume, 1)
    end
  end
  resume()
end

-- Screen positions include folds, wrapping, tabs, wide characters and virtual CodeLens rows.
local function publish_guides(window, buffer, first, last, immediate)
    if not vim.g.nido_channel or window ~= api.nvim_get_current_win() then
      return false
    end
    local guides = {}
    local unchanged = false
    if vim.bo[buffer].buftype == '' and api.nvim_win_get_config(window).relative == '' then
      api.nvim_win_call(window, function()
        local info = vim.fn.getwininfo(window)[1]
        local view = vim.fn.winsaveview()
        local cursor = require('nido_scroll').cursor() or api.nvim_win_get_cursor(window)
        local scopes = scope_indices[buffer]
        local active = scopes and scopes.innermost(cursor[1] - 1, cursor[2])
        local key = table.concat({window, buffer, api.nvim_buf_get_changedtick(buffer), first, last,
          info.winrow, info.wincol, info.width, info.height, info.textoff,
          view.topline, view.topfill, view.leftcol, view.skipcol}, ':')
        -- Only cursor-only updates reuse geometry; every native redraw refreshes it.
        if immediate and guide_context and guide_context.key == key
            and guide_context.scopes == scopes and guide_context.active == active then
          unchanged = true
          return
        end
        guide_context = {key=key, scopes=scopes, active=active}
        for _, pair in ipairs(scopes and scopes.overlapping(first, last) or {}) do
          local a, b = pair.first, pair.last
          -- Offscreen pairs cannot draw a guide; avoid querying Neovim for every pair in the file.
          if a.row < last and b.row >= first
              and not (vim.fn.foldclosed(a.row + 1) >= 0
                and vim.fn.foldclosedend(a.row + 1) >= b.row + 1) then
            local column = math.min(vim.fn.indent(a.row + 1), vim.fn.indent(b.row + 1)) - view.leftcol
            if column >= 0 and column < info.width - info.textoff then
              local opening = vim.fn.screenpos(window, a.row + 1, a.column + 1)
              local ending = vim.fn.screenpos(window, b.row + 1, b.column + 1)
              -- A completely folded pair has no screen endpoints and needs no guide.
              if opening.row > 0 or ending.row > 0 or a.row < first or b.row >= last then
                table.insert(guides, {
                  column=info.wincol - 1 + info.textoff + column,
                  top=opening.row > 0 and opening.row - 1 or info.winrow - 2,
                  bottom=ending.row > 0 and ending.row - 1 or info.winrow - 1 + info.height,
                  opening=opening.col > 0 and opening.col - 1 or -1,
                  closing=ending.col > 0 and ending.col - 1 or -1,
                  color=pair.color, active=pair == active,
                })
              end
            end
          end
        end
      end)
    else
      guide_context = nil
    end
    if unchanged then return false end
    -- Cursor movement inside the same scope leaves every guide unchanged.
    -- Full redraws still publish the snapshot for UI reattachment and scroll batches.
    if immediate and published_guides and vim.deep_equal(published_guides, guides) then
      return false
    end
    published_guides = guides
    vim.rpcnotify(vim.g.nido_channel, 'nido:bracket_guides', guides, immediate == true)
    return false
end
api.nvim_set_decoration_provider(api.nvim_create_namespace('nido_bracket_guides'), {
  on_win = function(_, window, buffer, first, last)
    return publish_guides(window, buffer, first, last, false)
  end,
})
-- Cursor-only redraws do not call on_win; update the active scope without repainting Neovim's text.
api.nvim_create_autocmd({'CursorMoved', 'CursorMovedI'}, {callback=function(event)
  match_brackets()
  publish_guides(api.nvim_get_current_win(), event.buf, vim.fn.line('w0') - 1, vim.fn.line('w$'), true)
end})
api.nvim_create_autocmd('ModeChanged', {callback=match_brackets})
api.nvim_create_autocmd({'BufUnload', 'BufWipeout'}, {callback=function(event)
  pairs_by_buffer[event.buf] = nil
  match_indices[event.buf], scope_indices[event.buf] = nil, nil
  parsed_ticks[event.buf] = nil
  marks_by_buffer[event.buf] = nil
  cancel_pending(event.buf)
end})
api.nvim_create_autocmd('VimLeavePre', {callback=function()
  for buffer in pairs(pending) do cancel_pending(buffer) end
end})

set_colors()
api.nvim_create_autocmd('ColorScheme', { callback = set_colors })
api.nvim_create_autocmd({ 'BufWinEnter', 'FileType', 'Syntax', 'TextChanged', 'TextChangedI', 'TextChangedP' }, {
  callback = function(event)
    local buffer = event.buf
    -- Syntax can change bracket interpretation without changing the text.
    if event.event == 'FileType' or event.event == 'Syntax' then
      parsed_ticks[buffer] = nil
    end
    cancel_pending(buffer)
    local ticket = {}
    pending[buffer] = ticket
    ticket.timer = vim.defer_fn(function()
      if pending[buffer] ~= ticket then return end
      update(buffer, ticket)
    end, 80)
  end,
})

return {
  pairs = function(buffer)
    local valid = {}
    for _, pair in ipairs(pairs_by_buffer[buffer] or {}) do
      if not pair.first.invalid and not pair.last.invalid then valid[#valid + 1] = pair end
    end
    return valid
  end,
  -- Readiness includes deferred syntax updates, even when the text is unchanged.
  ready = function(buffer)
    return api.nvim_buf_is_valid(buffer) and not pending[buffer]
      and parsed_ticks[buffer] == api.nvim_buf_get_changedtick(buffer)
  end,
}
