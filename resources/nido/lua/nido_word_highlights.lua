local api = vim.api
local generation = 0
local cancel
local highlighted_buffer
local text_match
local timer = vim.uv.new_timer()
timer:unref()
local stopped = false

local function clear()
  generation = generation + 1
  if not stopped then timer:stop() end
  if cancel then cancel(); cancel = nil end
  if highlighted_buffer and api.nvim_buf_is_valid(highlighted_buffer) then
    vim.lsp.util.buf_clear_references(highlighted_buffer)
  end
  highlighted_buffer = nil
  if text_match and api.nvim_win_is_valid(text_match.window) then
    vim.fn.matchdelete(text_match.id, text_match.window)
  end
  text_match = nil
end

local function refresh()
  if stopped then return end
  clear()
  local buffer, window = api.nvim_get_current_buf(), api.nvim_get_current_win()
  if vim.bo[buffer].buftype ~= '' or not vim.fn.mode():match('^[niR]') then return end
  -- shortcut: skip buffers over 1 MiB; use indexed matching if large-file highlighting is needed.
  if api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then return end
  local cursor = api.nvim_win_get_cursor(window)
  local line = api.nvim_get_current_line()
  if line:find('\0', 1, true) then return end
  local character = vim.fn.matchstr(line:sub(cursor[2] + 1), '^.')
  if character == '' or vim.fn.match(character, [[\k]]) < 0 then return end
  local word = vim.fn.expand('<cword>')
  local tick, ticket = api.nvim_buf_get_changedtick(buffer), generation
  timer:start(250, 0, vim.schedule_wrap(function()
    if ticket ~= generation or not api.nvim_buf_is_valid(buffer)
        or api.nvim_get_current_buf() ~= buffer or api.nvim_get_current_win() ~= window
        or api.nvim_buf_get_changedtick(buffer) ~= tick
        or not vim.deep_equal(cursor, api.nvim_win_get_cursor(window)) then return end
    if #vim.lsp.get_clients({bufnr=buffer, method='textDocument/documentHighlight'}) == 0 then
      local id = vim.fn.matchadd('LspReferenceText', [[\C\V\<]] .. vim.fn.escape(word, [[\]]) .. [[\>]], 0)
      text_match = {window=window, id=id}
      return
    end
    highlighted_buffer = buffer
    cancel = vim.lsp.buf_request_all(buffer, 'textDocument/documentHighlight', function(client)
      return vim.lsp.util.make_position_params(window, client.offset_encoding)
    end, function(results)
      if ticket ~= generation or not api.nvim_buf_is_valid(buffer)
          or api.nvim_get_current_buf() ~= buffer or api.nvim_get_current_win() ~= window
          or api.nvim_buf_get_changedtick(buffer) ~= tick
          or not vim.deep_equal(cursor, api.nvim_win_get_cursor(window)) then return end
      for id, response in pairs(results) do
        local client = vim.lsp.get_client_by_id(id)
        if client and not response.err and response.result then
          vim.lsp.util.buf_highlight_references(buffer, response.result, client.offset_encoding)
        end
      end
    end)
  end))
end

local function set_colors()
  api.nvim_set_hl(0, 'LspReferenceText', {bg='#ffffff', blend=88})
  api.nvim_set_hl(0, 'LspReferenceRead', {bg='#ffffff', blend=88})
  api.nvim_set_hl(0, 'LspReferenceWrite', {bg='#ffffff', blend=80})
end
set_colors()
api.nvim_create_autocmd('ColorScheme', {callback=set_colors})
api.nvim_create_autocmd({
  'CursorMoved', 'CursorMovedI', 'BufEnter', 'TextChanged', 'TextChangedI', 'TextChangedP',
  'ModeChanged', 'LspAttach', 'LspDetach', 'FocusGained',
}, {callback=refresh})
api.nvim_create_autocmd({'BufLeave', 'WinLeave', 'FocusLost'}, {callback=clear})
api.nvim_create_autocmd('VimLeavePre', {callback=function()
  if stopped then return end
  clear()
  stopped = true
  timer:close()
end})
