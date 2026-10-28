local api = vim.api
local generation = 0
local cancel
local highlighted
local text_match
local namespace = api.nvim_create_namespace('nvim.lsp.references')
local timer = vim.uv.new_timer()
timer:unref()
local stopped = false

local function invalidate()
  generation = generation + 1
  if not stopped then timer:stop() end
  if cancel then cancel(); cancel = nil end
end

local function clear_highlights()
  if highlighted and api.nvim_buf_is_valid(highlighted.buffer) then
    vim.lsp.util.buf_clear_references(highlighted.buffer)
  end
  highlighted = nil
  if text_match and api.nvim_win_is_valid(text_match.window) then
    vim.fn.matchdelete(text_match.id, text_match.window)
  end
  text_match = nil
end

local function clear()
  invalidate()
  clear_highlights()
end

local function refresh()
  if stopped then return end
  -- Scrolling moves Neovim's cursor for the viewport; keep the editing anchor's references.
  if require('nido_scroll').cursor() then invalidate(); return end
  local buffer, window = api.nvim_get_current_buf(), api.nvim_get_current_win()
  if vim.bo[buffer].buftype ~= '' or not vim.fn.mode():match('^[niR]') then clear(); return end
  -- shortcut: skip buffers over 1 MiB; use indexed matching if large-file highlighting is needed.
  if api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then clear(); return end
  local cursor = api.nvim_win_get_cursor(window)
  local line = api.nvim_get_current_line()
  if line:find('\0', 1, true) then clear(); return end
  local character = vim.fn.matchstr(line:sub(cursor[2] + 1), '^.')
  if character == '' or vim.fn.match(character, [[\k]]) < 0 then clear(); return end
  local word = vim.fn.expand('<cword>')
  local keep = text_match and text_match.buffer == buffer and text_match.window == window and text_match.word == word
  if highlighted and highlighted.buffer == buffer and highlighted.window == window and highlighted.word == word then
    local position = {cursor[1] - 1, cursor[2]}
    -- Only an existing semantic occurrence can preserve its highlight; equal names may be shadowed.
    for _, mark in ipairs(api.nvim_buf_get_extmarks(buffer, namespace, position, position, {details=true, overlap=true})) do
      if not mark[4].invalid and mark[2] == position[1] and mark[4].end_row == position[1]
          and mark[3] <= position[2] and mark[4].end_col > position[2] then
        keep = true
        break
      end
    end
  end
  if keep then invalidate() else clear() end
  local tick, ticket = api.nvim_buf_get_changedtick(buffer), generation
  timer:start(250, 0, vim.schedule_wrap(function()
    if ticket ~= generation or not api.nvim_buf_is_valid(buffer)
        or api.nvim_get_current_buf() ~= buffer or api.nvim_get_current_win() ~= window
        or api.nvim_buf_get_changedtick(buffer) ~= tick
        or not vim.deep_equal(cursor, api.nvim_win_get_cursor(window)) then return end
    if #vim.lsp.get_clients({bufnr=buffer, method='textDocument/documentHighlight'}) == 0 then
      if text_match then return end
      clear_highlights()
      local id = vim.fn.matchadd('LspReferenceText', [[\C\V\<]] .. vim.fn.escape(word, [[\]]) .. [[\>]], 0)
      text_match = {buffer=buffer, window=window, word=word, id=id}
      return
    end
    cancel = vim.lsp.buf_request_all(buffer, 'textDocument/documentHighlight', function(client)
      return vim.lsp.util.make_position_params(window, client.offset_encoding)
    end, function(results)
      if ticket ~= generation or not api.nvim_buf_is_valid(buffer)
          or api.nvim_get_current_buf() ~= buffer or api.nvim_get_current_win() ~= window
          or api.nvim_buf_get_changedtick(buffer) ~= tick
          or not vim.deep_equal(cursor, api.nvim_win_get_cursor(window)) then return end
      clear_highlights()
      highlighted = {buffer=buffer, window=window, word=word}
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
api.nvim_create_autocmd('User', {pattern='NidoScroll', callback=refresh})
api.nvim_create_autocmd({'BufLeave', 'WinLeave', 'FocusLost'}, {callback=clear})
api.nvim_create_autocmd('VimLeavePre', {callback=function()
  if stopped then return end
  clear()
  stopped = true
  timer:close()
end})
