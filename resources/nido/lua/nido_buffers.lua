-- Nido's tabs: the order of listed buffers, closing and reopening tabs.
local M = {}
-- shortcut: keep 100 closed files in memory, persist if reopening across restarts is needed.
-- `order` is the tab order the user arranged; `closed` holds recently closed files to reopen.
local order, closed = {}, {}
local api = vim.api

--- The saved cursor of a tab whose file has not been displayed since restoration.
function M.cursor(buffer)
  return vim.b[buffer].nido_restore_cursor or api.nvim_buf_get_mark(buffer, '"')
end

-- Background tabs load on first display; apply their saved position once the file is available.
api.nvim_create_autocmd('BufWinEnter', {callback=function(event)
  local position = vim.b[event.buf].nido_restore_cursor
  if position and api.nvim_get_current_buf() == event.buf then
    vim.b[event.buf].nido_restore_cursor = nil
    local line = math.min(position[1], api.nvim_buf_line_count(event.buf))
    api.nvim_win_set_cursor(0, {line, position[2]})
  end
end})

--- The buffer of `path`, or -1 when there is none.
function M.find(path)
  -- bufnr() treats names as patterns; check existence before exact lookup without creating a buffer.
  return vim.fn.bufexists(path) == 1 and vim.fn.bufadd(path) or -1
end

--- The listed buffers in tab order. New buffers join at the end.
function M.list()
  local available, result = {}, {}
  local buffers = api.nvim_list_bufs()
  for _, buffer in ipairs(buffers) do
    if vim.bo[buffer].buflisted then available[buffer] = true end
  end
  for _, buffer in ipairs(order) do
    if available[buffer] then
      table.insert(result, buffer)
      available[buffer] = nil
    end
  end
  for _, buffer in ipairs(buffers) do
    if available[buffer] then table.insert(result, buffer) end
  end
  order = result
  return result
end

--- Move relative to the live file tab in Nido's displayed order, wrapping around.
function M.select_adjacent(offset)
  local buffers = M.list()
  if #buffers == 0 then return end
  local index = vim.fn.index(buffers, api.nvim_get_current_buf())
  if index < 0 and offset < 0 then index = 0 end
  api.nvim_set_current_buf(buffers[(index + offset) % #buffers + 1])
end

--- Restore saved file tabs in order, deferring reads of background files until they are selected.
--- The first successful open can reuse the initial empty buffer, just like an ordinary open.
function M.restoreFiles(files, current)
  local open = require('nido_eol').open
  local failed, last, selected = {}, nil, nil
  for index, file in ipairs(files) do
    if file then
      local path, line, column = unpack(file)
      local visible = not last or path == current
      local ok, result = pcall(function()
        local buffer
        if visible then
          open(path)
          buffer = api.nvim_get_current_buf()
        else
          buffer = vim.fn.bufadd(path)
          vim.bo[buffer].binary = false
          vim.bo[buffer].buflisted = true
        end
        if visible then
          api.nvim_win_set_cursor(0, {math.min(line, api.nvim_buf_line_count(buffer)), column})
        else
          vim.b[buffer].nido_restore_cursor = {line, column}
        end
        return buffer
      end)
      if ok then
        last = result
        if path == current then selected = result end
      else
        failed[#failed + 1] = {index, tostring(result)}
      end
    end
  end
  if not selected and last then api.nvim_set_current_buf(last) end
  return failed
end

--- Move a tab to position `index` (one-based).
function M.place(buffer, index)
  local buffers = M.list()
  local previous = vim.fn.index(buffers, buffer) + 1
  assert(previous > 0, 'Invalid buffer')
  table.remove(buffers, previous)
  table.insert(buffers, math.max(1, math.min(index, #buffers + 1)), buffer)
  api.nvim_exec_autocmds('User', {pattern='NidoBuffers'})
end

--- Move a tab to where tab `target` is.
function M.move(buffer, target)
  local buffers = M.list()
  local index = vim.fn.index(buffers, target) + 1
  assert(index > 0, 'Invalid target buffer')
  M.place(buffer, index)
end

--- Close a tab, remembering the file and cursor so it can be reopened. `force` discards changes.
function M.close(buffer, force)
  if not force and vim.bo[buffer].modified then error('Buffer has unsaved changes.') end
  local name = api.nvim_buf_get_name(buffer)
  local info = name ~= '' and vim.bo[buffer].buftype == '' and vim.uv.fs_stat(name)
  local entry
  if info and info.type == 'file' then
    local position = M.cursor(buffer)
    local wins = vim.fn.win_findbuf(buffer)
    if #wins > 0 then
      position = api.nvim_win_get_cursor(wins[1])
      if wins[1] == api.nvim_get_current_win() then
        position = require('nido_scroll').cursor() or position
      end
    end
    entry = {path=name, position=position, index=vim.fn.index(M.list(), buffer) + 1}
  end
  api.nvim_buf_delete(buffer, {force=force})
  if entry then
    table.insert(closed, entry)
    if #closed > 100 then table.remove(closed, 1) end
  end
end

--- Reopen the most recently closed available file. Keep missing entries for a later retry.
function M.reopen()
  for index = #closed, 1, -1 do
    local entry = closed[index]
    local buffer = M.find(entry.path)
    local loaded = buffer > 0 and api.nvim_buf_is_loaded(buffer)
    local info = not loaded and vim.uv.fs_stat(entry.path)
    if loaded or (info and info.type == 'file') then
      require('nido_scroll').restore()
      if loaded then
        vim.bo[buffer].buflisted = true
        api.nvim_set_current_buf(buffer)
      else
        require('nido_eol').open(entry.path)
        buffer = api.nvim_get_current_buf()
      end
      local line = math.max(1, math.min(entry.position[1], api.nvim_buf_line_count(buffer)))
      local text = api.nvim_buf_get_lines(buffer, line - 1, line, false)[1] or ''
      api.nvim_win_set_cursor(0, {line, math.min(entry.position[2], #text)})
      M.place(buffer, entry.index)
      table.remove(closed, index)
      return
    end
  end
  if #closed > 0 then
    error('File is unavailable: ' .. closed[#closed].path)
  end
end

return M
