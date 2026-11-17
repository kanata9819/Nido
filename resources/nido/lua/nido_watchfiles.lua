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

-- On Linux, which is where Neovim runs for a WSL workspace, Neovim does not offer to watch
-- files at all: its backends there either need inotifywait or walk the whole tree at once,
-- blocking the editor in a large project. Without watching, a server never hears about files
-- changed by git, a formatter or another tool, and its diagnostics keep old errors. Nido
-- offers watching there with a lighter watcher of its own.
if vim.fn.has('win32') == 0 and vim.fn.has('mac') == 0 then
  local uv = vim.uv
  -- Folders that are never watched: dependencies, build output and Git's own files, as text
  -- search skips them. Symbolic links are not followed.
  local skipped = {
    ['.git'] = true, node_modules = true, dist = true, out = true, build = true,
    target = true, ['.next'] = true, ['.venv'] = true, __pycache__ = true,
  }
  -- inotify watches are a per-user resource; leave plenty for other programs.
  local max_directories = 4000

  --- Watch `root` and the folders below it with one fs_event per folder. Folders are found
  --- asynchronously, a few at a time, so starting never blocks the editor. Calls
  --- `callback(path, change)` from a fast event, as vim._watch's watchers do.
  local function watch(root, opts, callback)
    opts = opts or {}
    local watch_module = require('vim._watch')
    local debounce = opts.debounce or 500
    local handles, count, closed = {}, 0, false
    local changes = {}
    local timer = assert(uv.new_timer())

    local function excluded(path)
      return opts.exclude_pattern ~= nil and opts.exclude_pattern:match(path) ~= nil
    end

    local add

    --- Report the changes collected since the last report: a path that still exists was
    --- changed (or created, if only its folder reported it), one that does not was deleted.
    local function report()
      local batch = changes
      changes = {}
      for path, changed in pairs(batch) do
        uv.fs_stat(path, function(_, stat)
          if closed then
            return
          end
          local change
          if stat then
            change = changed and watch_module.FileChangeType.Changed
              or watch_module.FileChangeType.Created
            if stat.type == 'directory' then
              add(path)
            end
          else
            change = watch_module.FileChangeType.Deleted
            local prefix = path .. '/'
            for watched, handle in pairs(handles) do
              if watched == path or watched:sub(1, #prefix) == prefix then
                if not handle:is_closing() then
                  handle:close()
                end
                handles[watched] = nil
                count = count - 1
              end
            end
          end
          callback(path, change)
        end)
      end
    end

    --- Watch `directory`, then the folders inside it.
    add = function(directory)
      if closed or handles[directory] or count >= max_directories then
        return
      end
      local handle = uv.new_fs_event()
      if not handle then
        return
      end
      local ok = handle:start(directory, {}, function(err, name, events)
        if err or closed or not name then
          return
        end
        local path = directory .. '/' .. name
        if excluded(path) then
          return
        end
        if changes[path] == nil then
          changes[path] = events.change or false
        end
        timer:start(debounce, 0, report)
      end)
      if not ok then
        handle:close()
        return
      end
      handles[directory] = handle
      count = count + 1
      uv.fs_scandir(directory, function(err, request)
        if err or closed then
          return
        end
        while true do
          local name, kind = uv.fs_scandir_next(request)
          if not name then
            break
          end
          local path = directory .. '/' .. name
          if kind == 'directory' and not skipped[name] and not excluded(path) then
            add(path)
          end
        end
      end)
    end

    add((root:gsub('/$', '')))
    return function()
      closed = true
      for path, handle in pairs(handles) do
        if not handle:is_closing() then
          handle:close()
        end
        handles[path] = nil
      end
      timer:stop()
      if not timer:is_closing() then
        timer:close()
      end
    end
  end

  require('vim.lsp._watchfiles')._watchfunc = watch
  vim.lsp.config('*', {
    capabilities = { workspace = { didChangeWatchedFiles = { dynamicRegistration = true } } },
  })
  return
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
