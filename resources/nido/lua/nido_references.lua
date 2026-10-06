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
        if #items == 0 and state.error == '' then
          vim.notify('No references found at the cursor.', vim.log.levels.INFO, {title = 'References'})
        end
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
  local lines = vim.api.nvim_buf_get_lines(buffer, first - 1, math.min(line + 8, vim.api.nvim_buf_line_count(buffer)), false)
  return { first = first, line = line, lines = M.highlight(buffer, first, lines) }
end

function M.highlight_text(lines, language)
  local buffer = vim.api.nvim_create_buf(false, true)
  local ok, spans = pcall(function()
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    return vim.api.nvim_buf_call(buffer, function()
      -- Syntax only: previews must not start language servers or FileType plugins.
      if language and language:match('^[%w_]+$') then
        vim.bo[buffer].syntax = language
      end
      vim.cmd('syntax sync fromstart')
      return M.highlight(buffer, 1, lines, true)
    end)
  end)
  vim.api.nvim_buf_delete(buffer, {force=true})
  if not ok then
    error(spans)
  end
  return spans
end

function M.highlight(buffer, first, lines, syntax_only)
  local colors = {}
  local function color(group)
    if colors[group] == nil then
      local attrs = vim.api.nvim_get_hl(0, { name = group, link = false, create = false })
      -- Unpainted language-specific captures may not have a highlight ID yet.
      local parent = group:sub(1, 1) == '@' and group:match('^(.*)%.[^.]+$')
      colors[group] = attrs.fg and string.format('#%06x', attrs.fg)
        or (next(attrs) == nil and parent and color(parent)) or false
    end
    return colors[group]
  end
  local highlighted = {}
  for offset, text in ipairs(lines) do
    local spans = {}
    local column = 0
    -- Inspect byte positions, but never split a UTF-8 character in the response.
    for character in text:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
      -- Scratch previews have no LSP tokens; avoid the full inspector for every character.
      local groups = syntax_only and {
        syntax = {{hl_group = vim.fn.synIDattr(vim.fn.synID(first + offset - 1, column + 1, true), 'name')}},
        treesitter = {}, semantic_tokens = {},
      } or vim.inspect_pos(buffer, first + offset - 2, column, { extmarks = false })
      local foreground = color('Normal') or '#d4d4d4'
      local priority = -1
      local function apply(group, rank)
        local value = color(group)
        if value and rank >= priority then
          foreground = value
          priority = rank
        end
      end
      for _, group in ipairs(groups.syntax) do
        apply(group.hl_group, vim.hl.priorities.syntax)
      end
      for _, group in ipairs(groups.treesitter) do
        apply(group.hl_group, tonumber(group.metadata.priority) or vim.hl.priorities.treesitter)
      end
      for _, group in ipairs(groups.semantic_tokens) do
        apply(group.opts.hl_group, group.opts.priority)
      end
      if not syntax_only then
        -- Offscreen rows have token data even when Neovim has not painted their extmarks.
        local row = first + offset - 2
        local filetype = vim.bo[buffer].filetype
        for _, token in ipairs(vim.lsp.semantic_tokens.get_at_pos(buffer, row, column) or {}) do
          apply('@lsp.type.' .. token.type .. '.' .. filetype, vim.hl.priorities.semantic_tokens)
          for modifier in pairs(token.modifiers) do
            apply('@lsp.mod.' .. modifier .. '.' .. filetype, vim.hl.priorities.semantic_tokens + 1)
            apply('@lsp.typemod.' .. token.type .. '.' .. modifier .. '.' .. filetype,
              vim.hl.priorities.semantic_tokens + 2)
          end
        end
      end
      local previous = spans[#spans]
      if previous and previous.color == foreground then
        previous.text = previous.text .. character
      else
        table.insert(spans, { text = character, color = foreground })
      end
      column = column + #character
    end
    if #spans == 0 then
      spans = { { text = '', color = color('Normal') or '#d4d4d4' } }
    end
    table.insert(highlighted, spans)
  end
  return highlighted
end

function M.open(index, expected_version)
  local item = get_item(index, expected_version)
  vim.cmd("normal! m'")
  require('nido_eol').open(item.filename)
  local line = math.min(item.lnum, vim.api.nvim_buf_line_count(0))
  local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)[1] or ''
  vim.api.nvim_win_set_cursor(0, { line, math.min(item.col - 1, #text) })
  vim.cmd('normal! zv')
  require('nido_scroll').center()
end

return M
