local api = vim.api
local M = {}
local namespace = api.nvim_create_namespace('nido_scroll_anchor')
local anchor
local fraction = 0
local centered_view
local mouse_scrolloff

-- Buffer positions start below their virtual lines. topfill counts the extra
-- screen rows still visible above that position, including CodeLens annotations.
function M.view_distance(window, before, after)
  local rows = 0
  if before.topline ~= after.topline or before.skipcol ~= after.skipcol then
    local forward = after.topline > before.topline
      or (after.topline == before.topline and after.skipcol > before.skipcol)
    local first, last = before, after
    if not forward then first, last = after, before end
    rows = api.nvim_win_text_height(window, {
      start_row=first.topline - 1, end_row=last.topline - 1,
      start_vcol=first.skipcol, end_vcol=last.skipcol,
    }).all
    if not forward then rows = -rows end
  end
  return rows + before.topfill - after.topfill
end

local function view_at_start(view)
  return view.topline <= 1 and view.skipcol == 0
end

local function publish_offset(pixel)
  local at_start = view_at_start(vim.fn.winsaveview())
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:pixel_scroll', fraction, pixel == true, M.screen_cursor(), at_start)
  end
end

local function publish_cache(at_start, at_end, complete)
  local view_start = view_at_start(vim.fn.winsaveview())
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:scroll_cache', at_start, view_start, at_end, complete)
  end
end

function M.cursor()
  if not anchor or not api.nvim_buf_is_valid(anchor.buffer) then
    return nil
  end
  local pos = api.nvim_buf_get_extmark_by_id(anchor.buffer, namespace, anchor.mark, {})
  if #pos == 0 then
    return nil
  end
  return { pos[1] + 1, pos[2] }
end

function M.screen_cursor()
  local pos = M.cursor()
  if not pos or api.nvim_get_current_win() ~= anchor.window then
    return nil
  end
  local screen = vim.fn.screenpos(anchor.window, pos[1], pos[2] + 1)
  return { row = screen.row == 0 and -1 or screen.row - 1, column = screen.col - 1 }
end

function M.statuscolumn()
  local pos = M.cursor()
  if not pos or api.nvim_get_current_win() ~= anchor.window then
    return '%s%C%=%l '
  end
  -- Neovim moves its internal cursor to keep it visible; relative numbers use the edit anchor.
  if vim.v.virtnum ~= 0 then
    return '%s%C'
  end
  local current = vim.v.lnum == pos[1]
  local number = vim.v.lnum
  if vim.wo.relativenumber then
    number = current and (vim.wo.number and pos[1] or 0) or math.abs(vim.v.lnum - pos[1])
  end
  return '%s%C%=' .. (current and '%#CursorLineNr#' or '%#LineNr#') .. number .. '%* '
end

function M.restore(keep_view)
  -- A mouse click changes the editing anchor, not the visible pixel offset.
  if keep_view then
    if not mouse_scrolloff then
      mouse_scrolloff = {window=api.nvim_get_current_win(), value=vim.wo.scrolloff}
    end
    -- Keep a click near the viewport edge from applying the keyboard's cursor margin.
    vim.wo.scrolloff = 0
  elseif mouse_scrolloff then
    if api.nvim_win_is_valid(mouse_scrolloff.window) then
      vim.wo[mouse_scrolloff.window].scrolloff = mouse_scrolloff.value
    end
    mouse_scrolloff = nil
  end
  if not keep_view then
    fraction = 0
    centered_view = nil
  end
  local pos = M.cursor()
  local saved = anchor
  anchor = nil
  if saved and api.nvim_win_is_valid(saved.window) then
    vim.wo[saved.window].statuscolumn = saved.statuscolumn
  end
  if saved and api.nvim_buf_is_valid(saved.buffer) then
    api.nvim_buf_clear_namespace(saved.buffer, namespace, 0, -1)
    if not keep_view and pos and api.nvim_win_is_valid(saved.window) and api.nvim_win_get_buf(saved.window) == saved.buffer then
      api.nvim_win_call(saved.window, function()
        saved.view.lnum = pos[1]
        saved.view.col = pos[2]
        vim.fn.winrestview(saved.view)
      end)
    end
  end
  if saved then
    api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
  end
  publish_offset()
end

