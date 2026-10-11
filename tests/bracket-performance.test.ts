import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '../src/main/session';

test('unchanged bracket scopes avoid duplicate cursor notifications and buffer rescans', async (context) => {
    let guides = 0;
    let measuring = false;
    const session = await Session.create(process.cwd(), (event) => {
        if (measuring && event.type === 'redraw') {
            guides += event.events.filter(([name]) => name === 'nido_bracket_guides').length;
        }
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
        }
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
            JSON.stringify({ cursorGuideNotifications: guides, unchangedBracketWrites: writes })
        );
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
