local M = {}

local function before(a, b)
  return a.row < b.row or (a.row == b.row and a.column < b.column)
end

-- The parser closes nested pairs in endpoint order. Store the earliest opening
-- in each balanced range so cursor and viewport queries can skip unrelated pairs.
function M.new(pairs, work)
  local starts = {}
  local function build(node, first, last)
    if first == last then
      starts[node] = pairs[first].first
    else
      local middle = math.floor((first + last) / 2)
      build(node * 2, first, middle)
      build(node * 2 + 1, middle + 1, last)
      local left, right = starts[node * 2], starts[node * 2 + 1]
      starts[node] = before(left, right) and left or right
    end
    if work then work() end
  end
  if #pairs > 0 then build(1, 1, #pairs) end

  local function innermost(row, column)
    local position = {row=row, column=column}
    local function find(node, first, last)
      if not starts[node] or before(position, starts[node])
          or before(pairs[last].last, position) then return nil end
      if first == last then return pairs[first] end
      local middle = math.floor((first + last) / 2)
      return find(node * 2, first, middle) or find(node * 2 + 1, middle + 1, last)
    end
    return find(1, 1, #pairs)
  end

  local function overlapping(first_row, last_row)
    local result = {}
    local function visit(node, first, last)
      if not starts[node] or starts[node].row >= last_row
          or pairs[last].last.row < first_row then return end
      if first == last then
        result[#result + 1] = pairs[first]
        return
      end
      local middle = math.floor((first + last) / 2)
      visit(node * 2, first, middle)
      visit(node * 2 + 1, middle + 1, last)
    end
    visit(1, 1, #pairs)
    return result
  end

  return {innermost=innermost, overlapping=overlapping}
end

return M
