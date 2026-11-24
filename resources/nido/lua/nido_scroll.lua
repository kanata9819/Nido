-- Scrolling for Nido's smooth, detached wheel scrolling (see src/main/sessionInteraction.ts).
-- Wheel scrolling moves the view without moving the editing position: an extmark (the
-- "anchor") remembers where the cursor was, and restore() returns to it before the next
-- key. The fractional part of a pixel scroll is kept in `fraction` and published to the
-- renderer, which draws the grid that far between rows.
local api = vim.api
local M = {}
local namespace = api.nvim_create_namespace('nido_scroll_anchor')
-- The editing position while the view is scrolled away: buffer, window and extmark.
local anchor
local fraction = 0
-- The view zz produced; the fraction it set applies only while the view stays there.
local centered_view
-- The window's 'scrolloff', saved while it is set to 0 for detached scrolling.
local mouse_scrolloff
-- The horizontal position the user panned to, kept across vertical scrolling.
local pan
-- Where sideways scrolling last placed the cursor, and the column it had before being pushed.
local pushed

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

--- Whether the view shows the start of the buffer.
local function view_at_start(view)
  return view.topline <= 1 and view.skipcol == 0
end

--- Send the fractional offset, the anchored cursor's screen position and leftcol to the UI.
local function publish_offset(pixel)
  local view = vim.fn.winsaveview()
  local at_start = view_at_start(view)
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:pixel_scroll', fraction, pixel == true, M.screen_cursor(), at_start, view.leftcol)
  end
end

--- Tell the UI whether a prefetch reached the start or end of the buffer.
local function publish_cache(at_start, at_end, complete)
  local view_start = view_at_start(vim.fn.winsaveview())
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:scroll_cache', at_start, view_start, at_end, complete)
  end
end

--- The anchored editing position {line, column}, or nil when the view is not detached.
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

--- Where the anchored cursor is on the screen, for drawing it while scrolled away.
function M.screen_cursor()
  local pos = M.cursor()
  if not pos or api.nvim_get_current_win() ~= anchor.window then
    return nil
  end
  local screen = vim.fn.screenpos(anchor.window, pos[1], pos[2] + 1)
  return { row = screen.row == 0 and -1 or screen.row - 1, column = screen.col - 1 }
end

--- The 'statuscolumn' of editor windows: signs, folds, then the line number, right-aligned.
--- With 'number' and 'relativenumber', Vim's own column (and %l) left-aligns the cursor
--- line's number, which then jumped to the right as soon as detached scrolling drew it.
M.number_column = "%s%C%=%{v:virtnum ? '' : (&rnu && (v:relnum || !&nu) ? v:relnum : v:lnum)} "

--- The 'statuscolumn' editor windows keep: M.number_column, or while detached, line numbers
--- relative to the anchored cursor. It is never swapped: setting 'statuscolumn' makes Neovim
--- re-estimate the column's width, and until it grows back the window's text offset is a column
--- short, which drew bracket guides a column to the left on the first scroll after a move.
M.column = "%!v:lua.require'nido_scroll'.statuscolumn()"

--- Redraw a window's line numbers after the anchor changed.
local function redraw_numbers(window)
  if api.nvim_win_is_valid(window) then
    pcall(api.nvim__redraw, {win=window, statuscolumn=true})
  end
end

-- The cursor a prefetch started from: the window and its position. Prefetching scrolls the
-- real view, which drags Neovim's cursor along; cached rows must still number from here.
local prefetch_cursor

function M.statuscolumn()
  local pos = M.cursor()
  local owner = pos and anchor.window
  if not pos and prefetch_cursor then
    pos, owner = prefetch_cursor.pos, prefetch_cursor.window
  end
  local window = vim.g.statusline_winid or api.nvim_get_current_win()
  if not pos or window ~= owner then
    return M.number_column
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

