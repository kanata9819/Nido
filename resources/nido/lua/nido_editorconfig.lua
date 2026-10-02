local api = vim.api
local M = {}
local editorconfig = require('editorconfig')
local configure = editorconfig.config
local saved = {}
local options = {'expandtab', 'shiftwidth', 'softtabstop', 'tabstop', 'fileformat',
  'fileencoding', 'bomb', 'textwidth', 'fixendofline', 'endofline', 'spelllang'}

local function restore(buffer)
  api.nvim_clear_autocmds({group='nvim.editorconfig', event='BufWritePre', buffer=buffer})
  if saved[buffer] then
    for name, value in pairs(saved[buffer]) do vim.bo[buffer][name] = value end
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
  if not saved[buffer] then
    saved[buffer] = {}
    for _, name in ipairs(options) do saved[buffer][name] = vim.bo[buffer][name] end
  end
  restore(buffer)
  configure(buffer)
end

-- The GUI applies the persisted setting once it connects to this session.
vim.g.editorconfig = false
vim.cmd('runtime plugin/editorconfig.lua')
api.nvim_create_autocmd('BufWipeout', {callback=function(event) saved[event.buf] = nil end})

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
