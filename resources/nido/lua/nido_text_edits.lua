local api = vim.api
local util = vim.lsp.util
local apply = util.apply_text_edits

-- Formatters may replace the whole document, even when most or all lines are unchanged.
-- Apply only the actual differences so CodeLens extmarks stay on their original lines.
util.apply_text_edits = function(edits, buffer, encoding)
  if #edits ~= 1 or not api.nvim_buf_is_loaded(buffer) then
    return apply(edits, buffer, encoding)
  end
  local edit = edits[1]
  local range = edit.range
  local before = api.nvim_buf_get_lines(buffer, 0, -1, false)
  if range.start.line ~= 0 or range.start.character ~= 0
    or range['end'].line < #before - 1 then
    return apply(edits, buffer, encoding)
  end
  if range['end'].line == #before - 1
    and util._get_line_byte_from_position(buffer, range['end'], encoding) < #before[#before] then
    return apply(edits, buffer, encoding)
  end
  vim.bo[buffer].buflisted = true

  local after = vim.split(edit.newText:gsub('\r\n?', '\n'), '\n', {plain=true})
  -- Match Neovim's handling of a range that includes the final newline.
  if range['end'].line >= #before and #after > 1 and after[#after] == ''
    and (vim.bo[buffer].eol or (vim.bo[buffer].fixeol and not vim.bo[buffer].binary)) then
    table.remove(after)
  end
  local hunks = vim.diff(table.concat(before, '\n') .. '\n', table.concat(after, '\n') .. '\n', {
    result_type='indices',
  })
  for index = #hunks, 1, -1 do
    local first, removed, next_row, added = unpack(hunks[index])
    if removed == added then
      -- Same-length replacements do not need to delete any line or move its virtual rows.
      for offset = removed - 1, 0, -1 do
        local row = first - 1 + offset
        api.nvim_buf_set_text(buffer, row, 0, row, #before[row + 1], {after[next_row + offset]})
      end
    else
      local start = removed == 0 and first or first - 1
      api.nvim_buf_set_lines(buffer, start, start + removed, false,
        vim.list_slice(after, next_row, next_row + added - 1))
    end
  end
end
