local M = {}
local namespace = vim.api.nvim_create_namespace('nido_runnables')
local revisions = {}
local candidates = {}
vim.api.nvim_set_hl(0, 'NidoCodeLens', {fg='#91a1ad'})

local function range_size(item)
  local range = item.location and item.location.targetRange
  return range and range['end'].line-range.start.line or math.huge
end

local function reveal_first_line(buffer)
  if vim.bo[buffer].filetype ~= 'rust' then return end
  for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
    vim.api.nvim_win_call(window, function()
      local view = vim.fn.winsaveview()
      if view.topline == 1 and view.topfill == 0
        and #vim.api.nvim_buf_get_extmarks(buffer, namespace, {0,0}, {0,-1}, {}) > 0 then
        vim.fn.winrestview({topfill=1})
      end
    end)
  end
end

local function request(buffer, callback, attempt)
  local client = vim.lsp.get_clients({bufnr=buffer, name='rust_analyzer'})[1]
  if not client then callback('Rust language support is not ready'); return end
  client:request('experimental/runnables', {
    textDocument={uri=vim.uri_from_bufnr(buffer)}, position=vim.NIL,
  }, function(err, result)
    if err and (err.code == -32801 or err.code == -32802 or err.code == -32800) and (attempt or 0) < 3 then
      vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(buffer) then request(buffer, callback, (attempt or 0)+1) end
      end, 200)
      return
    end
    callback(err and err.message, result or {})
  end, buffer)
end

function M.refresh(buffer)
  if not vim.api.nvim_buf_is_valid(buffer) or vim.bo[buffer].filetype ~= 'rust' then return end
  revisions[buffer] = (revisions[buffer] or 0) + 1
  local revision = revisions[buffer]
  local tick = vim.api.nvim_buf_get_changedtick(buffer)
  request(buffer, function(err, items)
    if err or not vim.api.nvim_buf_is_valid(buffer) or revisions[buffer] ~= revision
      or vim.api.nvim_buf_get_changedtick(buffer) ~= tick then return end
    -- Cargo reloads can temporarily return no candidates for unchanged code.
    if #items == 0 and candidates[buffer] and candidates[buffer].tick == tick then return end
    candidates[buffer] = {tick=tick, items=items}
    vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    table.sort(items, function(a, b)
      return range_size(a) < range_size(b)
    end)
    local rows = {}
    for _, item in ipairs(items) do
      if item.kind == 'cargo' and item.location then
        local row = item.location.targetSelectionRange.start.line
        if not rows[row] then
          rows[row] = true
          local label = item.args.cargoArgs[1] == 'test' and 'Run Tests' or 'Run'
          vim.api.nvim_buf_set_extmark(buffer, namespace, row, 0, {
            virt_lines={{{'  ▶ ' .. label .. ' [gR]  ·  Debug [gD]', 'NidoCodeLens'}}},
            virt_lines_above=true,
          })
        end
      end
    end
    reveal_first_line(buffer)
  end)
end

function M.execute(debug)
  local buffer = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local tick = vim.api.nvim_buf_get_changedtick(buffer)
  local function execute(err, items)
    if err then vim.notify(err, vim.log.levels.WARN); return end
    if not vim.api.nvim_buf_is_valid(buffer) or vim.api.nvim_buf_get_changedtick(buffer) ~= tick then
      vim.notify('Code changed; try running again.', vim.log.levels.WARN); return
    end
    local selected, size
    for _, item in ipairs(items) do
      local range = item.location and item.location.targetRange
      if item.kind == 'cargo' and range and cursor[1]-1 >= range.start.line
        and cursor[1]-1 <= range['end'].line then
        local length = range['end'].line - range.start.line
        if not size or length < size then selected=item; size=length end
      end
    end
    if not selected then
      vim.notify('Place the cursor inside main, a test or a test module.', vim.log.levels.INFO)
      return
    end
    local ok, message = pcall(require('nido_debug').runnable, selected, debug, vim.g.nido_channel)
    if not ok then vim.notify(tostring(message), vim.log.levels.ERROR) end
  end
  -- Execute the commands currently displayed, unless edits made their ranges stale.
  local cached = candidates[buffer]
  if cached and cached.tick == tick then execute(nil, cached.items)
  else request(buffer, execute) end
end

vim.api.nvim_create_autocmd({'LspAttach', 'BufEnter', 'TextChanged', 'TextChangedI'}, {
  callback=function(event)
    local buffer = event.buf
    revisions[buffer] = (revisions[buffer] or 0) + 1
    local revision = revisions[buffer]
    vim.defer_fn(function()
      if revisions[buffer] == revision then M.refresh(buffer) end
    end, 300)
  end,
})
-- Cargo discovery may finish after LspAttach; refresh when the server becomes idle.
vim.api.nvim_create_autocmd('LspProgress', {callback=function(event)
  local value = event.data.params.value
  if type(value) ~= 'table' or value.kind ~= 'end' then return end
  local client = vim.lsp.get_client_by_id(event.data.client_id)
  if client and client.name == 'rust_analyzer' then
    for buffer in pairs(client.attached_buffers) do M.refresh(buffer) end
  end
end})
vim.api.nvim_create_autocmd('LspDetach', {callback=function(event)
  local client = vim.lsp.get_client_by_id(event.data.client_id)
  if client and client.name == 'rust_analyzer' then
    revisions[event.buf] = (revisions[event.buf] or 0) + 1
    candidates[event.buf] = nil
    vim.api.nvim_buf_clear_namespace(event.buf, namespace, 0, -1)
  end
end})
vim.api.nvim_create_autocmd('BufWipeout', {callback=function(event)
  revisions[event.buf]=nil
  candidates[event.buf]=nil
end})
vim.api.nvim_create_autocmd('CursorMoved', {callback=function(event) reveal_first_line(event.buf) end})
return M
