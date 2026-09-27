local api = vim.api
local M = {}
local namespace = api.nvim_create_namespace('nido_scroll_anchor')
local anchor
local fraction = 0

local function publish_offset(pixel)
  for _, ui in ipairs(api.nvim_list_uis()) do
    vim.rpcnotify(ui.chan, 'nido:pixel_scroll', fraction, pixel == true, M.screen_cursor())
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

function M.restore()
  fraction = 0
  local pos = M.cursor()
  local saved = anchor
  anchor = nil
  if saved and api.nvim_buf_is_valid(saved.buffer) then
    api.nvim_buf_clear_namespace(saved.buffer, namespace, 0, -1)
    if pos and api.nvim_win_is_valid(saved.window) and api.nvim_win_get_buf(saved.window) == saved.buffer then
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

function M.scroll(lines, follow, pixel)
  if follow then
    if anchor then M.restore() end
  elseif not anchor and vim.bo.buftype == '' then
    local pos = api.nvim_win_get_cursor(0)
    anchor = {
      buffer = api.nvim_get_current_buf(), window = api.nvim_get_current_win(),
      view = vim.fn.winsaveview(),
      mark = api.nvim_buf_set_extmark(0, namespace, pos[1] - 1, pos[2], {right_gravity=false}),
    }
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
    if lines < 0 then first, last = after, before end
    local moved = api.nvim_win_text_height(0, {
      start_row=first.topline - 1, end_row=last.topline - 1,
      start_vcol=first.skipcol, end_vcol=last.skipcol,
    }).all
    if moved < math.abs(lines) then
      fraction = 0
    end
  end
  if vim.fn.line('w0') >= api.nvim_buf_line_count(0) then fraction = 0 end
  api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
  vim.cmd.redraw()
  publish_offset(pixel)
end

api.nvim_create_autocmd('BufLeave', {callback=M.restore})
return M
