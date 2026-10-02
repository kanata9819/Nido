local api = vim.api
local namespace = api.nvim_create_namespace('nido_brackets')
local colors = { '#FFD700', '#DA70D6', '#179FFF' }
local closing = { [')'] = '(', [']'] = '[', ['}'] = '{' }
local pending = {}

local function ignored(row, column)
  for _, id in ipairs(vim.fn.synstack(row, column)) do
    local name = vim.fn.synIDattr(id, 'name'):lower()
    if name:find('comment') or name:find('string') or name:find('character') then return true end
  end
  return false
end

for right, left in pairs(closing) do
  vim.keymap.set('i', left, function()
    local column = vim.fn.col('.') - 1
    local next = api.nvim_get_current_line():sub(column + 1, column + 1)
    if vim.bo.buftype == '' and not ignored(vim.fn.line('.'), math.max(1, column))
        and (next == '' or next:match('[%s%)%]%}]')) then
      return left .. right .. '<Left>'
    end
    return left
  end, {expr=true})
  vim.keymap.set('i', right, function()
    local column = vim.fn.col('.')
    if vim.bo.buftype == '' and api.nvim_get_current_line():sub(column, column) == right then
      return '<Right>'
    end
    return right
  end, {expr=true})
end
vim.keymap.set('i', '<BS>', function()
  local column = vim.fn.col('.') - 1
  local line = api.nvim_get_current_line()
  if vim.bo.buftype == '' and closing[line:sub(column + 1, column + 1)] == line:sub(column, column) then
    return '<Del><BS>'
  end
  return '<BS>'
end, {expr=true})

vim.keymap.set('i', '<CR>', function()
  local line = api.nvim_get_current_line()
  local column = vim.fn.col('.') - 1
  local before, after = line:sub(1, column), line:sub(column + 1)
  if vim.bo.buftype ~= '' or not before:match('{%s*$') or not after:match('^%s*}')
      or ignored(vim.fn.line('.'), column - #(before:match('%s*$'))) then
    return '<CR>'
  end
  local outer = line:match('^%s*')
  local width = vim.fn.indent('.') + vim.fn.shiftwidth()
  local inner = vim.bo.expandtab and string.rep(' ', width)
      or string.rep('\t', math.floor(width / vim.bo.tabstop)) .. string.rep(' ', width % vim.bo.tabstop)
  local row = vim.fn.line('.') - 1
  local cancel = vim.fn.pumvisible() == 1 and '<C-e>' or ''
  return cancel .. string.format(
    '<Cmd>lua vim.api.nvim_buf_set_text(0, %d, %d, %d, %d, {"", %q, %q}); vim.api.nvim_win_set_cursor(0, {%d, %d})<CR>',
    row, column - #(before:match('%s*$')), row, column + #(after:match('^%s*')),
    inner, outer, row + 2, #inner)
end, {expr=true})

local function set_colors()
  for level, color in ipairs(colors) do
    api.nvim_set_hl(0, 'NidoBracket' .. level, { fg = color })
  end
end

local function update(buffer)
  if not api.nvim_buf_is_valid(buffer) or not api.nvim_buf_is_loaded(buffer) then
    return
  end
  api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  if vim.bo[buffer].buftype ~= '' then
    return
  end
  -- ponytail: full-buffer scan up to 1 MiB; use incremental parsing for larger files.
  if api.nvim_buf_get_offset(buffer, api.nvim_buf_line_count(buffer)) > 1024 * 1024 then
    return
  end
  api.nvim_buf_call(buffer, function()
    local stack = {}
    for row, line in ipairs(api.nvim_buf_get_lines(buffer, 0, -1, false)) do
      for column, bracket in line:gmatch('()([%(%)%[%]{}])') do
        if not ignored(row, column) then
          if not closing[bracket] then
            stack[#stack + 1] = { row = row - 1, column = column - 1, bracket = bracket }
          elseif #stack > 0 and stack[#stack].bracket == closing[bracket] then
            local group = 'NidoBracket' .. ((#stack - 1) % #colors + 1)
            local opening = table.remove(stack)
            for _, position in ipairs({ opening, { row = row - 1, column = column - 1 } }) do
              api.nvim_buf_set_extmark(buffer, namespace, position.row, position.column, {
                end_col = position.column + 1, hl_group = group, priority = 150,
              })
            end
          end
        end
      end
    end
  end)
end

set_colors()
api.nvim_create_autocmd('ColorScheme', { callback = set_colors })
api.nvim_create_autocmd({ 'BufWinEnter', 'FileType', 'TextChanged', 'TextChangedI', 'TextChangedP' }, {
  callback = function(event)
    local buffer = event.buf
    if pending[buffer] then
      return
    end
    pending[buffer] = true
    vim.defer_fn(function()
      pending[buffer] = nil
      update(buffer)
    end, 80)
  end,
})