--- Return to the anchored editing position. With `keep_view` (a mouse click) the view stays
--- where it is and only the anchor is dropped.
function M.restore(keep_view, sticky)
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
    pan = nil
  end
  local pos = M.cursor()
  local saved = anchor
  anchor = nil
  if saved and saved.returned and api.nvim_win_is_valid(saved.window) then
    -- A view brought back by a tab switch keeps its cursor only until something moves it:
    -- a jump made on returning, such as opening a search result, must not be undone.
    local cursor = api.nvim_win_get_cursor(saved.window)
    if cursor[1] ~= saved.returned[1] or cursor[2] ~= saved.returned[2] then
      pos = nil
    end
  end
  if saved then
    redraw_numbers(saved.window)
  end
  if saved and api.nvim_buf_is_valid(saved.buffer) then
    api.nvim_buf_clear_namespace(saved.buffer, namespace, 0, -1)
    if not keep_view and pos and api.nvim_win_is_valid(saved.window) and api.nvim_win_get_buf(saved.window) == saved.buffer then
      api.nvim_win_call(saved.window, function()
        local view = vim.fn.winsaveview()
        local edge = pos[1] < view.topline and 'zt' or pos[1] > vim.fn.line('w$') and 'zb'
        view.lnum, view.col = pos[1], pos[2]
        view.leftcol, view.curswant = saved.view.leftcol, saved.view.curswant
        vim.fn.winrestview(view)
        -- Reveal an off-screen edit position at the nearest edge with the normal scrolloff.
        if edge then
          vim.cmd.normal({args={edge}, bang=true})
        end
        if sticky and sticky.rows > vim.wo.scrolloff and sticky.window == saved.window and sticky.buffer == saved.buffer then
          -- The header occupies part of the existing scrolloff, so reveal only any overlap.
          local first_visible = math.min(sticky.rows + 1, math.max(1, api.nvim_win_get_height(0) - 3))
          local hidden_rows = first_visible - vim.fn.winline()
          if hidden_rows > 0 then
            vim.cmd.normal({args={hidden_rows .. string.char(25)}, bang=true})
          end
        end
      end)
    end
  end
  if saved then
    api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
  end
  publish_offset()
end

--- zz: center the cursor line, keeping the half-row offset that exact centering needs.
local frame_depth = 0

local function notify_frame(hold)
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:frame', hold)
  end
end

--- Run `fn` so the renderer gets everything it redraws as one frame: the grid, the cursor and
--- the fractional offset. A jump then appears at once instead of in steps.
function M.frame(fn, ...)
  if frame_depth == 0 then notify_frame(true) end
  frame_depth = frame_depth + 1
  local result = {pcall(fn, ...)}
  frame_depth = frame_depth - 1
  if frame_depth == 0 then
    -- Draw the cursor at its destination in the same frame.
    pcall(api.nvim__redraw, {cursor=true, flush=true})
    notify_frame(false)
  end
  if not result[1] then error(result[2], 0) end
  return unpack(result, 2)
end

function M.center(count)
  M.frame(function()
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
  end)
end

-- The cursors and 'splitkeep' saved while the UI grid is resized.
local resizing

--- Before the UI grid resizes (the terminal panel opening or closing, a window resize): keep
--- every window's first line where it is. Neovim otherwise scrolls each window to hold its
--- cursor at the same height, which moves all of the code on screen.
function M.before_resize()
  -- A resize that failed before after_resize ran leaves its state behind.
  if resizing then M.after_resize() end
  local cursors = {}
  for _, window in ipairs(api.nvim_list_wins()) do
    if api.nvim_win_get_config(window).relative == '' then
      cursors[window] = api.nvim_win_get_cursor(window)
    end
  end
  resizing = {splitkeep=vim.o.splitkeep, cursors=cursors}
  -- Show the resized grid and any scroll below as one frame.
  if frame_depth == 0 then notify_frame(true) end
  frame_depth = frame_depth + 1
  vim.o.splitkeep = 'topline'
end

