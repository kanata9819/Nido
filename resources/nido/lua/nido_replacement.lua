local M = {}

function M.apply(files)
  local api, edits = vim.api, {}
  -- Load and validate every target before changing any buffer or the active file.
  for _, item in ipairs(files) do
    local buffer = vim.fn.bufadd(item.path)
    vim.fn.bufload(buffer)
  end
  for _, item in ipairs(files) do
    local buffer = vim.fn.bufnr(item.path)
    local bo = vim.bo[buffer]
    assert(not bo.modified, 'Save unsaved target files before replacing.')
    assert(bo.modifiable and not bo.readonly and bo.buftype == '', 'Target file is read-only.')
    local ending = bo.fileformat == 'dos' and '\r\n' or bo.fileformat == 'mac' and '\r' or '\n'
    local original = table.concat(api.nvim_buf_get_lines(buffer, 0, -1, false), ending)
    if bo.endofline and not (original == '' and item.before == '') then original = original .. ending end
    if bo.bomb then original = '\239\187\191' .. original end
    assert(original == item.before, 'Search results changed. Search again.')
    local changed = bo.bomb and item.after:sub(4) or item.after
    local lines = vim.split(changed, ending, {plain=true})
    local has_ending = changed:sub(-#ending) == ending
    if has_ending then table.remove(lines) end
    if #lines == 0 then lines = {''} end
    table.insert(edits, {buffer=buffer, lines=lines, ending=has_ending})
  end
  for _, edit in ipairs(edits) do
    vim.bo[edit.buffer].buflisted = true
    vim.bo[edit.buffer].endofline = edit.ending
    vim.bo[edit.buffer].fixendofline = false
    api.nvim_buf_set_lines(edit.buffer, 0, -1, false, edit.lines)
  end
end

return M
