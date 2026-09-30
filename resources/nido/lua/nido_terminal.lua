local M = {}
local job, buffer

function M.start(choice)
  local commands = {
    auto = {vim.fn.executable('pwsh') == 1 and 'pwsh' or 'powershell.exe', '-NoLogo'},
    pwsh = {'pwsh', '-NoLogo'},
    ['powershell.exe'] = {'powershell.exe', '-NoLogo'},
    ['cmd.exe'] = {'cmd.exe'},
    ['wsl.exe'] = {'wsl.exe'},
  }
  local command = commands[choice or 'auto']
  assert(command, 'Invalid terminal shell.')
  assert(vim.fn.executable(command[1]) == 1, 'Shell is not installed or not on PATH: ' .. command[1])
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
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = 'no'
  vim.wo.statusline = ' '
  vim.o.ruler = false
  vim.bo[buffer].scrollback = 10000
  job = vim.fn.jobstart(command, { term = true, cwd = vim.fn.getcwd() })
  assert(job > 0, 'Could not start ' .. command[1])
  vim.cmd('startinsert')
end

return M
