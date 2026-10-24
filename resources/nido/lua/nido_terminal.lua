local M = {}
local job, buffer

function M.start(choice, command)
  local choices = {
    auto = true,
    pwsh = true,
    ['powershell.exe'] = true,
    ['cmd.exe'] = true,
    ['wsl.exe'] = true,
  }
  assert(choices[choice or 'auto'], 'Invalid terminal shell.')
  if vim.env.NIDO_WSL == '1' then
    command = {vim.env.SHELL or '/bin/sh', '-l'}
  end
  assert(type(command) == 'table' and type(command[1]) == 'string', 'Invalid terminal command.')
  assert(vim.fn.executable(command[1]) == 1, 'Shell is not installed or not on PATH: ' .. command[1])
  vim.cmd('stopinsert')
  local previous_job = job
  job = nil
  if previous_job and vim.fn.jobwait({ previous_job }, 0)[1] == -1 then
    vim.fn.jobstop(previous_job)
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
  job = vim.fn.jobstart(command, {
    term = true,
    cwd = vim.fn.getcwd(),
    on_exit = function(exited_job)
      vim.schedule(function()
        -- Restarting the shell also exits a job; only close the current shell.
        if job == exited_job then
          vim.rpcnotify(vim.g.nido_channel, 'nido:terminal_exit')
        end
      end)
    end,
  })
  assert(job > 0, 'Could not start ' .. command[1])
  vim.cmd('startinsert')
end

return M
