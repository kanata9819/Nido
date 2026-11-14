-- The diagnostic card: sends the diagnostics at the cursor to the renderer, which shows them in
-- a card (DiagnosticInformation.tsx), and hides it again when the cursor moves.
local M = {}
-- Where the card was shown (buffer, window and cursor), or nil when it is hidden.
local visible

--- Hide the card.
function M.hide()
  if visible and vim.g.nido_channel then
    vim.rpcnotify(vim.g.nido_channel, 'nido:diagnostics', {})
  end
  visible = nil
end

--- Show the diagnostics of the cursor line, most severe first. `focus` lets the card take focus.
function M.show(focus)
  if focus == nil then focus = true end
  require('nido_hover').clear()
  local buf, win = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
  local cursor = vim.api.nvim_win_get_cursor(win)
  local diagnostics = vim.diagnostic.get(buf, {lnum=cursor[1] - 1})
  table.sort(diagnostics, function(a, b)
    if a.severity ~= b.severity then return a.severity < b.severity end
    return a.col < b.col
  end)
  if #diagnostics == 0 then
    M.hide()
    if focus then
      vim.notify('No diagnostics on this line.', vim.log.levels.INFO, {title='Diagnostics'})
    end
    return
  end
  local items = {}
  for _, diagnostic in ipairs(diagnostics) do
    items[#items + 1] = {
      path = vim.api.nvim_buf_get_name(buf),
      line = diagnostic.lnum + 1,
      column = diagnostic.col + 1,
      severity = diagnostic.severity,
      source = diagnostic.source or '',
      code = tostring(diagnostic.code or ''),
      message = diagnostic.message,
    }
  end
  visible = {buf=buf, win=win, cursor=cursor}
  if vim.g.nido_channel then
    vim.rpcnotify(vim.g.nido_channel, 'nido:diagnostics', items, focus)
  end
end

--- Jump to the next (1) or previous (-1) diagnostic, with a count, and show it.
function M.jump(direction)
  vim.diagnostic.jump({count=direction * vim.v.count1, float=false})
  M.show(false)
end

-- Hide the card when the cursor leaves its position, the buffer is left, or diagnostics change.
vim.api.nvim_create_autocmd('CursorMoved', {
  callback = function()
    -- A jump's delayed CursorMoved must not dismiss the card for its new position.
    if visible and (visible.buf ~= vim.api.nvim_get_current_buf()
      or visible.win ~= vim.api.nvim_get_current_win()
      or not vim.deep_equal(visible.cursor, vim.api.nvim_win_get_cursor(0))) then
      M.hide()
    end
  end,
})
vim.api.nvim_create_autocmd({'InsertEnter', 'CmdlineEnter', 'BufLeave', 'WinLeave'}, {callback=M.hide})
vim.api.nvim_create_autocmd('DiagnosticChanged', {
  callback = function(event)
    if visible and event.buf == visible.buf then M.hide() end
  end,
})

return M
