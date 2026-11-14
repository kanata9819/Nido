-- Lets language servers hear about files changed outside the editor (through git, a
-- formatter or another tool), so their diagnostics do not keep reporting errors that no
-- longer exist.

--- Pull diagnostics again for every buffer the client is attached to.
local function pull_diagnostics(client)
  if not client:supports_method('textDocument/diagnostic') then
    return
  end
  for buffer in pairs(client.attached_buffers) do
    if vim.api.nvim_buf_is_loaded(buffer) then
      client:request('textDocument/diagnostic', {
        textDocument = vim.lsp.util.make_text_document_params(buffer),
      }, nil, buffer)
    end
  end
end

-- Neovim pulls a buffer's diagnostics only when that buffer changes. After a file changed on
-- disk, the other open files can have new errors or lose old ones, so pull theirs too. The
-- TypeScript 7 server does not ask for this itself.
vim.api.nvim_create_autocmd('LspNotify', {
  callback = function(event)
    if event.data.method == 'workspace/didChangeWatchedFiles' then
      local client = vim.lsp.get_client_by_id(event.data.client_id)
      if client then
        pull_diagnostics(client)
      end
    end
  end,
})

-- A server can also ask for diagnostics to be pulled again. Neovim 0.11 has no handler for
-- that request yet.
vim.lsp.handlers['workspace/diagnostic/refresh'] = vim.lsp.handlers['workspace/diagnostic/refresh']
  or function(_, _, ctx)
    local client = vim.lsp.get_client_by_id(ctx.client_id)
    if client then
      pull_diagnostics(client)
    end
    return vim.NIL
  end

-- Servers ask the client to watch files with workspace/didChangeWatchedFiles. Neovim matches
-- each change, as a normalized path such as C:/Users/me/project/src/a.ts, against the
-- server's glob patterns, letter case included. Windows paths ignore case, and the TypeScript 7
-- server registers patterns such as c:/users/me/project/**/*, so on Windows nothing matched
-- and the server never learned that a file changed. An absolute pattern inside a workspace
-- folder gets that folder's path spelled the way Neovim reports changes.
if vim.fn.has('win32') == 0 then
  return
end

local watchfiles = require('vim.lsp._watchfiles')
local register = watchfiles.register

--- A path compared the way Windows does: forward slashes and any letter case.
local function comparable(path)
  return (path:gsub('\\', '/'):lower())
end

--- The watcher, with an absolute glob inside one of `folders` respelled to match changes.
local function respell(watcher, folders)
  local pattern = watcher.globPattern
  if type(pattern) ~= 'string' then
    return watcher
  end
  local glob = comparable(pattern)
  for _, folder in ipairs(folders) do
    local base = vim.fs.normalize(vim.uri_to_fname(folder.uri)):gsub('/$', '') .. '/'
    if glob:sub(1, #base) == comparable(base) then
      return vim.tbl_extend('force', watcher, { globPattern = base .. pattern:sub(#base + 1) })
    end
  end
  return watcher
end

watchfiles.register = function(reg, client_id)
  local client = vim.lsp.get_client_by_id(client_id)
  local options = reg.registerOptions
  if client and client.workspace_folders and options and options.watchers then
    local watchers = vim.tbl_map(function(watcher)
      return respell(watcher, client.workspace_folders)
    end, options.watchers)
    reg = vim.tbl_extend('force', reg, {
      registerOptions = vim.tbl_extend('force', options, { watchers = watchers }),
    })
  end
  return register(reg, client_id)
end
