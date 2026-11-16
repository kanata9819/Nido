-- Runs the shells of a terminal workspace, each in its own Neovim terminal buffer. One shell
-- is shown at a time; the panel's tabs switch between them.
local M = {}
-- The shells in tab order: { job = job id, buffer = terminal buffer, name = shell name }.
local shells = {}
-- Index of the shown shell.
local current = 0

local choices = {
  auto = true,
  pwsh = true,
  ['powershell.exe'] = true,
  ['cmd.exe'] = true,
  ['wsl.exe'] = true,
}

--- Tell Nido which shells run and which one is shown.
local function publish()
  local names = {}
  for index, shell in ipairs(shells) do
    names[index] = shell.name
  end
  vim.rpcnotify(vim.g.nido_channel, 'nido:terminal_shells', { names = names, current = current })
end

--- A terminal window shows no line numbers, signs or status line. 'statuscolumn' must be
--- cleared too: it is drawn even without 'number', and editor windows set it (init.lua).
local function window_options()
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.statuscolumn = ''
  vim.wo.signcolumn = 'no'
  vim.wo.foldcolumn = '0'
  vim.wo.statusline = ' '
  vim.o.ruler = false
end

--- Show the shell at `index` and type into it.
local function show(index)
  current = index
  vim.cmd('stopinsert')
  vim.api.nvim_set_current_buf(shells[index].buffer)
  window_options()
  vim.cmd('startinsert')
end

--- The shell's command line: `command` is resolved by the main process; inside WSL the
--- user's login shell is used instead.
local function resolve(choice, command)
  assert(choices[choice or 'auto'], 'Invalid terminal shell.')
  if vim.env.NIDO_WSL == '1' then
    command = {vim.env.SHELL or '/bin/sh', '-l'}
  end
  assert(type(command) == 'table' and type(command[1]) == 'string', 'Invalid terminal command.')
  assert(vim.fn.executable(command[1]) == 1, 'Shell is not installed or not on PATH: ' .. command[1])
  return command
end

--- Remove an exited shell. The last one closes the terminal; otherwise a neighbour is shown.
local function exited(shell)
  local index
  for position, other in ipairs(shells) do
    if other == shell then
      index = position
    end
  end
  if not index then
    return
  end
  table.remove(shells, index)
  if #shells == 0 then
    current = 0
    vim.rpcnotify(vim.g.nido_channel, 'nido:terminal_exit')
    return
  end
  local was_shown = index == current
  if index < current or current > #shells then
    current = current - 1
  end
  if was_shown then
    show(current)
  end
  if vim.api.nvim_buf_is_valid(shell.buffer) then
    vim.api.nvim_buf_delete(shell.buffer, { force = true })
  end
  publish()
end

--- Run `command` in a new terminal buffer for `shell`, shown in the current window.
local function spawn(shell, command)
  vim.cmd('stopinsert')
  shell.buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(shell.buffer)
  -- Entering the new buffer ran the editor window autocommand; undo its columns.
  window_options()
  vim.bo[shell.buffer].scrollback = 10000
  shell.name = vim.fn.fnamemodify(command[1], ':t:r')
  local job
  job = vim.fn.jobstart(command, {
    term = true,
    cwd = vim.fn.getcwd(),
    on_exit = function()
      vim.schedule(function()
        -- Restarting a shell also exits its old job; only remove the shell's current one.
        if shell.job == job then
          exited(shell)
        end
      end)
    end,
  })
  assert(job > 0, 'Could not start ' .. command[1])
  shell.job = job
  -- Copy mode (Ctrl+Shift+C): a yank copies the text to the system clipboard through Nido,
  -- which also works inside WSL, and returns to the shell.
  local buffer = shell.buffer
  vim.api.nvim_create_autocmd('TextYankPost', {
    buffer = buffer,
    callback = function()
      local event = vim.v.event
      if event.operator ~= 'y' then
        return
      end
      local text = table.concat(event.regcontents, '\n')
      if event.regtype == 'V' then
        text = text .. '\n'
      end
      vim.rpcnotify(vim.g.nido_channel, 'nido:yank', text)
      vim.schedule(function()
        if vim.api.nvim_get_current_buf() == buffer then
          vim.cmd('startinsert')
        end
      end)
    end,
  })
  vim.cmd('startinsert')
end

--- Start the first shell, or restart the shown one.
function M.start(choice, command)
  command = resolve(choice, command)
  local shell = shells[current]
  if not shell then
    shell = {}
    shells = { shell }
    current = 1
  end
  local previous_job, previous_buffer = shell.job, shell.buffer
  shell.job = nil
  if previous_job and vim.fn.jobwait({ previous_job }, 0)[1] == -1 then
    vim.fn.jobstop(previous_job)
  end
  spawn(shell, command)
  if previous_buffer and vim.api.nvim_buf_is_valid(previous_buffer) then
    vim.api.nvim_buf_delete(previous_buffer, { force = true })
  end
  publish()
end

--- Start another shell after the others and show it.
function M.add(choice, command)
  command = resolve(choice, command)
  local shell = {}
  local previous = current
  table.insert(shells, shell)
  current = #shells
  local ok, err = pcall(spawn, shell, command)
  if not ok then
    -- A shell that did not start leaves no tab; the previous one is shown again.
    table.remove(shells)
    if shell.buffer and vim.api.nvim_buf_is_valid(shell.buffer) then
      vim.api.nvim_buf_delete(shell.buffer, { force = true })
    end
    if shells[previous] then
      show(previous)
    end
    error(err, 0)
  end
  publish()
end

--- Show the shell at `index` (1-based).
function M.select(index)
  assert(shells[index], 'No such shell.')
  if index ~= current then
    show(index)
    publish()
  elseif vim.fn.mode() ~= 't' then
    vim.cmd('startinsert')
  end
end

--- Stop the shell at `index`; it is removed once its job exits.
function M.close(index)
  local shell = assert(shells[index], 'No such shell.')
  vim.fn.jobstop(shell.job)
end

return M
