local api = vim.api
local namespace = api.nvim_create_namespace('nido_indent')
local windows = {}
local colors = { '#75633f', '#476a86', '#745781', '#467568', '#805655', '#647747' }

local function set_colors()
  for level, color in ipairs(colors) do
    api.nvim_set_hl(0, 'NidoIndent' .. level, { fg = color, nocombine = true })
  end
end

set_colors()
api.nvim_create_autocmd('ColorScheme', { callback = set_colors })

api.nvim_set_decoration_provider(namespace, {
  on_start = function()
    windows = {}
  end,
  on_win = function(_, window, buffer, first, last)
    if vim.bo[buffer].buftype ~= '' or api.nvim_win_get_config(window).relative ~= '' then
      return false
    end

    -- Query indentation in the target window so tabs and local options stay correct.
    windows[window] = api.nvim_win_call(window, function()
      local view = vim.fn.winsaveview()
      local info = vim.fn.getwininfo(window)[1]
      local state = {
        step = vim.fn.shiftwidth(),
        left = view.leftcol,
        width = api.nvim_win_get_width(window) - info.textoff,
        indents = {},
      }
      for row = first, math.min(last, api.nvim_buf_line_count(buffer) - 1) do
        local line = row + 1
        local indent = vim.fn.indent(line)
        if vim.fn.getline(line):match('^%s*$') then
          -- Continue only the indentation shared by both sides of a blank line.
          local before = vim.fn.prevnonblank(line)
          local after = vim.fn.nextnonblank(line)
          indent = math.min(math.max(0, vim.fn.indent(before)), math.max(0, vim.fn.indent(after)))
        end
        state.indents[row] = indent
      end
      return state
    end)
  end,
  on_line = function(_, window, buffer, row)
    local state = windows[window]
    if not state then
      return
    end

    local indent = state.indents[row] or 0
    for column = 0, indent - 1, state.step do
      local screen_column = column - state.left
      if screen_column >= 0 and screen_column < state.width then
        local level = (column / state.step) % #colors + 1
        api.nvim_buf_set_extmark(buffer, namespace, row, 0, {
          ephemeral = true,
          virt_text = { { '│', 'NidoIndent' .. level } },
          virt_text_win_col = screen_column,
          hl_mode = 'combine',
          priority = 1,
        })
      end
    end
  end,
})
