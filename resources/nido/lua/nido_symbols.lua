local M = {}
local version = 0
local search = 0
local pending = {}
local deadline
local state
local changedtick

local function stop_deadline()
  if deadline and not deadline:is_closing() then deadline:stop(); deadline:close() end
  deadline = nil
end

local function publish()
  vim.rpcnotify(vim.g.nido_channel, 'nido:symbols', state)
end

function M.find()
  search = search + 1
  local current = search
  stop_deadline()
  for _, request in ipairs(pending) do
    if not request.done and request.id then pcall(request.client.cancel_request, request.client, request.id) end
  end
  pending = {}
  version = version + 1
  local request_version = version
  local buffer = vim.api.nvim_get_current_buf()
  changedtick = vim.api.nvim_buf_get_changedtick(buffer)
  local tick = changedtick
  state = {version=version, buffer=buffer, loading=true, error='', items={}}
  publish()
  local clients = vim.lsp.get_clients({bufnr=buffer, method='textDocument/documentSymbol'})
  if #clients == 0 then
    state.loading = false
    state.error = 'No language server supports symbols for this file.'
    publish()
    return request_version
  end
  local uri = vim.uri_from_bufnr(buffer)
  local remaining, seen = #clients, {}
  local function collect(symbols, container, encoding)
    assert(type(symbols) == 'table', 'Invalid symbol list')
    for _, symbol in ipairs(symbols) do
      assert(type(symbol) == 'table' and type(symbol.name) == 'string'
        and (symbol.containerName == nil or type(symbol.containerName) == 'string')
        and type(symbol.kind) == 'number' and symbol.kind == math.floor(symbol.kind), 'Invalid symbol fields')
      if not symbol.location or symbol.location.uri == uri then
        local item = vim.lsp.util.symbols_to_items({{
          name=symbol.name, kind=symbol.kind, selectionRange=symbol.selectionRange, location=symbol.location,
        }}, buffer, encoding)[1]
        if item then
          local lines = vim.api.nvim_buf_line_count(buffer)
          assert(type(item.lnum) == 'number' and item.lnum == math.floor(item.lnum)
            and item.lnum >= 1 and item.lnum <= lines, 'Invalid symbol line')
          local text = vim.api.nvim_buf_get_lines(buffer, item.lnum - 1, item.lnum, false)[1]
          assert(type(item.col) == 'number' and item.col == math.floor(item.col)
            and item.col >= 1 and item.col <= #text + 1, 'Invalid symbol column')
          local key = symbol.name .. ':' .. item.lnum .. ':' .. item.col
          if not seen[key] then
            seen[key] = true
            table.insert(state.items, {name=symbol.name, kind=item.kind,
              container=container ~= '' and container or symbol.containerName or '',
              line=item.lnum, column=item.col})
          end
        end
        if symbol.children then
          collect(symbol.children, container == '' and symbol.name or container .. '.' .. symbol.name, encoding)
        end
      end
    end
  end
  deadline = vim.defer_fn(function()
    if current ~= search then return end
    for _, request in ipairs(pending) do
      if not request.done then
        if request.id then pcall(request.client.cancel_request, request.client, request.id) end
        request.receive({message='The symbol request timed out.'})
      end
    end
  end, 10000)
  for _, client in ipairs(clients) do
    local request = {client=client, done=false}
    table.insert(pending, request)
    local function receive(err, symbols)
      if current ~= search or request.done then return end
      request.done = true
      if not vim.api.nvim_buf_is_valid(buffer) or vim.api.nvim_get_current_buf() ~= buffer
          or vim.api.nvim_buf_get_changedtick(buffer) ~= tick then
        state.items = {}
        state.error = 'The file changed. Reopen symbol search.'
      elseif err then
        state.error = type(err) == 'table' and type(err.message) == 'string' and err.message or tostring(err)
      else
        local ok, message = pcall(collect, symbols or {}, '', client.offset_encoding)
        if not ok then state.error = 'Invalid symbols returned by the language server: ' .. tostring(message) end
      end
      remaining = remaining - 1
      table.sort(state.items, function(a, b)
        if a.line ~= b.line then return a.line < b.line end
        if a.column ~= b.column then return a.column < b.column end
        return a.name < b.name
      end)
      version = version + 1
      state.version = version
      state.loading = remaining > 0
      publish()
      if remaining == 0 then stop_deadline(); pending = {} end
    end
    request.receive = receive
    local accepted, id = client:request('textDocument/documentSymbol', {textDocument={uri=uri}}, receive, buffer)
    request.id = id
    if not accepted then receive({message='The language server could not accept the symbol request.'}) end
  end
  return request_version
end

function M.open(index, expected_version)
  assert(state and expected_version == state.version and not state.loading, 'Symbols changed. Select a result again.')
  assert(vim.api.nvim_buf_is_valid(state.buffer) and vim.api.nvim_get_current_buf() == state.buffer
    and vim.api.nvim_buf_get_changedtick(state.buffer) == changedtick, 'The file changed. Reopen symbol search.')
  local item = assert(state.items[index], 'Symbol is no longer available.')
  require('nido_scroll').restore()
  vim.cmd.stopinsert()
  vim.cmd("normal! m'")
  vim.api.nvim_win_set_cursor(0, {item.line, item.column - 1})
  vim.cmd('normal! zv')
  require('nido_scroll').center()
end

return M
