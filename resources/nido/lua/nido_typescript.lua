local M = {}

local function json(path)
  if vim.fn.filereadable(path) == 0 then
    return nil
  end
  return vim.json.decode(table.concat(vim.fn.readfile(path), '\n'))
end

function M.setup()
  local path = vim.env.NIDO_LSP_CONFIG or vim.fs.joinpath(vim.fn.stdpath('config'), 'lsp.json')
  local ok, settings = pcall(json, path)
  if not ok then
    error('Invalid LSP configuration: ' .. path .. '\n' .. tostring(settings))
  end
  local option = (settings or {}).typescript or {}
  local mode = option.server or 'auto'
  assert(vim.tbl_contains({'auto', 'native', 'legacy'}, mode), 'typescript.server must be auto, native or legacy')
  local modules = vim.fs.joinpath(vim.env.NIDO_LANGUAGES, 'node_modules')
  local node = vim.env.NIDO_NODE
  local preload = vim.fs.joinpath(vim.env.NIDO_LANGUAGES, '..', 'nido', 'hide-console.cjs')
  local environment = {
    ELECTRON_RUN_AS_NODE='1',
    NODE_OPTIONS=(vim.env.NODE_OPTIONS or '') .. ' --require "' .. preload .. '"',
  }
  local command, tsserver
  if option.command then
    assert(vim.islist(option.command) and #option.command > 0, 'typescript.command must be an argument array')
    for _, arg in ipairs(option.command) do
      assert(type(arg) == 'string' and arg ~= '' and not arg:find('\0'), 'Invalid LSP command argument')
    end
    command = option.command
  else
    -- Read package metadata rather than depending on a version-specific native binary layout.
    local root = vim.fn.getcwd()
    while root do
      for _, name in ipairs({'typescript', '@typescript/native-preview'}) do
        local directory = vim.fs.joinpath(root, 'node_modules', name)
        local package = json(vim.fs.joinpath(directory, 'package.json'))
        if package then
          local major = tonumber((package.version or ''):match('^(%d+)')) or 0
          if major >= 7 and mode ~= 'legacy' then
            local bin = type(package.bin) == 'table' and (package.bin.tsc or package.bin.tsgo) or package.bin
            assert(type(bin) == 'string', 'TypeScript native package has no CLI entry point')
            command = {node, vim.fs.joinpath(directory, bin), '--lsp', '--stdio'}
            break
          elseif name == 'typescript' and major < 7 and mode ~= 'native' then
            tsserver = vim.fs.joinpath(directory, 'lib', 'tsserver.js')
            break
          end
        end
      end
      if command or tsserver then
        break
      end
      local parent = vim.fs.dirname(root)
      if parent == root then
        break
      end
      root = parent
    end
    if not command and not tsserver and mode ~= 'legacy' then
      for _, bin in ipairs({'tsc', 'tsgo'}) do
        if vim.fn.executable(bin) == 1 then
          local result = vim.system({bin, '--version'}, {text=true, env=environment}):wait(2000)
          local major = tonumber((result.stdout or ''):match('(%d+)%.')) or 0
          if result.code == 0 and major >= 7 then
            command = {bin, '--lsp', '--stdio'}
            break
          end
        end
      end
    end
    assert(command or mode ~= 'native', 'TS7 LSP not found. Install TypeScript 7 in the project or set typescript.command in ' .. path)
  end
  local native = command ~= nil and mode ~= 'legacy'
  vim.lsp.config('typescript', {
    cmd = command or {node, vim.fs.joinpath(modules, 'typescript-language-server/lib/cli.mjs'), '--stdio'},
    cmd_env = environment,
    filetypes = {'typescript', 'typescriptreact', 'javascript', 'javascriptreact'},
    root_dir = vim.fn.getcwd(),
    init_options = not native and {
      hostInfo='Nido', disableAutomaticTypingAcquisition=true,
      tsserver={path=tsserver or vim.fs.joinpath(modules, 'typescript/lib/tsserver.js')},
    } or nil,
  })
  vim.lsp.enable('typescript')
end

return M