--- After the resize: 'topline' moves a cursor that no longer fits into the window. Put it
--- back, scrolling only as far as it needs to be seen. Resizes also come while scrolling, as
--- CodeLens rows change how many grid rows fill the editor.
function M.after_resize()
  local saved = resizing
  if not saved then return end
  resizing = nil
  local ok, failure = pcall(function()
    vim.o.splitkeep = saved.splitkeep
    for window, cursor in pairs(saved.cursors) do
      -- A wheel-scrolled view keeps its editing position in the anchor, and must not move.
      if api.nvim_win_is_valid(window) and not (anchor and anchor.window == window) then
        local now = api.nvim_win_get_cursor(window)
        if now[1] ~= cursor[1] or now[2] ~= cursor[2] then
          pcall(api.nvim_win_set_cursor, window, cursor)
        end
      end
    end
  end)
  frame_depth = frame_depth - 1
  if frame_depth == 0 then
    pcall(api.nvim__redraw, {cursor=true, flush=true})
    notify_frame(false)
  end
  if not ok then error(failure, 0) end
end

--- Scroll so screen row `row` is not hidden under the renderer's overscan rows.
local function reveal_row(row)
  -- Overscan plus fractional-height and compact-row rounding can hide three native rows.
  local bottom = math.max(1, api.nvim_win_get_height(0) - 3)
  if row > bottom then
    vim.cmd.normal({args={(row - bottom) .. string.char(5)}, bang=true})
  end
end

--- Page keys (Ctrl+F and the like), making sure the last line can be scrolled fully into view.
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

--- The width of the window's text area, without the gutter.
local function text_width(window)
  return math.max(1, api.nvim_win_get_width(window) - vim.fn.getwininfo(window)[1].textoff)
end

