local api = vim.api
local M = {}
local namespace = api.nvim_create_namespace('nido_scroll_anchor')
local anchor
local fraction = 0
local centered_view

local function publish_offset(pixel)
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:pixel_scroll', fraction, pixel == true, M.screen_cursor())
  end
end

local function publish_cache(at_start)
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:scroll_cache', at_start)
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
  if not pos or api.nvim_get_current_win() ~= anchor.window or not vim.wo.relativenumber then
    return '%s%C%=%l '
  end
  -- Neovim moves its internal cursor to keep it visible; relative numbers use the edit anchor.
  if vim.v.virtnum ~= 0 then
    return '%s%C'
  end
  local current = vim.v.lnum == pos[1]
  local number = current and (vim.wo.number and pos[1] or 0) or math.abs(vim.v.lnum - pos[1])
  return '%s%C%=' .. (current and '%#CursorLineNr#' or '%#LineNr#') .. number .. '%* '
end

function M.restore(keep_view)
  -- A mouse click changes the editing anchor, not the visible pixel offset.
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
  -- The final content row is overscan, so EOF there still needs one screen row of scrolling.
  if bottom == info.winrow + info.height - 1 then
    vim.cmd.normal({args={string.char(5)}, bang=true})
  end
end

function M.prefetch()
  if vim.bo.buftype ~= '' or api.nvim_win_get_config(0).relative ~= '' then
    return
  end
  local mode = api.nvim_get_mode()
  -- A :normal command would consume an unfinished count, mapping or command-line input.
  if (mode.mode ~= 'n' and mode.mode ~= 'i') or mode.blocking then
    return
  end
  local view = vim.fn.winsaveview()
  if view.topline <= 1 and view.skipcol == 0 then
    publish_cache(true)
    return
  end
  -- Match Grid's bounded history; collect each viewport before restoring it in reverse order.
  -- Each step is smaller than the window so grid_scroll retains the outgoing rows.
  -- The whole traversal is one batch, so none of these temporary views are displayed.
  local views = {}
  local remaining = 256
  local step = math.max(1, api.nvim_win_get_height(0) - 1)
  local at_start = false
  local ok, err = pcall(function()
    while remaining > 0 do
      local before = vim.fn.winsaveview()
      if before.topline <= 1 and before.skipcol == 0 then
        at_start = true
        break
      end
      views[#views + 1] = before
      local count = math.min(step, remaining)
      vim.cmd.normal({args={count .. string.char(25)}, bang=true})
      vim.cmd.redraw()
      remaining = remaining - count
      local after = vim.fn.winsaveview()
      at_start = after.topline <= 1 and after.skipcol == 0
      if after.topline == before.topline and after.skipcol == before.skipcol then
        break
      end
    end
  end)
  for index = #views, 1, -1 do
    vim.fn.winrestview(views[index])
    vim.cmd.redraw()
  end
  vim.fn.winrestview(view)
  vim.cmd.redraw()
  if not ok then
    error(err)
  end
  publish_cache(at_start)
end

function M.scroll(lines, follow, pixel)
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
    local first, last = before, after
    if lines < 0 then
      first, last = after, before
    end
    local moved = api.nvim_win_text_height(0, {
      start_row=first.topline - 1, end_row=last.topline - 1,
      start_vcol=first.skipcol, end_vcol=last.skipcol,
    }).all
    if moved < math.abs(lines) then
      fraction = 0
    end
  end
  if vim.fn.line('w0') >= api.nvim_buf_line_count(0) then
    fraction = 0
  end
  -- Fractional movement only changes the renderer offset, not the editor state.
  if lines ~= 0 or anchor ~= previous_anchor then
    api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
  end
  vim.cmd.redraw()
  publish_offset(pixel)
end

api.nvim_create_autocmd('BufLeave', {callback=M.restore})
api.nvim_create_autocmd('WinScrolled', {callback=function()
  if not centered_view then
    return
  end
  local view = vim.fn.winsaveview()
  if view.topline ~= centered_view.topline or view.skipcol ~= centered_view.skipcol then
    fraction = 0
    centered_view = nil
    publish_offset()
  end
end})
return M
