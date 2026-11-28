-- EditorConfig support that can be switched on and off. Neovim's built-in editorconfig
-- plugin applies .editorconfig settings; this wraps it so turning the setting off restores
-- each buffer's options from before it was applied.
local api = vim.api
local M = {}
local editorconfig = require('editorconfig')
local configure = editorconfig.config
-- Per buffer, the original and applied values for options EditorConfig changed.
local saved = {}
-- The options EditorConfig can set.
local options = {'expandtab', 'shiftwidth', 'softtabstop', 'tabstop', 'fileformat',
  'fileencoding', 'bomb', 'textwidth', 'fixendofline', 'endofline', 'spelllang'}

--- Undo EditorConfig's changes to a buffer.
local function restore(buffer)
  api.nvim_clear_autocmds({group='nvim.editorconfig', event='BufWritePre', buffer=buffer})
  if saved[buffer] then
    for name, value in pairs(saved[buffer]) do
      if vim.bo[buffer][name] == value.applied then
        vim.bo[buffer][name] = value.before
      end
    end
  end
  vim.b[buffer].editorconfig = nil
end

-- Use the bundled parser and properties, retaining the pre-extension buffer settings.
editorconfig.config = function(buffer)
  buffer = buffer or api.nvim_get_current_buf()
  if not vim.g.editorconfig or not api.nvim_buf_is_valid(buffer)
      or vim.bo[buffer].buftype ~= '' or not vim.bo[buffer].modifiable
      or api.nvim_buf_get_name(buffer) == '' then
    return
  end
  restore(buffer)
  local before = {}
  for _, name in ipairs(options) do before[name] = vim.bo[buffer][name] end
  configure(buffer)
  local changes = {}
  for _, name in ipairs(options) do
    local applied = vim.bo[buffer][name]
    if applied ~= before[name] then
      changes[name] = {before = before[name], applied = applied}
    end
  end
  saved[buffer] = changes
end

-- The GUI applies the persisted setting once it connects to this session.
vim.g.editorconfig = false
vim.cmd('runtime plugin/editorconfig.lua')
api.nvim_create_autocmd('BufReadPre', {callback=function(event)
  -- A reread detects fresh encoding and line-ending options. Remove the previous
  -- extension first so BufReadPost records this read's baseline before applying it.
  if saved[event.buf] then
    restore(event.buf)
    saved[event.buf] = nil
  end
end})
api.nvim_create_autocmd('BufWipeout', {callback=function(event) saved[event.buf] = nil end})

--- Turn EditorConfig on or off for every loaded buffer.
function M.set_enabled(enabled)
  if vim.g.editorconfig == enabled then
    return
  end
  vim.g.editorconfig = enabled
  for _, buffer in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(buffer) then
      if enabled then
        editorconfig.config(buffer)
      elseif saved[buffer] then
        restore(buffer)
        saved[buffer] = nil
      end
    end
  end
  api.nvim_exec_autocmds('User', {pattern='NidoLineEndings'})
  vim.cmd.redraw()
end

return M
