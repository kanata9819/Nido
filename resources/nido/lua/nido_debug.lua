local M = {}
local base = vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)))
local resources = vim.fs.dirname(base)
vim.opt.runtimepath:append(resources .. '/debug/nvim-dap-9e848e09a697ee95302a3ef2dd43fd6eb709e570')
local dap = require('dap')
local root = vim.env.NIDO_WORKSPACE_ROOT or vim.fn.getcwd()
local channel, build
local generation = 0
local launch_args = {}
local launch_cwd = root
local launch_env
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

local expanded, nodes, previous, current = {}, {}, {}, {}
local epoch, next_id = 0, 0
local function reset_variables(new_run)
  epoch = epoch + 1
  previous = new_run and {} or current
  current, nodes = {}, {}
  if new_run then expanded = {} end
end
local refresh
refresh = function()
  vim.schedule(function()
    local session = dap.session()
    local frame = session and session.current_frame
    state.variables = {}
    state.location = nil
    if frame and state.status == 'paused' then
      state.location = (frame.source and frame.source.path or frame.name) .. ':' .. frame.line
      local frame_key = (frame.source and frame.source.path or '') .. '/' .. frame.name
      local function append(values, path, scope, depth, parent)
        for index, value in ipairs(values) do
          local key = path .. '/' .. index .. ':' .. value.name
          local node = nodes[key]
          if not node then
            next_id = next_id + 1
            node = {id=next_id, reference=value.variablesReference or 0, key=key}
            nodes[key] = node
          end
          local open = expanded[key] == true and node.reference > 0
          current[key] = value.value
          if open and not node.children and not node.loading and not node.error then
            node.loading = true
            local request_epoch = epoch
            session:request('variables', {variablesReference=node.reference}, function(err, response)
              if epoch ~= request_epoch or dap.session() ~= session or session.current_frame ~= frame or state.status ~= 'paused' then return end
              node.loading = false
              if err then node.error = err.message or tostring(err)
              else node.children = response and response.variables or {} end
              refresh()
            end)
          end
          table.insert(state.variables, {
            id=node.id, parent=parent, scope=scope, depth=depth,
            name=value.name, value=value.value, type=value.type or '',
            expandable=node.reference > 0, expanded=open, loading=node.loading == true,
            changed=previous[key] ~= nil and previous[key] ~= value.value, error=node.error,
          })
          if open and node.children then append(node.children, key, scope, depth+1, node.id) end
        end
      end
      for index, scope in ipairs(frame.scopes or {}) do
        append(scope.variables or {}, frame_key .. '/' .. index .. ':' .. scope.name, scope.name, 0, nil)
      end
    end
    publish()
  end)
end
for _, event in ipairs({'scopes', 'variables', 'stackTrace'}) do dap.listeners.after[event].nido = refresh end
dap.listeners.after.event_stopped.nido = function() reset_variables(false); state.status='paused'; refresh() end
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
  close_output()
  terminal_buf = nil
  state.terminal = nil
  publish()
  timer = vim.uv.new_timer()
  timer:start(200, 200, vim.schedule_wrap(read_output))
  dap.run({name=target.name, type='codelldb', request='launch', program=target.path,
    cwd=launch_cwd, args=launch_args, env=launch_env, stopOnEntry=false, terminal='integrated'})
end

local function check_saved()
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    assert(vim.bo[buffer].buftype ~= '' or not vim.bo[buffer].modified, 'Save modified files before debugging or running')
  end
end

local function start_build(args)
  assert(vim.fn.executable(dap.adapters.codelldb.executable.command) == 1, 'Bundled CodeLLDB is missing. Run pnpm prepare:neovim.')
  check_saved()
  launch_args = args and args.executableArgs or {}
  launch_cwd = args and (args.cwd or args.workspaceRoot) or root
  launch_env = args and args.environment or nil
  local cargo = args and vim.deepcopy(args.cargoArgs) or {'build', '--bins'}
  local tests = cargo[1] == 'test'
  assert(cargo[1] == 'run' or cargo[1] == 'build' or tests, 'This Cargo command cannot be debugged')
  if cargo[1] == 'run' then cargo[1]='build' end
  if tests then table.insert(cargo, '--no-run') end
  table.insert(cargo, '--message-format=json')
  table.insert(cargo, 1, args and args.overrideCargo or 'cargo')
  state = {status='building', kind='debug', output='Building Rust debug targets…\n', variables={}, targets={}}
  reset_variables(true)
  publish()
  generation = generation + 1
  local run = generation
  build = vim.system(cargo, {cwd=launch_cwd, env=launch_env, text=true}, function(result)
    vim.schedule(function()
      if run ~= generation or not build then return end
      build = nil
      output(result.stderr or '')
      local targets = {}
      for line in (result.stdout or ''):gmatch('[^\n]+') do
        local ok, item = pcall(vim.json.decode, line)
        if ok and item.reason == 'compiler-artifact' and type(item.executable) == 'string' and item.profile.test == tests then
          table.insert(targets, {name=item.target.name, path=item.executable})
        elseif ok and item.reason == 'compiler-message' and item.message.rendered then output(item.message.rendered) end
      end
      if result.code ~= 0 then fail('Cargo build failed.'); return end
      state.targets = targets
      if #targets == 0 then fail('No executable target found.'); return end
      if #targets == 1 then
        local ok, err = pcall(launch, 1)
        if not ok then fail(err) end
      else state.status='select'; publish() end
    end)
  end)
end

function M.runnable(item, debug, rpc)
  assert(not build and not dap.session(), 'Stop the current run or debugger first')
  assert(item.kind == 'cargo', 'Only Cargo runnables are supported')
  channel = rpc
  local args = item.args
  if debug then start_build(args); return end
  check_saved()
  local command = {args.overrideCargo or 'cargo'}
  vim.list_extend(command, args.cargoArgs)
  if #args.executableArgs > 0 then
    table.insert(command, '--')
    vim.list_extend(command, args.executableArgs)
  end
  close_output()
  state = {status='running', kind='run', output=item.label .. '\n', variables={}, targets={}}
  publish()
  generation = generation + 1
  local run = generation
  local function stream(err, text)
    vim.schedule(function()
      if run == generation then output(text or err or '') end
    end)
  end
  build = vim.system(command, {
    cwd=args.cwd or args.workspaceRoot or root, env=args.environment, text=true,
    stdout=stream, stderr=stream,
  }, function(result)
    vim.schedule(function()
      if run ~= generation or not build then return end
      build = nil
      state.status = result.code == 0 and 'finished' or 'error'
      output('Process exited: ' .. result.code .. '\n')
    end)
  end)
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
    start_build(nil)
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
  elseif action == 'variable' then
    if state.status ~= 'paused' then return end
    for _, node in pairs(nodes) do
      if node.id == index and node.reference > 0 then
        expanded[node.key] = not expanded[node.key]
        node.error = nil
        refresh()
        return
      end
    end
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
