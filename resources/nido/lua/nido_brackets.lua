local api = vim.api
local namespace = api.nvim_create_namespace('nido_brackets')
local colors = { '#d9b777', '#c586c0', '#7fbdde', '#80c5ad' }
local closing = { [')'] = '(', [']'] = '[', ['}'] = '{' }
local pending = {}

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
        local ignored = false
        for _, id in ipairs(vim.fn.synstack(row, column)) do
          local name = vim.fn.synIDattr(id, 'name'):lower()
          if name:find('comment') or name:find('string') or name:find('character') then
            ignored = true
            break
          end
        end
        if not ignored then
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