-- Visible buffer lines and their display widths, skipping text inside closed folds.
local function visible_lines()
  local lines, longest = {}, 0
  local line, last = vim.fn.line('w0'), vim.fn.line('w$')
  while line <= last do
    local length = vim.fn.strdisplaywidth(vim.fn.getline(line))
    local folded = vim.fn.foldclosedend(line)
    lines[#lines + 1] = {line=line, width=length, folded=folded >= 0}
    if length > longest then longest = length end
    line = folded >= 0 and folded + 1 or line + 1
  end
  return lines, longest
end

-- Show the view from `left` with the cursor on `lnum`, as close to `virtcol` as fits.
local function place(window, view, left, lnum, virtcol, curswant)
  local width = text_width(window)
  local column = math.max(left + 1, math.min(left + width, virtcol))
  view.lnum = lnum
  view.col = math.max(0, vim.fn.virtcol2col(window, lnum, column) - 1)
  local character = vim.fn.virtcol({lnum, view.col + 1}, true)
  if character[1] - 1 < left then
    view.col = math.max(0, vim.fn.virtcol2col(window, lnum, character[2] + 1) - 1)
  end
  view.leftcol, view.curswant = left, curswant or column - 1
  if not mouse_scrolloff then
    mouse_scrolloff = {window=window, value=vim.wo.scrolloff}
  end
  vim.wo.scrolloff = 0
  vim.fn.winrestview(view)
end

-- The column the user panned to, which short visible lines may have clamped.
local function wanted_leftcol(view)
  if pan and pan.window == api.nvim_get_current_win()
      and pan.buffer == api.nvim_get_current_buf() and pan.left == view.leftcol then
    return pan.wanted
  end
  return view.leftcol
end

--- Remember the column the user panned to.
local function remember_leftcol(wanted)
  pan = {window=api.nvim_get_current_win(), buffer=api.nvim_get_current_buf(),
    wanted=wanted, left=vim.fn.winsaveview().leftcol}
end

-- Vertical scrolling moves the internal cursor; on a short line Neovim would
-- scroll the view back to the left edge to show it. Keep the panned column
-- by moving the cursor to the nearest visible line that reaches it instead.
local function keep_leftcol(wanted)
  local view = vim.fn.winsaveview()
  if view.leftcol == wanted then
    return
  end
  local window = api.nvim_get_current_win()
  local lines, longest = visible_lines()
  local left = wanted
  if longest <= wanted then
    -- Nothing visible reaches the column; show the ends of the visible lines until it does.
    left = math.max(0, longest - text_width(window))
  end
  if left == view.leftcol then
    return
  end
  local target, distance
  for _, entry in ipairs(lines) do
    if entry.width > left and not entry.folded then
      local gap = math.abs(entry.line - view.lnum)
      if not distance or gap < distance then
        target, distance = entry.line, gap
      end
    end
  end
  if target then
    place(window, view, left, target, math.min(view.curswant, 2147483646) + 1, view.curswant)
  end
end

--- Pan sideways by `columns`, up to the end of the longest visible line.
local function scroll_horizontal(columns)
  local view = vim.fn.winsaveview()
  local window = api.nvim_get_current_win()
  local width = text_width(window)
  local left = math.max(0, view.leftcol + columns)
  if left == view.leftcol then return false end
  -- A cursor line wide enough to fill the requested view already proves it is reachable.
  if vim.fn.foldclosed(view.lnum) >= 0 or vim.fn.strdisplaywidth(api.nvim_get_current_line()) < left + width then
    local longest, longest_line = 0, view.lnum
    for _, entry in ipairs((visible_lines())) do
      if entry.width > longest then longest, longest_line = entry.width, entry.line end
    end
    left = math.max(0, math.min(left, longest - width))
    if vim.fn.virtcol({view.lnum, '$'}) - 1 <= left then view.lnum = longest_line end
  end
  if left == view.leftcol then return false end
  -- The renderer scrolls ahead of a gesture and settles back. Keep the column a pushed cursor
  -- started from, so settling back puts it where the gesture alone would have.
  local buffer, now = api.nvim_get_current_buf(), vim.uv.now()
  local cursor = api.nvim_win_get_cursor(window)
  local origin = pushed
  if not (origin and origin.window == window and origin.buffer == buffer
      and origin.tick == api.nvim_buf_get_changedtick(buffer) and now - origin.time < 500
      and origin.lnum == cursor[1] and origin.col == cursor[2]) then
    origin = {virtcol=vim.fn.virtcol('.')}
  end
  place(window, view, left, view.lnum, origin.virtcol)
  cursor = api.nvim_win_get_cursor(window)
  pushed = {window=window, buffer=buffer, tick=api.nvim_buf_get_changedtick(buffer), time=now,
    lnum=cursor[1], col=cursor[2], virtcol=origin.virtcol}
  remember_leftcol(left)
  return true
end

--- Whether a prefetch is drawing views other than the real one. Bracket guides are not
--- published for those views (nido_brackets), or they would show at the rows of another view.
M.prefetching = false

--- Draw rows beyond the view (below with `down`) so the renderer can cache them, then put the
--- view back. `previous` continues from where the last call stopped; returns the next one.
function M.prefetch(down, previous, scrolling)
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
  -- While input is arriving, fill two viewports and leave the deeper cache for idle time.
  local limit = scrolling and math.min(256, math.max(32, height * 2)) or 256
  if cached >= limit then
    return
  end
  local scrolloff, saved_mouse_scrolloff = vim.wo.scrolloff, mouse_scrolloff
  -- Cached rows must be painted at the panned column the real scroll will keep.
  local wanted = not vim.wo.wrap and wanted_leftcol(view)
  local step = math.max(1, height - 1)
  -- Visit only the next strip, then restore the real view before yielding to input.
  local views = {}
  local remaining = math.min(32, limit - cached)
  local depth = cached
  local at_edge = false
  M.prefetching = true
  prefetch_cursor = {window=window, pos={view.lnum, view.col}}
  local ok, err = pcall(function()
    if cached > 0 then
      vim.cmd.normal({args={cached .. string.char(down and 5 or 25)}, bang=true})
      if wanted then keep_leftcol(wanted) end
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
      if wanted then keep_leftcol(wanted) end
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
  local restored, restore_err = pcall(function()
    for index = #views, 1, -1 do
      vim.fn.winrestview(views[index])
      vim.cmd.redraw()
    end
  end)
  -- The last redraw shows the real view again, so its guides are published.
  M.prefetching = false
  prefetch_cursor = nil
  vim.fn.winrestview(view)
  vim.cmd.redraw()
  if not restored then
    vim.wo.scrolloff = scrolloff
    mouse_scrolloff = saved_mouse_scrolloff
    error(restore_err)
  end
  vim.wo.scrolloff = scrolloff
  mouse_scrolloff = saved_mouse_scrolloff
  if not ok then
    error(err)
  end
  local complete = at_edge or depth >= limit
  local upper_edge, lower_edge
  if down then lower_edge = at_edge else upper_edge = at_edge end
  publish_cache(upper_edge, lower_edge, complete)
  if not complete then
    return {buffer=buffer, window=window, tick=tick, height=height, width=width,
      view=view, depth=depth}
  end
end

--- Scroll by `lines` (fractional with `pixel`) and `columns`. With `follow` the cursor moves
--- with the view; otherwise it stays anchored. Returns whether the view changed.
function M.scroll(lines, follow, pixel, columns)
  columns = vim.wo.wrap and 0 or (columns or 0)
  if lines == 0 and columns == 0 then
    publish_offset(pixel)
    return false
  end
  centered_view = nil
  if anchor then
    anchor.returned = nil
  end
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
      mark = api.nvim_buf_set_extmark(0, namespace, pos[1] - 1, pos[2], {right_gravity=false}),
    }
    redraw_numbers(anchor.window)
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
    local wanted = not vim.wo.wrap and wanted_leftcol(before)
    vim.cmd.normal({args={math.abs(lines) .. string.char(lines > 0 and 5 or 25)}, bang=true})
    if wanted then
      keep_leftcol(wanted)
      remember_leftcol(wanted)
    end
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

-- What each window last showed of each buffer: the view, and while scrolled away from the
-- cursor, the anchored cursor and the view around it. Neovim itself keeps only the cursor and
-- centers it when the buffer returns, which lost the scroll position on every tab switch.
local views = {}

local function editor_window(window, buffer)
  return vim.bo[buffer].buftype == '' and api.nvim_win_get_config(window).relative == ''
end

local function remember_view()
  local window, buffer = api.nvim_get_current_win(), api.nvim_get_current_buf()
  if not editor_window(window, buffer) then
    return
  end
  local entry = {view = vim.fn.winsaveview()}
  local pos = M.cursor()
  if pos and anchor.buffer == buffer and anchor.window == window then
    entry.anchor = {pos = pos, view = anchor.view}
  end
  views[window] = views[window] or {}
  views[window][buffer] = entry
end

local function restore_view(buffer)
  local window = api.nvim_get_current_win()
  local entry = views[window] and views[window][buffer]
  if not entry or not editor_window(window, buffer) then
    return
  end
  views[window][buffer] = nil
  vim.fn.winrestview(entry.view)
  local saved = entry.anchor
  if not saved then
    return
  end
  local last = api.nvim_buf_line_count(buffer)
  local row = math.min(saved.pos[1], last)
  local text = api.nvim_buf_get_lines(buffer, row - 1, row, false)[1] or ''
  anchor = {
    buffer = buffer, window = window, view = saved.view,
    mark = api.nvim_buf_set_extmark(buffer, namespace, row - 1, math.min(saved.pos[2], #text), {right_gravity=false}),
    returned = api.nvim_win_get_cursor(window),
  }
  redraw_numbers(window)
  publish_offset()
end

api.nvim_create_autocmd('BufLeave', {callback=function()
  remember_view()
  M.restore()
end})
api.nvim_create_autocmd('BufWinEnter', {callback=function(args)
  restore_view(args.buf)
end})
api.nvim_create_autocmd('BufWipeout', {callback=function(args)
  for _, buffers in pairs(views) do
    buffers[args.buf] = nil
  end
end})
api.nvim_create_autocmd('WinClosed', {callback=function(args)
  views[tonumber(args.match)] = nil
end})
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
