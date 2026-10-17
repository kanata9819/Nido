local M = {}
local api = vim.api
local filetypes = {'typescript', 'typescriptreact', 'javascript', 'javascriptreact'}

function M.root(buffer)
  local root = vim.fs.root(buffer, {{'deno.json', 'deno.jsonc', 'deno.lock'}})
  local node = vim.fs.root(buffer, {{'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'}})
  if root and (not node or #root >= #node) then return root end
end

function M.setup()
  local group = api.nvim_create_augroup('NidoDeno', {clear=true})
  local command = vim.fn.exepath('deno')
  if command == '' then
    local install = vim.env.DENO_INSTALL or vim.fs.joinpath(vim.fn.expand('~'), '.deno')
    local candidate = vim.fs.joinpath(install, 'bin', vim.fn.has('win32') == 1 and 'deno.exe' or 'deno')
    if vim.fn.executable(candidate) == 1 then command = candidate end
  end
  if command == '' then
    vim.lsp.enable('denols', false)
    local warned = false
    api.nvim_create_autocmd('FileType', {group=group, pattern=filetypes, callback=function(event)
      if not warned and M.root(event.buf) then
        warned = true
        vim.notify('Deno language support needs Deno. Install it, then reopen this workspace.', vim.log.levels.WARN)
      end
    end})
    return false
  end
  vim.lsp.config('denols', {
    cmd = {command, 'lsp'},
    cmd_env = {NO_COLOR='1'},
    filetypes = filetypes,
    -- Nido loads deno: documents; Deno otherwise rewrites them to disk files for Neovim.
    before_init = function(params) params.clientInfo.name = 'Nido' end,
    root_dir = function(buffer, on_dir)
      local root = M.root(buffer)
      if root then on_dir(root) end
    end,
    -- Neovim's pull diagnostics do not refresh after dependency caching.
    init_options = {enable=true, lint=true, forcePushBasedDiagnostics=true},
    settings = {deno={enable=true, lint=true}},
  })
  vim.lsp.enable('denols')
  -- Deno exposes cached dependencies and built-in types through virtual documents.
  api.nvim_create_autocmd('BufReadCmd', {group=group, pattern='deno:*', callback=function(event)
    local client = assert(vim.lsp.get_clients({name='denols'})[1], 'Deno language server is not running.')
    local response, err = client:request_sync('deno/virtualTextDocument', {
      textDocument={uri=event.match},
    }, 10000, event.buf)
    assert(response and not response.err and type(response.result) == 'string', vim.inspect(err or response))
    vim.bo[event.buf].modifiable = true
    api.nvim_buf_set_lines(event.buf, 0, -1, false, vim.split(response.result, '\n', {plain=true}))
    vim.bo[event.buf].buftype = 'nofile'
    vim.bo[event.buf].swapfile = false
    vim.bo[event.buf].filetype = vim.filetype.match({filename=event.match}) or 'typescript'
    vim.bo[event.buf].readonly = true
    vim.bo[event.buf].modified = false
    vim.bo[event.buf].modifiable = false
    vim.lsp.buf_attach_client(event.buf, client.id)
  end})
  return true
end

return M
