local M = {}
local api = vim.api
local states = {}

local function scan(state, buffer, first, last)
  for offset, line in ipairs(api.nvim_buf_get_lines(buffer, first, last, false)) do
    if line:sub(-1) == '\r' then
      state.rows[first + offset - 1] = true
      state.cr = state.cr + 1
    end
  end
end

local function track(buffer)
  local state = states[buffer]
  if not state then
    state = {rows={}, cr=0}
    states[buffer] = state
    api.nvim_buf_attach(buffer, false, {
      on_lines = function(_, buf, tick, first, last, new_last)
        if not state.tick then return end
        for row=first,last-1 do
          if state.rows[row] then state.rows[row] = nil; state.cr = state.cr - 1 end
        end
        local delta = new_last - last
        if delta ~= 0 then
          local moved = {}
          for row in pairs(state.rows) do
            if row >= last then moved[row + delta] = true; state.rows[row] = nil end
          end
          for row in pairs(moved) do state.rows[row] = true end
        end
        scan(state, buf, first, new_last)
        state.tick = tick
      end,
      on_changedtick = function(_, _, tick) if state.tick then state.tick = tick end end,
      on_reload = function() state.tick = nil end,
      on_detach = function() states[buffer] = nil end,
    })
  end
  local tick = api.nvim_buf_get_changedtick(buffer)
  if state.tick ~= tick then
    state.rows, state.cr = {}, 0
    scan(state, buffer, 0, -1)
    state.tick = tick
  end
  return state
end

function M.open(path)
  -- GUI navigation opens text files; inherited binary mode bypasses CRLF detection.
  vim.cmd('edit ++nobin ' .. vim.fn.fnameescape(path))
end

function M.detect()
  if vim.bo.buftype ~= '' then
    return nil
  end
  local format = vim.bo.fileformat
  local label = format == 'dos' and 'CRLF' or format == 'mac' and 'CR' or 'LF'
  -- In a Unix buffer, CRLF leaves a literal CR at the end of the line.
  if format == 'unix' then
    local buffer = api.nvim_get_current_buf()
    local state = track(buffer)
    local count = api.nvim_buf_line_count(buffer)
    local cr = state.cr
    if not vim.bo.endofline then
      count = count - 1
      if state.rows[count] then cr = cr - 1 end
    end
    if cr > 0 then
      label = cr < count and 'Mixed' or 'CRLF'
    end
  end
  return label
end

function M.convert(format)
  assert(format == 'LF' or format == 'CRLF', 'Invalid line ending')
  assert(vim.bo.buftype == '' and vim.bo.modifiable, 'Buffer cannot be modified')
  local view = vim.fn.winsaveview()
  if vim.bo.fileformat == 'unix' then
    -- Only strip CR belonging to a line ending; preserve embedded CR characters.
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    local changed = false
    for i, line in ipairs(lines) do
      if (i < #lines or vim.bo.endofline) and line:sub(-1) == '\r' then
        lines[i] = line:sub(1, -2)
        changed = true
      end
    end
    if changed then
      vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
    end
  end
  vim.bo.fileformat = format == 'LF' and 'unix' or 'dos'
  vim.bo.fixendofline = false
  vim.fn.winrestview(view)
  -- Publish even when only the fileformat option changed.
  vim.api.nvim_exec_autocmds('User', {pattern='NidoLineEndings'})
end

return M
