local api = vim.api
local M = {}
local namespace = api.nvim_create_namespace('nido_scroll_anchor')
local anchor

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
end

function M.scroll(lines, follow)
  if follow then
    M.restore()
  elseif not anchor and vim.bo.buftype == '' then
    local pos = api.nvim_win_get_cursor(0)
    anchor = {
      buffer = api.nvim_get_current_buf(), window = api.nvim_get_current_win(),
      view = vim.fn.winsaveview(),
      mark = api.nvim_buf_set_extmark(0, namespace, pos[1] - 1, pos[2], {right_gravity=false}),
    }
  end
  vim.cmd.normal({args={math.abs(lines) .. string.char(lines > 0 and 5 or 25)}, bang=true})
  api.nvim_exec_autocmds('User', {pattern='NidoScroll'})
end

api.nvim_create_autocmd('BufLeave', {callback=M.restore})
return M
