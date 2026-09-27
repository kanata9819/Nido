local M = {}
local version = 0
local items = {}

local function publish(state)
  vim.rpcnotify(vim.g.nido_channel, 'nido:references', state)
end

function M.find()
  version = version + 1
  local current = version
  local buffer = vim.api.nvim_get_current_buf()
  local clients = vim.lsp.get_clients({ bufnr = buffer, method = 'textDocument/references' })
  local state = { version = current, items = {}, loading = true, error = '' }
  items = {}
  publish(state)
  if #clients == 0 then
    state.loading = false
    state.error = 'No language server supports references for this file.'
    publish(state)
    return
  end

  local remaining = #clients
  local seen = {}
  for _, client in ipairs(clients) do
    local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
    params.context = { includeDeclaration = true }
    local function receive(err, locations)
      if current ~= version then
        return
      end
      if err then
        state.error = err.message or tostring(err)
      else
        for _, item in ipairs(vim.lsp.util.locations_to_items(locations or {}, client.offset_encoding)) do
          local key = item.filename .. ':' .. item.lnum .. ':' .. item.col
          if not seen[key] then
            seen[key] = true
            table.insert(items, item)
          end
        end
      end
      remaining = remaining - 1
      if remaining == 0 then
        table.sort(items, function(a, b)
          if a.filename ~= b.filename then
            return a.filename < b.filename
          end
          if a.lnum ~= b.lnum then
            return a.lnum < b.lnum
          end
          return a.col < b.col
        end)
        for _, item in ipairs(items) do
          table.insert(state.items, { path = item.filename, line = item.lnum, column = item.col, text = item.text or '' })
        end
        state.loading = false
        publish(state)
      end
    end
    local accepted = client:request('textDocument/references', params, receive, buffer)
    if not accepted then
      receive({ message = 'The language server could not accept the references request.' })
    end
  end
end

local function get_item(index, expected_version)
  assert(expected_version == version, 'References changed. Select a result again.')
  return assert(items[index], 'Reference is no longer available.')
end

function M.preview(index, expected_version)
  local item = get_item(index, expected_version)
  local buffer = vim.fn.bufadd(item.filename)
  vim.fn.bufload(buffer)
  local line = math.min(item.lnum, vim.api.nvim_buf_line_count(buffer))
  local first = math.max(1, line - 8)
  return {
    first = first,
    line = line,
    lines = vim.api.nvim_buf_get_lines(buffer, first - 1, math.min(line + 8, vim.api.nvim_buf_line_count(buffer)), false),
  }
end

function M.open(index, expected_version)
  local item = get_item(index, expected_version)
  vim.cmd("normal! m'")
  vim.cmd.edit(vim.fn.fnameescape(item.filename))
  local line = math.min(item.lnum, vim.api.nvim_buf_line_count(0))
  local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)[1] or ''
  vim.api.nvim_win_set_cursor(0, { line, math.min(item.col - 1, #text) })
  vim.cmd('normal! zvzz')
end

return M