function M.center(count)
  M.restore()
  vim.cmd.normal({args={(count and count > 0 and tostring(count) or '') .. 'zz'}, bang=true})
  vim.cmd.redraw()
  local view = vim.fn.winsaveview()
  if vim.bo.buftype ~= 'terminal' and (view.topline > 1 or view.skipcol > 0) then
    -- The renderer hides one overscan row below the visible code viewport.
    fraction = math.max(0, math.min(0.5, vim.fn.winline() - api.nvim_win_get_height(0) / 2))
    centered_view = view
  end
  publish_offset()
end

local function reveal_row(row)
  -- Overscan plus fractional-height and compact-row rounding can hide three native rows.
  local bottom = math.max(1, api.nvim_win_get_height(0) - 3)
  if row > bottom then
    vim.cmd.normal({args={(row - bottom) .. string.char(5)}, bang=true})
  end
end

function M.page(key, count)
  M.restore()
  local keys = api.nvim_replace_termcodes(key, true, false, true)
  vim.cmd.normal({args={(count and count > 0 and tostring(count) or '') .. keys}, bang=true})
  vim.cmd.redraw()
  if vim.bo.buftype ~= '' or api.nvim_win_get_config(0).relative ~= '' then
    return
  end
  local window = api.nvim_get_current_win()
  local info = vim.fn.getwininfo(window)[1]
  local last = api.nvim_buf_line_count(0)
  local column = vim.wo.wrap and math.max(1, #vim.fn.getline(last)) or 1
  local bottom = vim.fn.screenpos(window, last, column).row
  reveal_row(bottom - info.winrow + 1)
end

function M.prefetch(down, previous)
  if vim.bo.buftype ~= '' or api.nvim_win_get_config(0).relative ~= '' then
    return
  end
  local mode = api.nvim_get_mode()
  -- A :normal command would consume an unfinished count, mapping or command-line input.
  if (mode.mode ~= 'n' and mode.mode ~= 'i') or mode.blocking then
    return
  end
  local view = vim.fn.winsaveview()
  local buffer, window = api.nvim_get_current_buf(), api.nvim_get_current_win()
  local height, width = api.nvim_win_get_height(0), api.nvim_win_get_width(0)
  local tick = api.nvim_buf_get_changedtick(buffer)
  if previous and (previous.buffer ~= buffer or previous.window ~= window
      or previous.tick ~= tick or previous.height ~= height or previous.width ~= width) then
    return
  end
  local cached = previous and math.max(0, previous.depth
    - M.view_distance(0, previous.view, view) * (down and 1 or -1)) or 0
  if cached >= 256 then
    return
  end
  local scrolloff = vim.wo.scrolloff
  local step = math.max(1, height - 1)
  -- Visit only the next strip, then restore the real view before yielding to input.
  local views = {}
  local remaining = math.min(32, 256 - cached)
  local depth = cached
  local at_edge = false
  local ok, err = pcall(function()
    if cached > 0 then
      vim.cmd.normal({args={cached .. string.char(down and 5 or 25)}, bang=true})
    end
    while remaining > 0 do
      local before = vim.fn.winsaveview()
      if not down and view_at_start(before) then
        at_edge = true
        break
      end
      views[#views + 1] = before
      local count = math.min(step, remaining)
      vim.cmd.normal({args={count .. string.char(down and 5 or 25)}, bang=true})
      remaining = remaining - count
      local after = vim.fn.winsaveview()
      depth = math.abs(M.view_distance(0, view, after))
      if (not down and view_at_start(after)) or
        (after.topline == before.topline and after.skipcol == before.skipcol
          and after.topfill == before.topfill) then
        at_edge = true
        break
      end
    end
    -- Only the return traversal supplies cached rows; paint the furthest view once.
    vim.cmd.redraw()
  end)
  -- Restoring a mouse-scrolled wrapped view must not reapply the keyboard cursor margin.
  vim.wo.scrolloff = 0
  for index = #views, 1, -1 do
    vim.fn.winrestview(views[index])
    vim.cmd.redraw()
  end
  vim.fn.winrestview(view)
  vim.cmd.redraw()
  vim.wo.scrolloff = scrolloff
  if not ok then
    error(err)
  end
  local complete = at_edge or depth >= 256
  local upper_edge, lower_edge
  if down then lower_edge = at_edge else upper_edge = at_edge end
  publish_cache(upper_edge, lower_edge, complete)
  if not complete then
    return {buffer=buffer, window=window, tick=tick, height=height, width=width,
      view=view, depth=depth}
  end
end

local function scroll_horizontal(columns)
  local view = vim.fn.winsaveview()
  local window = api.nvim_get_current_win()
  local width = math.max(1, api.nvim_win_get_width(window) - vim.fn.getwininfo(window)[1].textoff)
  local longest, longest_line = 0, view.lnum
  local line, last = vim.fn.line('w0'), vim.fn.line('w$')
  while line <= last do
    local length = vim.fn.strdisplaywidth(vim.fn.getline(line))
    if length > longest then longest, longest_line = length, line end
    local folded = vim.fn.foldclosedend(line)
    line = folded >= 0 and folded + 1 or line + 1
  end
  local left = math.max(0, math.min(view.leftcol + columns, longest - width))
  if left == view.leftcol then return false end
  -- A short cursor line must not prevent panning to longer visible lines.
  if vim.fn.virtcol({view.lnum, '$'}) - 1 <= left then view.lnum = longest_line end
  local column = math.max(left + 1, math.min(left + width, vim.fn.virtcol('.')))
  view.col = math.max(0, vim.fn.virtcol2col(window, view.lnum, column) - 1)
  local character = vim.fn.virtcol({view.lnum, view.col + 1}, true)
  if character[1] - 1 < left then
    view.col = math.max(0, vim.fn.virtcol2col(window, view.lnum, character[2] + 1) - 1)
  end
  view.leftcol, view.curswant = left, column - 1
  if not mouse_scrolloff then
    mouse_scrolloff = {window=window, value=vim.wo.scrolloff}
  end
  vim.wo.scrolloff = 0
  vim.fn.winrestview(view)
  return true
end

function M.scroll(lines, follow, pixel, columns)
  columns = vim.wo.wrap and 0 or (columns or 0)
  if lines == 0 and columns == 0 then
    publish_offset(pixel)
    return false
  end
  centered_view = nil
  local previous_anchor = anchor
  if follow then
    if anchor then
      M.restore()
    end
  elseif not anchor and vim.bo.buftype == '' then
    local pos = api.nvim_win_get_cursor(0)
    anchor = {
      buffer = api.nvim_get_current_buf(), window = api.nvim_get_current_win(),
      view = vim.fn.winsaveview(),
      statuscolumn = vim.wo.statuscolumn,
      mark = api.nvim_buf_set_extmark(0, namespace, pos[1] - 1, pos[2], {right_gravity=false}),
    }
    vim.wo.statuscolumn = "%!v:lua.require'nido_scroll'.statuscolumn()"
  end
  if pixel then
    local total = fraction + lines
    lines = math.floor(total)
    fraction = total - lines
  else
    fraction = 0
  end
  local before = vim.fn.winsaveview()
  if lines ~= 0 then
    vim.cmd.normal({args={math.abs(lines) .. string.char(lines > 0 and 5 or 25)}, bang=true})
    local after = vim.fn.winsaveview()
    local moved = math.abs(M.view_distance(0, before, after))
    if moved < math.abs(lines) then
      fraction = 0
    end
  end
  if vim.fn.line('w0') >= api.nvim_buf_line_count(0) then
    fraction = 0
  end
  -- Fractional movement only changes the renderer offset, not the editor state.
  local horizontal = columns ~= 0 and scroll_horizontal(columns)
  local changed = lines ~= 0 or horizontal or anchor ~= previous_anchor
  if changed then
    api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
    vim.cmd.redraw()
  end
  -- Sub-line motion changes only the GUI offset; no native grid repaint is needed.
  publish_offset(pixel)
  return changed
end

api.nvim_create_autocmd('BufLeave', {callback=function() M.restore() end})
api.nvim_create_autocmd({'CursorMoved', 'CursorMovedI', 'WinScrolled', 'WinResized'}, {callback=function()
  if anchor or mouse_scrolloff or vim.bo.buftype ~= '' or api.nvim_win_get_config(0).relative ~= '' then
    return
  end
  local mode = api.nvim_get_mode()
  if mode.blocking or mode.mode:match('^[cr]') then
    return
  end
  reveal_row(vim.fn.winline())
end})
api.nvim_create_autocmd('WinScrolled', {callback=function()
  if not centered_view then
    return
  end
  local view = vim.fn.winsaveview()
  if view.topline ~= centered_view.topline or view.skipcol ~= centered_view.skipcol
      or view.topfill ~= centered_view.topfill then
    fraction = 0
    centered_view = nil
    publish_offset()
  end
end})
return M
