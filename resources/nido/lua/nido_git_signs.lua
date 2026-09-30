if vim.fn.executable('git') == 0 then return {} end
local api = vim.api
local namespace = api.nvim_create_namespace('nido_git_signs')
local generations = {}
local pending = {}
local M = {}

local function colors()
  api.nvim_set_hl(0, 'NidoGitAdded', { fg = '#2ea043' })
  api.nvim_set_hl(0, 'NidoGitChanged', { fg = '#0078d4' })
  api.nvim_set_hl(0, 'NidoGitDeleted', { fg = '#f85149' })
end
colors()
api.nvim_create_autocmd('ColorScheme', { callback = colors })

function M.refresh(buffer)
  buffer = buffer or api.nvim_get_current_buf()
  if not api.nvim_buf_is_valid(buffer) or vim.bo[buffer].buftype ~= '' then return end
  local name = api.nvim_buf_get_name(buffer)
  if name == '' then return end
  generations[buffer] = (generations[buffer] or 0) + 1
  local generation = generations[buffer]
  local tick = api.nvim_buf_get_changedtick(buffer)
  local function valid()
    return api.nvim_buf_is_valid(buffer) and generations[buffer] == generation
      and api.nvim_buf_get_changedtick(buffer) == tick and api.nvim_buf_get_name(buffer) == name
  end
  local function render(base)
    if not valid() then return end
    api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    if not base then vim.cmd('redraw'); return end
    local lines = api.nvim_buf_get_lines(buffer, 0, -1, false)
    local text = table.concat(lines, '\n') .. (vim.bo[buffer].endofline and '\n' or '')
    if #lines == 1 and lines[1] == '' then text = '' end
    -- ponytail: diff the whole buffer; cache the base and diff incrementally if large files become slow.
    local hunks = vim.diff(base, text, { result_type = 'indices' })
    local function sign(row, group, symbol)
      api.nvim_buf_set_extmark(buffer, namespace, math.max(0, math.min(row, #lines - 1)), 0, {
        sign_text = symbol, sign_hl_group = group, priority = 5,
      })
    end
    for _, hunk in ipairs(hunks) do
      local removed, start, added = hunk[2], hunk[3], hunk[4]
      for offset = 0, added - 1 do
        sign(start - 1 + offset, offset < removed and 'NidoGitChanged' or 'NidoGitAdded', '▎')
      end
      if removed > added then
        -- Pure deletions have a zero-length new range anchored after the preceding line.
        sign(added == 0 and start or start - 1 + added, 'NidoGitDeleted', '▸')
      end
    end
    vim.cmd('redraw')
  end
  local function git(directory, arguments, callback)
    local command = { 'git', '--no-pager', '--literal-pathspecs', '-C', directory }
    vim.list_extend(command, arguments)
    vim.system(command, { text = true, timeout = 2000 }, vim.schedule_wrap(function(result)
      if valid() then callback(result) end
    end))
  end
  git(vim.fs.dirname(name), {'rev-parse', '--show-toplevel'}, function(result)
    if result.code ~= 0 then render(nil); return end
    local root = vim.trim(result.stdout)
    local path = vim.fs.relpath(root, name)
    if not path then render(nil); return end
    path = path:gsub('\\', '/')
    git(root, {'show', 'HEAD:' .. path}, function(committed)
      if committed.code == 0 then render(committed.stdout); return end
      -- New files include staged additions and untracked files, but exclude ignored files.
      git(root, {'ls-files', '--cached', '--others', '--exclude-standard', '--error-unmatch', '--', path}, function(listed)
        render(listed.code == 0 and '' or nil)
      end)
    end)
  end)
end

function M.refresh_all()
  for _, buffer in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(buffer) then M.refresh(buffer) end
  end
end

api.nvim_create_autocmd({'BufEnter', 'BufWritePost', 'TextChanged', 'TextChangedI', 'TextChangedP', 'FileChangedShellPost'}, {
  callback = function(event)
    local buffer = event.buf
    local token = {}
    pending[buffer] = token
    vim.defer_fn(function()
      if pending[buffer] == token then pending[buffer] = nil; M.refresh(buffer) end
    end, 150)
  end,
})
api.nvim_create_autocmd('FocusGained', { callback = function() M.refresh() end })
api.nvim_create_autocmd('BufWipeout', { callback = function(event)
  generations[event.buf] = nil
  pending[event.buf] = nil
end })
-- Refresh the visible buffer after external commits, checkouts and Git panel actions.
local timer = vim.uv.new_timer()
timer:start(2000, 2000, vim.schedule_wrap(function() M.refresh() end))
api.nvim_create_autocmd('VimLeavePre', { callback = function() timer:stop(); timer:close() end })

return M
