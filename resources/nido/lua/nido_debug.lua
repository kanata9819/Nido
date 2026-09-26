local M = {}
local base = vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)))
local resources = vim.fs.dirname(base)
vim.opt.runtimepath:append(resources .. '/debug/nvim-dap-9e848e09a697ee95302a3ef2dd43fd6eb709e570')
local dap = require('dap')
local root = vim.env.NIDO_WORKSPACE_ROOT or vim.fn.getcwd()
local channel, build
local generation = 0
local state = {status='idle', output='', variables={}, targets={}}
local function publish()
  if channel then vim.rpcnotify(channel, 'nido:debug', state) end
end
local function output(text)
  state.output = (state.output .. text):sub(-20000)
  publish()
end
local function fail(message)
  state.status = 'error'
  output(tostring(message) .. '\n')
end
-- Windows LLDB does not consistently forward console stdout through DAP.
local terminal_buf, timer
dap.defaults.fallback.terminal_win_cmd = function()
  terminal_buf = vim.api.nvim_create_buf(false, true)
  return terminal_buf
end
local function read_output()
  if terminal_buf and vim.api.nvim_buf_is_valid(terminal_buf) then
    local count = vim.api.nvim_buf_line_count(terminal_buf)
    local text = table.concat(vim.api.nvim_buf_get_lines(terminal_buf, math.max(0, count-200), -1, false), '\n')
    if text ~= state.terminal then state.terminal=text; publish() end
  end
end
local function close_output()
  if timer then timer:stop(); timer:close(); timer=nil end
  read_output()
end
require('dap.utils').notify = function(message) output(tostring(message) .. '\n') end
dap.adapters.codelldb = {
  type='server', port='${port}',
  executable={command=resources .. '/debug/codelldb/extension/adapter/codelldb.exe', args={'--port', '${port}'}, detached=false},
}
dap.adapters.lldb = dap.adapters.codelldb
vim.fn.sign_define('DapBreakpoint', {text='●', texthl='DiagnosticError'})
vim.fn.sign_define('DapBreakpointRejected', {text='○', texthl='DiagnosticWarn'})
vim.fn.sign_define('DapStopped', {text='▶', texthl='DiagnosticWarn', linehl='NidoDebugLine'})
vim.api.nvim_set_hl(0, 'NidoDebugLine', {bg='#343020'})

local function refresh()
  vim.schedule(function()
    local session = dap.session()
    local frame = session and session.current_frame
    state.variables = {}
    state.location = nil
    if frame then
      state.location = (frame.source and frame.source.path or frame.name) .. ':' .. frame.line
      for _, scope in ipairs(frame.scopes or {}) do
        for _, value in ipairs(scope.variables or {}) do
          table.insert(state.variables, {name=value.name, value=value.value, type=value.type or ''})
        end
      end
    end
    publish()
  end)
end
for _, event in ipairs({'scopes', 'variables', 'stackTrace'}) do dap.listeners.after[event].nido = refresh end
dap.listeners.after.event_stopped.nido = function() state.status='paused'; refresh() end
dap.listeners.after.event_continued.nido = function() state.status='running'; refresh() end
dap.listeners.after.event_initialized.nido = function() state.status='running'; publish() end
dap.listeners.after.event_output.nido = function(_, event) output(event.output or '') end
dap.listeners.after.event_exited.nido = function(_, event) output('Process exited: ' .. tostring(event.exitCode) .. '\n') end
dap.listeners.after.event_terminated.nido = function() read_output(); state.status='finished'; state.variables={}; state.location=nil; publish() end
dap.listeners.after.launch.nido = function(_, err) if err then fail(err.message) end end
dap.listeners.before.disconnect.nido = function() state.status='finished'; publish() end
dap.listeners.on_session.nido = function(_, session)
  local run = generation
  if session then session.on_close.nido = function()
    vim.schedule(function()
      if generation ~= run then return end
      vim.defer_fn(function() if generation == run then close_output() end end, 200)
      if state.status == 'starting' then fail('Debugger closed before launch completed.')
      elseif state.status ~= 'error' then state.status='finished'; state.variables={}; state.location=nil; publish() end
    end)
  end end
end

local function launch(index)
  local target = state.targets[index]
  assert(target, 'Choose a debug target')
  state.status = 'starting'
  publish()
  close_output()
  timer = vim.uv.new_timer()
  timer:start(200, 200, vim.schedule_wrap(read_output))
  dap.run({name=target.name, type='codelldb', request='launch', program=target.path,
    cwd=root, args={}, stopOnEntry=false, terminal='integrated'})
end

local function action_impl(action, rpc, index)
  channel = rpc
  if action == 'breakpoint' then
    assert(vim.bo.buftype == '' and vim.api.nvim_buf_get_name(0) ~= '', 'Open a source file first')
    dap.toggle_breakpoint()
    publish()
  elseif action == 'start' then
    if dap.session() then
      if dap.session().stopped_thread_id then dap.continue() end
      return
    end
    if build then return end
    assert(vim.fn.executable(dap.adapters.codelldb.executable.command) == 1, 'Bundled CodeLLDB is missing. Run pnpm prepare:neovim.')
    for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
      assert(vim.bo[buffer].buftype ~= '' or not vim.bo[buffer].modified, 'Save modified files before debugging')
    end
    state = {status='building', output='Building Rust debug targets…\n', variables={}, targets={}}
    publish()
    generation = generation + 1
    local run = generation
    build = vim.system({'cargo', 'build', '--bins', '--message-format=json'}, {cwd=root, text=true}, function(result)
      vim.schedule(function()
        if run ~= generation or not build then return end
        build = nil
        output(result.stderr or '')
        local targets = {}
        for line in (result.stdout or ''):gmatch('[^\n]+') do
          local ok, item = pcall(vim.json.decode, line)
          if ok and item.reason == 'compiler-artifact' and type(item.executable) == 'string' and not item.profile.test then
            table.insert(targets, {name=item.target.name, path=item.executable})
          elseif ok and item.reason == 'compiler-message' and item.message.rendered then output(item.message.rendered) end
        end
        if result.code ~= 0 then fail('Cargo build failed.'); return end
        state.targets = targets
        if #targets == 0 then fail('No binary target found. Debugging currently requires a Cargo binary target.'); return end
        if #targets == 1 then
          local ok, err = pcall(launch, 1)
          if not ok then fail(err) end
        else state.status='select'; publish() end
      end)
    end)
  elseif action == 'launch' then
    assert(state.status == 'select', 'No target selection pending')
    launch(index)
  elseif action == 'stop' then
    if build then generation=generation+1; build:kill(15); build=nil end
    dap.terminate()
    state.status='finished'; state.variables={}; state.location=nil; publish()
  elseif action == 'pause' then
    assert(dap.session(), 'No debug session is running')
    dap.pause()
  else
    assert(dap.session() and dap.session().stopped_thread_id, 'Pause the debugger before stepping')
    local actions = {over=dap.step_over, into=dap.step_into, out=dap.step_out}
    assert(actions[action], 'Invalid debug action')()
  end
end

function M.action(...)
  local ok, err = pcall(action_impl, ...)
  if not ok then fail(err); error(err) end
end

vim.api.nvim_create_autocmd('VimLeavePre', {callback=function()
  if build then build:kill(15); build=nil end
  close_output()
end})
return M
