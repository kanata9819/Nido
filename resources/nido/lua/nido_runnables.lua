local M = {}
vim.api.nvim_set_hl(0, 'NidoCodeLens', {fg='#808080'})
vim.api.nvim_set_hl(0, 'NidoCodeLensHint', {fg='#606060'})

local function request(buffer, callback, attempt)
  local client = vim.lsp.get_clients({bufnr=buffer, name='rust_analyzer'})[1]
  if not client then
    callback('Rust language support is not ready')
    return
  end
  client:request('experimental/runnables', {
    textDocument={uri=vim.uri_from_bufnr(buffer)}, position=vim.NIL,
  }, function(err, result)
    if err and (err.code == -32801 or err.code == -32802 or err.code == -32800) and (attempt or 0) < 3 then
      vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(buffer) then
          request(buffer, callback, (attempt or 0)+1)
        end
      end, 200)
      return
    end
    callback(err and err.message, result or {})
  end, buffer)
end

function M.execute(debug)
  local buffer = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local tick = vim.api.nvim_buf_get_changedtick(buffer)
  local function execute(err, items)
    if err then
      vim.notify(err, vim.log.levels.WARN)
      return
    end
    if not vim.api.nvim_buf_is_valid(buffer) or vim.api.nvim_buf_get_changedtick(buffer) ~= tick then
      vim.notify('Code changed; try running again.', vim.log.levels.WARN)
      return
    end
    local selected, size
    for _, item in ipairs(items) do
      local range = item.location and item.location.targetRange
      if item.kind == 'cargo' and range and cursor[1]-1 >= range.start.line
        and cursor[1]-1 <= range['end'].line then
        local length = range['end'].line - range.start.line
        if not size or length < size then
          selected=item
          size=length
        end
      end
    end
    if not selected then
      vim.notify('Place the cursor inside main, a test or a test module.', vim.log.levels.INFO)
      return
    end
    local ok, message = pcall(require('nido_debug').runnable, selected, debug, vim.g.nido_channel)
    if not ok then
      vim.notify(tostring(message), vim.log.levels.ERROR)
    end
  end
  -- Fetch targets only when invoked; analysis must not add rows or reposition the viewport.
  request(buffer, execute)
end
return M
