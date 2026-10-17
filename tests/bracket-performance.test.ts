import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '../src/main/session';

test('bracket index agrees with a full scan for nested pairs, cursor boundaries and viewport ranges', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.client.request('nvim_exec_lua', [
            `
local factory = require('nido_bracket_index')
local empty = factory.new({})
assert(empty.innermost(0, 0) == nil and #empty.overlapping(0, 10) == 0)
local pairs = {}
local function add(first_row, first_column, last_row, last_column)
  pairs[#pairs + 1] = {
    first={row=first_row, column=first_column}, last={row=last_row, column=last_column},
  }
end
for block=0,19 do
  local first = block * 10
  add(first, 0, first + 9, 0)
  for row=first+1,first+8 do
    add(row, 2, row, 18)
    add(row, 5, row, 7)
  end
end
local function before(a, b)
  return a.row < b.row or (a.row == b.row and a.column < b.column)
end
table.sort(pairs, function(a, b) return before(a.last, b.last) end)
local index = factory.new(pairs)
for row=-1,201 do
  for column=0,20 do
    local cursor, expected = {row=row, column=column}, nil
    for _, pair in ipairs(pairs) do
      if not before(cursor, pair.first) and not before(pair.last, cursor)
          and (not expected or before(expected.first, pair.first)) then expected = pair end
    end
    assert(index.innermost(row, column) == expected, 'Indexed cursor query changed the innermost pair')
  end
end
for first=-1,201,3 do
  for height=1,12 do
    local expected = {}
    for _, pair in ipairs(pairs) do
      if pair.first.row < first + height and pair.last.row >= first then
        expected[#expected + 1] = pair
      end
    end
    assert(vim.deep_equal(index.overlapping(first, first + height), expected),
      'Indexed viewport query omitted or reordered visible pairs')
  end
end
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('cursor movement inspects only visible bracket scopes in a large file', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = (await session.client.request('nvim_exec_lua', [
            `
local api, brackets = vim.api, require('nido_brackets')
local buffer = api.nvim_get_current_buf()
local lines = {}
for i=1,3000 do
  lines[#lines + 1] = 'scope ' .. i .. ' {'
  lines[#lines + 1] = string.rep('  content', 8)
  lines[#lines + 1] = '}'
end
api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
api.nvim_win_set_cursor(0, {4499, 0})
vim.cmd('normal! zz')
api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
assert(vim.wait(10000, function() return brackets.ready(buffer) end, 5))
assert(#brackets.pairs(buffer) == 3000)
local reads = 0
for _, pair in ipairs(brackets.pairs(buffer)) do
  local first = pair.first
  pair.first = nil
  setmetatable(pair, {__index=function(_, key)
    if key == 'first' then reads = reads + 1; return first end
  end})
end
local original_notify, latest = vim.rpcnotify, nil
vim.rpcnotify = function(channel, name, guides, ...)
  if name == 'nido:bracket_guides' then latest = guides end
  return original_notify(channel, name, guides, ...)
end
local ok, err = pcall(function()
  vim.cmd('redraw!')
  reads = 0
  for column=1,20 do
    api.nvim_win_set_cursor(0, {4499, column})
    api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
  end
  assert(latest and #latest > 0 and #latest < 12, vim.inspect(latest))
  local active = 0
  for _, guide in ipairs(latest) do if guide.active then active = active + 1 end end
  assert(active == 1, 'Exactly the innermost visible scope must be active')
end)
vim.rpcnotify = original_notify
assert(ok, err)
return {scopeReads=reads, moves=20, scopes=3000}
`,
            []
        ])) as { scopeReads: number; moves: number; scopes: number };
        context.diagnostic(JSON.stringify(result));
        if (!process.env.NIDO_PERFORMANCE_BASELINE) {
            assert.ok(
                result.scopeReads <= 1000,
                `cursor movement inspected ${result.scopeReads} scopes`
            );
        }
    } finally {
        await session.stop();
    }
});

test('sticky scopes refresh after bracket analysis completes in later chunks', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.client.request('nvim_exec_lua', [
            `
local api, brackets, sticky = vim.api, require('nido_brackets'), require('nido_sticky')
local buffer = api.nvim_get_current_buf()
local lines = {}
for i=1,10000 do
  table.insert(lines, 'function scope() {')
  table.insert(lines, '  content();')
  table.insert(lines, '}')
end
local original_defer, original_notify = vim.defer_fn, vim.rpcnotify
local held, latest = {}, nil
vim.defer_fn = function(fn, ms)
  if ms == 1 then table.insert(held, fn); return end
  return original_defer(fn, ms)
end
vim.rpcnotify = function(channel, name, state, ...)
  if name == 'nido:sticky_scroll' then latest = state end
  return original_notify(channel, name, state, ...)
end
local ok, err = pcall(function()
  api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(vim.wait(10000, function() return #held > 0 end, 1), 'Analysis did not yield')
  vim.wait(180)
  assert(not brackets.ready(buffer), 'Analysis must still be pending')
  sticky.publish(api.nvim_get_current_win(), buffer)
  assert(latest and latest.scopes[1] and latest.scopes[1].ending == 2,
    'The early indentation fallback did not run')
  vim.defer_fn = original_defer
  for _, fn in ipairs(held) do original_defer(fn, 1) end
  assert(vim.wait(10000, function() return brackets.ready(buffer) end, 1), 'Analysis timed out')
  vim.wait(180)
  sticky.publish(api.nvim_get_current_win(), buffer)
  assert(latest and latest.scopes[1] and latest.scopes[1].ending == 3,
    'Sticky Scroll retained the incomplete indentation fallback')
end)
vim.defer_fn, vim.rpcnotify = original_defer, original_notify
assert(ok, err)
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('large bracket analysis yields to edits and discards obsolete partial work', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = (await session.client.request('nvim_exec_lua', [
            `
local api, module = vim.api, require('nido_brackets')
local buffer = api.nvim_get_current_buf()
local namespace = api.nvim_create_namespace('nido_brackets')
local lines = {}
for i=1,10000 do
  table.insert(lines, '{')
  table.insert(lines, '  return [1, 2];')
  table.insert(lines, '}')
end
api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
local original_call, original_syntax = api.nvim_buf_call, vim.fn.synstack
local longest, callbacks, inspected, interleaved = 0, 0, 0, false
api.nvim_buf_call = function(buf, fn)
  local start = vim.uv.hrtime()
  local value = original_call(buf, fn)
  if buf == buffer then
    callbacks = callbacks + 1
    longest = math.max(longest, (vim.uv.hrtime() - start) / 1e6)
  end
  return value
end
local ok, err = pcall(function()
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(vim.wait(10000, function() return module.ready(buffer) end, 1), 'Initial analysis timed out')
  vim.fn.synstack = function(...)
    inspected = inspected + 1
    if inspected == 1000 then
      vim.schedule(function()
        interleaved = not module.ready(buffer)
        api.nvim_buf_set_lines(buffer, 0, -1, false, {'[latest]'})
        api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
      end)
    end
    return original_syntax(...)
  end
  api.nvim_buf_set_lines(buffer, 1, 2, false, {'  return [2, 3];'})
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(vim.wait(10000, function()
    return api.nvim_buf_line_count(buffer) == 1 and module.ready(buffer)
  end, 1), 'Latest analysis timed out')
  local marks = api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {})
  assert(#marks == 2 and marks[1][2] == 0 and marks[2][2] == 0,
    'Obsolete analysis published stale bracket marks')
  assert(#module.pairs(buffer) == 0, 'Obsolete scopes survived the edit')
end)
api.nvim_buf_call, vim.fn.synstack = original_call, original_syntax
assert(ok, err)
return {interleaved=interleaved, longestCallbackMs=longest, callbacks=callbacks, inspected=inspected}
`,
            []
        ])) as {
            interleaved: boolean;
            longestCallbackMs: number;
            callbacks: number;
            inspected: number;
        };
        context.diagnostic(JSON.stringify(result));
        assert.equal(
            result.interleaved,
            true,
            'Editing must run before the entire bracket scan finishes'
        );
    } finally {
        await session.stop();
    }
});

test('unchanged bracket scopes avoid duplicate cursor notifications and buffer rescans', async (context) => {
    let guides = 0;
    let redrawGuides = 0;
    let measuring = false;
    const session = await Session.create(process.cwd(), () => {});
    session.client.on('notification', (method: string, args: unknown[]) => {
        if (!measuring || method !== 'nido:bracket_guides') return;
        // Full redraws replay the snapshot; only cursor-only notifications are deduplicated.
        if (args[1] === true) guides++;
        else redrawGuides++;
    });
    const lua = (code: string): ReturnType<Session['client']['request']> =>
        session.client.request('nvim_exec_lua', [code, []]);
    try {
        await session.attach(80, 24);
        await lua(`
            local lines = {'{', string.rep('content ', 20), '}'}
            vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
            vim.api.nvim_win_set_cursor(0, {2, 0})
        `);
        // The first native input can finish the undo header and advance changedtick.
        await session.input('l');
        await session.client.request('nvim_eval', ['1']);
        await lua(`
            local buffer = vim.api.nvim_get_current_buf()
            assert(vim.wait(5000, function() return require('nido_brackets').ready(buffer) end, 5),
              'Initial bracket analysis did not complete')
            vim.cmd.redraw({bang=true})
            vim.api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
        `);
        await lua('return 1');
        measuring = true;
        for (let i = 0; i < 20; i++) {
            await session.input('l');
            await session.client.request('nvim_eval', ['1']);
            if (i === 9) {
                // Sticky scopes can finish refreshing while cursor movement is measured.
                await lua('vim.cmd.redraw({bang=true})');
            }
        }
        await lua("vim.api.nvim_exec_autocmds('CursorMoved', {buffer=0})");
        measuring = false;
        await lua(`
            local original = vim.api.nvim_buf_set_extmark
            local namespace = vim.api.nvim_create_namespace('nido_brackets')
            vim.g.bracket_writes = 0
            vim.api.nvim_buf_set_extmark = function(buffer, ns, ...)
                if ns == namespace then vim.g.bracket_writes = vim.g.bracket_writes + 1 end
                return original(buffer, ns, ...)
            end
            vim.api.nvim_exec_autocmds('BufWinEnter', {buffer=0})
            local buffer = vim.api.nvim_get_current_buf()
            assert(vim.wait(5000, function() return require('nido_brackets').ready(buffer) end, 5),
              'Bracket analysis after buffer entry did not complete')
        `);
        const writes = Number(await lua('return vim.g.bracket_writes'));
        context.diagnostic(
            JSON.stringify({
                cursorGuideNotifications: guides,
                redrawGuideSnapshots: redrawGuides,
                unchangedBracketWrites: writes
            })
        );
        assert.ok(redrawGuides > 0, 'The measurement must include a full-redraw snapshot');
        if (!process.env.NIDO_PERFORMANCE_BASELINE) {
            assert.equal(guides, 0);
            assert.equal(writes, 0);
        }
        await lua(`
            vim.api.nvim_buf_set_lines(0, 1, 2, false, {'nested { content }'})
            vim.api.nvim_exec_autocmds('TextChanged', {buffer=0})
            local buffer = vim.api.nvim_get_current_buf()
            assert(vim.wait(5000, function() return require('nido_brackets').ready(buffer) end, 5),
              'Bracket analysis after editing did not complete')
        `);
        assert.ok(Number(await lua('return vim.g.bracket_writes')) > writes);
        assert.equal(
            Number(
                await lua("return #require('nido_brackets').pairs(vim.api.nvim_get_current_buf())")
            ),
            1
        );
    } finally {
        await session.stop();
    }
});

test('bracket edits reuse distant marks, shift rows correctly and invalidate changed syntax', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = await session.client.request('nvim_exec_lua', [
            `
local api, module = vim.api, require('nido_brackets')
local buffer = api.nvim_get_current_buf()
local namespace = api.nvim_create_namespace('nido_brackets')
local function ready()
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  -- Headless API edits need a redraw to invalidate Neovim's multiline syntax state.
  vim.cmd('redraw!')
  assert(vim.wait(5000, function() return module.ready(buffer) end, 1), 'Bracket analysis timed out')
end
local lines = {}
for i=1,1000 do
  table.insert(lines, '{')
  table.insert(lines, '  return [1, 2];')
  table.insert(lines, '}')
end
api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
ready()
local original = api.nvim_buf_set_extmark
local writes = 0
api.nvim_buf_set_extmark = function(buf, ns, ...)
  if ns == namespace then writes = writes + 1 end
  return original(buf, ns, ...)
end
local ok, err = pcall(function()
  local before = api.nvim_buf_get_extmarks(buffer, namespace, {3,0}, -1, {})
  api.nvim_buf_set_lines(buffer, 1, 2, false, {'  return [2, 3];'})
  ready()
  assert(writes == 2, 'An ordinary edit rewrote unchanged bracket marks: ' .. writes)
  assert(vim.deep_equal(before, api.nvim_buf_get_extmarks(buffer, namespace, {3,0}, -1, {})))
  assert(#module.pairs(buffer) == 1000)
  writes = 0
  api.nvim_buf_set_lines(buffer, 0, 0, false, {'header'})
  ready()
  assert(writes == 0, 'Inserted plain line recreated marks')
  assert(module.pairs(buffer)[1].first.row == 1)
  local shifted = api.nvim_buf_get_extmarks(buffer, namespace, {4,0}, -1, {})
  for i, mark in ipairs(before) do
    assert(shifted[i][1] == mark[1] and shifted[i][2] == mark[2] + 1 and shifted[i][3] == mark[3])
  end
  api.nvim_buf_set_lines(buffer, 0, 1, false, {})
  ready()
  assert(vim.deep_equal(before, api.nvim_buf_get_extmarks(buffer, namespace, {3,0}, -1, {})))
  api.nvim_buf_set_lines(buffer, 0, -1, false, {'{', 'return [1, 2];', '} END'})
  ready()
  api.nvim_exec_autocmds('Syntax', {buffer=buffer})
  vim.cmd('syntax region NidoTestComment start=/BEGIN/ end=/END/')
  vim.cmd('syntax sync fromstart')
  ready()
  assert(#api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {}) == 4)
  api.nvim_buf_set_lines(buffer, 0, 1, false, {'BEGIN {'})
  ready()
  assert(#api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {}) == 0,
    'Multiline comment kept distant marks')
  api.nvim_buf_set_lines(buffer, 0, 1, false, {'{'})
  ready()
  local tick = api.nvim_buf_get_changedtick(buffer)
  api.nvim_exec_autocmds('Syntax', {buffer=buffer})
  vim.cmd('syntax match NidoTestComment /[{}]/')
  ready()
  assert(api.nvim_buf_get_changedtick(buffer) == tick)
  assert(#api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {}) == 2, 'Syntax-only change kept stale marks')
  vim.bo[buffer].buftype = 'nofile'
  api.nvim_exec_autocmds('Syntax', {buffer=buffer})
  ready()
  assert(#api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {}) == 0)
  vim.bo[buffer].buftype = ''
  api.nvim_exec_autocmds('Syntax', {buffer=buffer})
  ready()
  local restored = api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {})
  assert(#restored == 4)
  api.nvim_buf_set_lines(buffer, 0, 0, false, {'header'})
  ready()
  local shifted = api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {})
  assert(#shifted == #restored, 'Buffer-type changes duplicated the attachment')
  for i, mark in ipairs(restored) do
    assert(shifted[i][1] == mark[1] and shifted[i][2] == mark[2] + 1 and shifted[i][3] == mark[3])
  end
end)
api.nvim_buf_set_extmark = original
assert(ok, err)
return {ordinaryEditWrites=2, unaffectedRows=2997}
`,
            []
        ]);
        context.diagnostic(JSON.stringify(result));
    } finally {
        await session.stop();
    }
});
