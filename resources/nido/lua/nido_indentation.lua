-- The current file's indentation (spaces or tabs, and the width): shown in the status bar
-- and changed from its indentation commands.
local api = vim.api
local M = {}

-- Indentation of the current file buffer for the status bar, or nil elsewhere.
function M.detect()
  if vim.bo.buftype ~= '' then
    return nil
  end
  return {spaces = vim.bo.expandtab, size = vim.fn.shiftwidth()}
end

-- Rewrite each line's leading whitespace with spaces or tabs, keeping its width.
-- `tabstop` is the width tabs had before the change.
local function convert(spaces, size, tabstop)
  local lines = api.nvim_buf_get_lines(0, 0, -1, false)
  for index, line in ipairs(lines) do
    local leading = line:match('^[ \t]*')
    if leading ~= '' then
      local width = 0
      for character in leading:gmatch('.') do
        width = character == '\t' and (math.floor(width / tabstop) + 1) * tabstop or width + 1
      end
      local replacement = spaces and string.rep(' ', width)
        or string.rep('\t', math.floor(width / size)) .. string.rep(' ', width % size)
      if replacement ~= leading then
        api.nvim_buf_set_text(0, index - 1, 0, index - 1, #leading, {replacement})
      end
    end
  end
end

--- Use spaces or tabs of `size` for the current buffer. `rewrite` also converts the leading
--- whitespace of every line.
function M.set(spaces, size, rewrite)
  assert(type(spaces) == 'boolean', 'Invalid indentation')
  assert(type(size) == 'number' and size % 1 == 0 and size >= 1 and size <= 16,
    'Invalid indent size')
  assert(vim.bo.buftype == '', 'Buffer has no indentation settings')
  local tabstop = vim.bo.tabstop
  if rewrite then
    assert(vim.bo.modifiable, 'Buffer cannot be modified')
    local view = vim.fn.winsaveview()
    convert(spaces, size, tabstop)
    vim.fn.winrestview(view)
  end
  vim.bo.expandtab = spaces
  vim.bo.shiftwidth = size
  -- Tabs display at the chosen size; a softtabstop follows shiftwidth.
  if not spaces then
    vim.bo.tabstop = size
  end
  if vim.bo.softtabstop ~= 0 then
    vim.bo.softtabstop = -1
  end
  api.nvim_exec_autocmds('User', {pattern = 'NidoIndentation'})
end

return M
