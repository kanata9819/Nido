local M = {}
local job, buffer

function M.start()
  vim.cmd('stopinsert')
  if job and vim.fn.jobwait({ job }, 0)[1] == -1 then
    vim.fn.jobstop(job)
  end
  local previous = buffer
  buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(buffer)
  if previous and vim.api.nvim_buf_is_valid(previous) then
    vim.api.nvim_buf_delete(previous, { force = true })
  end
  local shell = vim.fn.executable('pwsh') == 1 and 'pwsh' or 'powershell.exe'
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = 'no'
  vim.wo.statusline = ' '
  vim.o.ruler = false
  vim.bo[buffer].scrollback = 10000
  job = vim.fn.jobstart({ shell, '-NoLogo' }, { term = true, cwd = vim.fn.getcwd() })
  assert(job > 0, 'Could not start PowerShell.')
  vim.cmd('startinsert')
end

return M
