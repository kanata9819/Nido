local M = {}
local max_bytes, max_lines = 1048576, 20000

local function snapshot(buffer, strict)
  if not vim.api.nvim_buf_is_loaded(buffer) or not vim.bo[buffer].buflisted
      or vim.bo[buffer].buftype ~= '' or vim.api.nvim_buf_get_name(buffer) == '' then
    if strict then return { error = 'Open a named text file to use Time Machine.' } end
    return nil
  end
  local count = vim.api.nvim_buf_line_count(buffer)
  if count > max_lines or vim.api.nvim_buf_get_offset(buffer, count) > max_bytes then
    if strict then return { error = 'Time Machine supports text files up to 1 MB and 20,000 lines.' } end
    return nil
  end
  local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
  -- Neovim represents embedded NUL bytes as newlines inside a buffer line.
  for _, line in ipairs(lines) do
    if line:find('\n', 1, true) then
      if strict then return { error = 'Time Machine only supports text files.' } end
      return nil
    end
  end
  local text = table.concat(lines, '\n')
  if vim.bo[buffer].endofline then text = text .. '\n' end
  if text:find('\0', 1, true) then
    if strict then return { error = 'Time Machine only supports text files.' } end
    return nil
  end
  if #text > max_bytes then
    if strict then return { error = 'Time Machine supports text files up to 1 MB and 20,000 lines.' } end
    return nil
  end
  return {
    path = vim.api.nvim_buf_get_name(buffer), buffer = buffer,
    tick = vim.api.nvim_buf_get_changedtick(buffer), modified = vim.bo[buffer].modified,
    text = text, endOfLine = vim.bo[buffer].endofline, fileformat = vim.bo[buffer].fileformat,
  }
end

function M.current()
  return snapshot(vim.api.nvim_get_current_buf(), true)
end

function M.changed(tokens)
  local previous, result, bytes = {}, {}, 0
  for _, token in ipairs(tokens) do previous[token[1]] = token end
  -- Capture the active edit first even when many restored buffers fill the batch.
  local current = vim.api.nvim_get_current_buf()
  local buffers = { current }
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if buffer ~= current then table.insert(buffers, buffer) end
  end
  for _, buffer in ipairs(buffers) do
    if vim.api.nvim_buf_is_loaded(buffer) then
      local token = previous[buffer]
      if not token or token[2] ~= vim.api.nvim_buf_get_changedtick(buffer)
          or token[3] ~= vim.bo[buffer].fileformat or token[4] ~= vim.bo[buffer].endofline then
        local value = snapshot(buffer, false)
        if value then
          table.insert(result, value)
          bytes = bytes + #value.text
          if bytes >= max_bytes * 2 or #result >= 8 then break end
        end
      end
    end
  end
  return result
end

function M.diff(before, after)
  if before ~= after then
    return vim.diff(before, after, { result_type = 'unified', ctxlen = max_lines, algorithm = 'histogram' })
  end
  local lines = vim.split(before, '\n', { plain = true })
  if lines[#lines] == '' and #lines > 1 then table.remove(lines) end
  local output = { string.format('@@ -1,%d +1,%d @@', #lines, #lines) }
  for _, line in ipairs(lines) do table.insert(output, ' ' .. line) end
  return table.concat(output, '\n')
end

function M.restore(path, token, value)
  local buffer = vim.api.nvim_get_current_buf()
  local actual = table.concat({ buffer, vim.api.nvim_buf_get_changedtick(buffer),
    vim.bo[buffer].fileformat, tostring(vim.bo[buffer].endofline) }, ':')
  if vim.api.nvim_buf_get_name(buffer) ~= path or actual ~= token then
    return { error = 'The file changed. Refresh the preview before restoring.' }
  end
  if not vim.bo[buffer].modifiable or vim.bo[buffer].readonly then
    return { error = 'This file is read-only. History was preserved.' }
  end
  require('nido_scroll').restore()
  local lines = vim.split(value.text, '\n', { plain = true })
  if value.endOfLine and lines[#lines] == '' and #lines > 1 then table.remove(lines) end
  local cursor = vim.api.nvim_win_get_cursor(0)
  -- A restoration is a new edit. Native undo can return to the previous draft.
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].endofline = value.endOfLine
  vim.bo[buffer].fileformat = value.fileformat
  vim.bo[buffer].modified = true
  cursor[1] = math.min(cursor[1], #lines)
  cursor[2] = math.min(cursor[2], #(lines[cursor[1]] or ''))
  vim.api.nvim_win_set_cursor(0, cursor)
  return M.current()
end

return M
