local M = {}
local api = vim.api
local base = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h:h')
local adapters, states = {}, {}

function M.adapter(id)
  assert(id == 'typescript' or id == 'deno' or id == 'rust', 'Unknown built-in language adapter')
  if not adapters[id] then
    adapters[id] = dofile(vim.fs.joinpath(base, 'language-packs', id, 'adapter.lua'))
  end
  return adapters[id]
end

local function stop(state)
  vim.lsp.enable(state.pack.serverName, false)
  for _, client in ipairs(vim.lsp.get_clients({name=state.pack.serverName})) do client:stop(true) end
  -- Assignment replaces the config; merging would retain removed settings and old callbacks.
  vim.lsp.config[state.pack.serverName] = {}
  if state.pack.adapter == 'deno' then pcall(api.nvim_del_augroup_by_name, 'NidoDeno') end
  if state.pack.adapter == 'rust' then pcall(api.nvim_del_augroup_by_name, 'NidoRustPack') end
end

function M.apply(config)
  local wanted = {}
  for _, pack in ipairs(config.packs or {}) do
    wanted[pack.id] = {pack=pack, enabled=not vim.tbl_contains(config.disabled or {}, pack.id)}
  end
  for id, state in pairs(states) do
    local next = wanted[id]
    if not next or not vim.deep_equal(state.pack, next.pack) or state.enabled ~= next.enabled
        or (state.enabled and (state.status == 'missing' or state.status == 'error')) then
      states[id] = nil
      stop(state)
    end
  end
  for _, pack in ipairs(config.packs or {}) do
    if not states[pack.id] then
      local state = wanted[pack.id]
      states[pack.id] = state
      state.status = state.enabled and 'ready' or 'disabled'
      if state.enabled then
        local ok, available = pcall(function()
          if pack.adapter then return M.adapter(pack.adapter).setup() end
          local platform = vim.fn.has('win32') == 1 and 'win32' or 'linux'
          local command = vim.deepcopy((pack.commands or {})[platform] or pack.command)
          if not command then error('No command configured for ' .. platform) end
          local node = false
          for index, arg in ipairs(command) do
            if arg:find('${node}', 1, true) then node = true end
            command[index] = arg:gsub('%${node}', function() return vim.env.NIDO_NODE or 'node' end)
          end
          if vim.fn.executable(command[1]) == 0 then
            state.message = command[1] .. ' is not installed or is not on PATH.'
            return false
          end
          vim.lsp.config(pack.serverName, {
            cmd=command, filetypes=pack.filetypes, settings=pack.settings,
            cmd_env=node and {
              ELECTRON_RUN_AS_NODE='1',
              NODE_OPTIONS=(vim.env.NODE_OPTIONS or '') .. ' --require "' .. vim.fs.joinpath(base, 'hide-console.cjs') .. '"',
            } or nil,
            init_options=pack.initOptions,
            root_dir=function(buffer, on_dir)
              local root
              if pack.rootMarkers then root = vim.fs.root(buffer, pack.rootMarkers) else root = vim.fn.getcwd() end
              if root then on_dir(root) end
            end,
          })
          vim.lsp.enable(pack.serverName)
          return true
        end)
        if not ok then
          state.status, state.message = 'error', tostring(available)
        elseif available == false then
          state.status = 'missing'
          state.message = state.message or pack.setup or 'Required language tools are not installed.'
        else
          local server = vim.lsp.config[pack.serverName]
          local on_exit, on_error = server.on_exit, server.on_error
          vim.lsp.config(pack.serverName, {
            on_exit=function(code, signal, client_id)
              if states[pack.id] == state and state.enabled and (code ~= 0 or signal ~= 0) then
                state.status, state.message = 'error', ('Language server exited (%s, %s).'):format(code, signal)
              end
              if on_exit then on_exit(code, signal, client_id) end
            end,
            on_error=function(code, err)
              if states[pack.id] == state then state.status, state.message = 'error', tostring(err) end
              if on_error then on_error(code, err) end
            end,
          })
        end
      end
    end
  end
end

function M.snapshot()
  local result = {}
  for id, state in pairs(states) do
    local status = state.status
    if status == 'ready' then
      for _, client in ipairs(vim.lsp.get_clients({name=state.pack.serverName})) do
        if not client:is_stopped() then status = client.initialized and 'running' or 'starting' end
      end
    end
    result[#result + 1] = {id=id, status=status, message=state.message}
  end
  return result
end

function M.setup()
  local ok, config = pcall(vim.json.decode, vim.env.NIDO_LANGUAGE_PACK_CONFIG or '{}')
  if ok then M.apply(config) else vim.notify('Invalid language pack configuration: ' .. tostring(config), vim.log.levels.ERROR) end
end

return M
