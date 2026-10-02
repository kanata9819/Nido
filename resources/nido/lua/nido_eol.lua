local M = {}

function M.detect()
  if vim.bo.buftype ~= '' then
    return nil
  end
  local tick, format = vim.b.changedtick, vim.bo.fileformat
  local cached = vim.b.nido_eol
  if cached and cached.tick == tick and cached.format == format and cached.eol == vim.bo.endofline then
    return cached.label
  end
  local label = format == 'dos' and 'CRLF' or format == 'mac' and 'CR' or 'LF'
  -- In a Unix buffer, CRLF leaves a literal CR at the end of the line.
  if format == 'unix' then
    local cr, lf = false, false
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    for i, line in ipairs(lines) do
      if i < #lines or vim.bo.endofline then
        if line:sub(-1) == '\r' then
          cr = true
        else
          lf = true
        end
      end
    end
    if cr then
      label = lf and 'Mixed' or 'CRLF'
    end
  end
  vim.b.nido_eol = {tick=tick, format=format, eol=vim.bo.endofline, label=label}
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
  vim.b.nido_eol = nil
  vim.fn.winrestview(view)
  -- Publish even when only the fileformat option changed.
  vim.api.nvim_exec_autocmds('User', {pattern='NidoLineEndings'})
end

return M
