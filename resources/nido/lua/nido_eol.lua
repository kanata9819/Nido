-- Line endings: opening files safely, the status bar's line-ending label, and converting
-- between LF and CRLF.
local M = {}
local api = vim.api
-- Per buffer, the rows that end in a literal CR and how many there are, kept current as the
-- buffer changes so the status bar never rescans a large file.
local states = {}
-- A CRLF conversion can remove literal CRs from a mixed file. Undo records the text,
-- so track the corresponding fileformat at that undo block as well.
local conversions = {}

local function undo_path(entries, target, converted, active)
  for _, entry in ipairs(entries) do
    if entry.alt then
      local found, conversion = undo_path(entry.alt, target, converted, active)
      if found then return true, conversion end
    end
    active = converted[entry.seq] and entry.seq or active
    if entry.seq == target then return true, active end
  end
  return false
end

local function sync_format(buffer)
  local state = conversions[buffer]
  if not state then return end
  local tree = vim.fn.undotree(buffer)
  if tree.seq_cur == state.sequence then return end
  state.sequence = tree.seq_cur
  local found, active = undo_path(tree.entries, tree.seq_cur, state.blocks)
  if not found and tree.seq_cur ~= 0 then return end
  if active == state.active then return end
  -- When the previous conversion aged out of the undo tree, it can no longer be undone.
  if not active and not undo_path(tree.entries, state.active, state.blocks) then
    conversions[buffer] = nil
    return
  end
  -- Moving back to an ancestor undoes a conversion from Unix. A different
  -- destination branch instead redoes its most recent CRLF conversion.
  local previous = state.active
  while previous and previous ~= active do
    previous = state.blocks[previous].parent
  end
  local format = previous == active and 'unix' or 'dos'
  if vim.bo[buffer].fileformat == state.format then
    vim.bo[buffer].fileformat = format
  end
  state.format = format
  state.active = active
end

api.nvim_create_autocmd({'TextChanged', 'BufWritePre'}, {
  callback = function(event) sync_format(event.buf) end,
})
api.nvim_create_autocmd({'BufReadPre', 'BufWipeout'}, {
  callback = function(event) conversions[event.buf] = nil end,
})

--- Record the rows [first, last) that end in CR.
local function scan(state, buffer, first, last)
  for offset, line in ipairs(api.nvim_buf_get_lines(buffer, first, last, false)) do
    if line:sub(-1) == '\r' then
      state.rows[first + offset - 1] = true
      state.cr = state.cr + 1
    end
  end
end

--- The CR rows of a buffer, attaching to it on first use to follow its edits.
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

--- Open `path` in the current window, reusing its buffer and leaving unsaved edits alone.
function M.open(path)
  local buffer = require('nido_buffers').find(path)
  if buffer < 0 then
    -- Name the empty placeholder without rename hooks; apply settings after reading the file.
    if vim.bo.buftype == '' and not vim.bo.modified and api.nvim_buf_get_name(0) == ''
        and api.nvim_buf_line_count(0) == 1 and api.nvim_get_current_line() == '' then
      api.nvim_cmd({cmd='file', args={path}, magic={file=false}, mods={noautocmd=true, silent=true}}, {})
      buffer = api.nvim_get_current_buf()
    else
      buffer = vim.fn.bufadd(path)
    end
  end
  assert(buffer > 0, 'Could not open file.')
  if api.nvim_buf_is_loaded(buffer) and vim.bo[buffer].modified then
    vim.cmd.buffer(buffer)
    return
  end
  -- Pass the name with file expansion off. ":edit #N" still expanded environment
  -- variables in the name it stood for: "a$HOME.txt" opened "a/home/user.txt", and
  -- saving wrote a file there. Clearing 'binary' first does what ++nobin did, which
  -- keeps line-ending detection.
  vim.bo[buffer].binary = false
  api.nvim_cmd({cmd='edit', args={api.nvim_buf_get_name(buffer)}, magic={file=false}}, {})
end

--- The current buffer's line endings for the status bar: LF, CRLF, CR or Mixed, or nil for
--- special buffers. A Unix buffer whose lines all end in CR is reported as CRLF.
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

--- Convert the current buffer to LF or CRLF line endings (applied to disk on save).
function M.convert(format)
  assert(format == 'LF' or format == 'CRLF', 'Invalid line ending')
  assert(vim.bo.buftype == '' and vim.bo.modifiable, 'Buffer cannot be modified')
  local view = vim.fn.winsaveview()
  local buffer = api.nvim_get_current_buf()
  sync_format(buffer)
  local before
  if vim.bo.fileformat == 'unix' then
    -- Only strip CR belonging to a line ending; preserve embedded CR characters.
    local lines = api.nvim_buf_get_lines(0, 0, -1, false)
    for i, line in ipairs(lines) do
      if (i < #lines or vim.bo.endofline) and line:sub(-1) == '\r' then
        if before == nil then
          -- Group the removed CRs together without joining the preceding edit.
          vim.bo.undolevels = vim.bo.undolevels
          before = vim.fn.undotree().seq_cur
        end
        -- Keep extmarks on their text by editing just the trailing CR.
        api.nvim_buf_set_text(0, i - 1, #line - 1, i - 1, #line, {})
      end
    end
  end
  vim.bo.fileformat = format == 'LF' and 'unix' or 'dos'
  vim.bo.fixendofline = false
  local after = vim.fn.undotree().seq_cur
  if format == 'CRLF' and before ~= nil and after ~= before then
    local state = conversions[buffer] or {blocks={}}
    state.blocks[after] = {parent=state.active}
    state.sequence = after
    state.active = after
    state.format = 'dos'
    conversions[buffer] = state
  end
  vim.fn.winrestview(view)
  -- Publish even when only the fileformat option changed.
  vim.api.nvim_exec_autocmds('User', {pattern='NidoLineEndings'})
end

return M
