local M = {}
local generation = 0

local function highlight_blocks(markdown)
  local blocks, lines, language = {}, nil, nil
  local aliases = {ts='typescript', tsx='typescriptreact', js='javascript', jsx='javascriptreact', rs='rust'}
  for _, line in ipairs(vim.split(markdown, '\n', {plain=true})) do
    if lines then
      if line:match('^```%s*$') then
        local ok, spans = pcall(require('nido_references').highlight_text, lines, aliases[language] or language)
        blocks[#blocks + 1] = ok and spans or {}
        lines = nil
      else
        lines[#lines + 1] = line
      end
    elseif line:match('^```') then
      language = vim.trim(line:sub(4))
      if language == '' then language = vim.bo.filetype end
      lines = {}
    end
  end
  return blocks
end

local function send(markdown)
  if vim.g.nido_channel then
    vim.rpcnotify(vim.g.nido_channel, 'nido:hover', markdown, vim.bo.filetype, highlight_blocks(markdown))
  end
end

vim.api.nvim_create_autocmd({'CursorMoved', 'InsertEnter', 'BufLeave'}, {
  callback = function()
    generation = generation + 1
    send('')
  end,
})

function M.show()
  generation = generation + 1
  local request = generation
  local buf, win = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
  local cursor = vim.api.nvim_win_get_cursor(win)
  if #vim.lsp.get_clients({bufnr=buf, method='textDocument/hover'}) == 0 then
    send('Type information is unavailable: no language server is attached to this file.')
    return
  end
  vim.lsp.buf_request_all(buf, 'textDocument/hover', function(client)
    return vim.lsp.util.make_position_params(win, client.offset_encoding)
  end, function(results)
    if request ~= generation or vim.api.nvim_get_current_buf() ~= buf
      or vim.api.nvim_get_current_win() ~= win
      or not vim.deep_equal(cursor, vim.api.nvim_win_get_cursor(win)) then return end
    local lines, errors = {}, {}
    for _, response in pairs(results) do
      if response.err then
        errors[#errors + 1] = response.err.message or 'Language server request failed.'
      elseif response.result and response.result.contents then
        if #lines > 0 then lines[#lines + 1] = '' end
        vim.list_extend(lines, vim.lsp.util.convert_input_to_markdown_lines(response.result.contents))
      end
    end
    local markdown = table.concat(lines, '\n')
    if vim.trim(markdown) == '' then
      markdown = #errors > 0 and table.concat(errors, '\n') or 'No type information at this position.'
    end
    send(markdown)
  end)
end

return M
