import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';
import { EditorCursor } from '../src/renderer/src/editorCursor';
import { setTimeout as delay } from 'node:timers/promises';

test('hover rejects edited text and cancels obsolete requests across cursor, window and buffer changes', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = await session.client.request('nvim_exec_lua', [
            `
local api, hover = vim.api, require('nido_hover')
local buffer, win = api.nvim_get_current_buf(), api.nvim_get_current_win()
api.nvim_buf_set_lines(buffer, 0, -1, false, {'alpha beta'})
local original_clients, original_request, original_notify = vim.lsp.get_clients, vim.lsp.buf_request_all, vim.rpcnotify
local requests, messages, cancelled, latest = {}, {}, 0, nil
vim.lsp.get_clients = function(options)
  if options and options.method == 'textDocument/hover' then return {{}} end
  return original_clients(options)
end
vim.lsp.buf_request_all = function(_, method, params, callback)
  assert(method == 'textDocument/hover' and type(params) == 'function')
  local request = {callback=callback}
  requests[#requests + 1] = request
  return function()
    assert(not request.cancelled, 'a request was cancelled twice')
    request.cancelled = true
    cancelled = cancelled + 1
    callback({[1]={err={message='cancelled hover'}}})
  end
end
vim.rpcnotify = function(channel, method, ...)
  if method == 'nido:hover' then messages[#messages + 1] = select(1, ...) end
  return original_notify(channel, method, ...)
end
local function reply(index, text)
  requests[index].callback({[1]={result={contents={kind='markdown', value=text}}}})
end
local function absent(text)
  assert(not vim.tbl_contains(messages, text), 'obsolete hover displayed: ' .. text)
end
local ok, err = pcall(function()
  hover.show()
  local cursor = api.nvim_win_get_cursor(win)
  api.nvim_buf_set_text(buffer, 0, 0, 0, 5, {'omega'})
  assert(vim.deep_equal(cursor, api.nvim_win_get_cursor(win)), 'edit leaves the cursor in place')
  reply(1, 'before the edit')
  absent('before the edit')

  for _=1,20 do hover.show() end
  assert(cancelled == 19, 'new hover requests must cancel their predecessors: ' .. cancelled)
  absent('cancelled hover')
  reply(2, 'superseded request')
  absent('superseded request')
  reply(21, 'latest description')
  assert(messages[#messages] == 'latest description')

  hover.show()
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(requests[22].cancelled, 'editing must cancel pending hover work')
  reply(22, 'after TextChanged')
  absent('after TextChanged')

  hover.show()
  api.nvim_win_set_cursor(win, {1, 1})
  api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
  assert(requests[23].cancelled, 'cursor movement must cancel pending hover work')
  reply(23, 'after moving')
  absent('after moving')

  hover.show()
  vim.cmd('vsplit')
  api.nvim_set_current_win(win)
  assert(requests[24].cancelled, 'leaving a window must cancel even when returning to its cursor')
  reply(24, 'after a window roundtrip')
  absent('after a window roundtrip')

  hover.show()
  vim.cmd('enew')
  assert(requests[25].cancelled, 'leaving a buffer must cancel pending hover work')
  reply(25, 'after leaving the buffer')
  absent('after leaving the buffer')
  hover.show()
  reply(26, 'recovered description')
  assert(messages[#messages] == 'recovered description', 'fresh hover still works after cancellation')
  hover.show()
  requests[27].callback({[1]={err={message='hover failed'}}})
  assert(messages[#messages] == 'hover failed')
  hover.show()
  reply(28, 'after a failed request')
  assert(messages[#messages] == 'after a failed request')
  latest = messages[#messages]
  hover.clear()
  local clears = #messages
  for _=1,20 do api.nvim_exec_autocmds('TextChanged', {buffer=api.nvim_get_current_buf()}) end
  assert(#messages == clears, 'editing without a hover must not send empty cards')
  hover.show()
  api.nvim_exec_autocmds('VimLeavePre', {})
  assert(requests[29].cancelled, 'shutdown must cancel pending hover work')
  reply(29, 'after stopping')
  absent('after stopping')
end)
vim.lsp.get_clients, vim.lsp.buf_request_all, vim.rpcnotify = original_clients, original_request, original_notify
assert(ok, err)
return {requests=#requests, cancelled=cancelled, latest=latest}
`,
            []
        ]);
        context.diagnostic(JSON.stringify(result));
    } finally {
        await session.stop();
    }
});

test('inline diagnostics abbreviate annotations while retaining full keyboard details and clearing old badges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-inline-diagnostics-'));
    const grid = new Grid();
    const cards: string[] = [];
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'sample.txt'), 'first line\nsecond line\nthird line\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
            if (event.type === 'diagnostics' && event.items.length) {
                cards.push(event.items[0].message);
            }
        });
        await session.attach(240, 24);
        await session.openFile('sample.txt');
        const message = '型が一致しません。'.repeat(12) + '\nCompiler explanation stays available.';
        await session.client.request('nvim_exec_lua', [
            `local message = ...
local ns = vim.api.nvim_create_namespace('inline-diagnostic-test')
vim.diagnostic.set(ns, 0, {
  {lnum=0, col=0, severity=3, message=message},
  {lnum=1, col=0, severity=2, message='Another warning'},
  {lnum=1, col=1, severity=1, message='Expected a semicolon'},
  {lnum=2, col=0, severity=4, message='Try a clearer name'},
})
vim.cmd('redraw!')`,
            [message]
        ]);
        await session.client.request('nvim_eval', ['1']);
        const rows = grid.cells.map((cells) => cells.map((cell) => cell.text).join(''));
        assert.match(
            rows.find((text) => text.includes('first line'))!,
            /INFO · 型が一致.*…/u
        );
        assert.ok(!rows.some((text) => text.includes('Compiler explanation')));
        assert.match(
            rows.find((text) => text.includes('second line'))!,
            /ERROR \+1 · Expected a semicolon/
        );
        assert.match(
            rows.find((text) => text.includes('third line'))!,
            /HINT · Try a clearer name/
        );
        const annotations = grid.cells
            .flat()
            .filter((cell) => grid.highlights.get(cell.highlight)?.diagnostic);
        assert.ok(annotations.length, 'Native virtual text reaches the GUI as diagnostic badges');
        for (const cell of annotations) {
            const highlight = grid.highlights.get(cell.highlight)!;
            assert.notEqual(highlight.background, undefined);
            assert.notEqual(
                highlight.foreground,
                highlight.special,
                'Only the accent uses severity color'
            );
        }
        await session.input('gg0gl');
        await session.client.request('nvim_eval', ['1']);
        assert.equal(cards.at(-1), message, 'gl retains the full Unicode compiler message');
        await session.client.request('nvim_exec_lua', [
            "vim.diagnostic.reset(vim.api.nvim_create_namespace('inline-diagnostic-test'), 0); vim.cmd('redraw!')",
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.ok(
            !grid.cells.flat().some((cell) => grid.highlights.get(cell.highlight)?.diagnostic)
        );
        assert.equal(
            await readFile(join(root, 'sample.txt'), 'utf8'),
            'first line\nsecond line\nthird line\n'
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Rust cast and import aliases use keyword colors without recoloring operators or strings', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.attach(80, 24);
        await session.client.request('nvim_exec_lua', [
            `
vim.lsp.enable('rust_analyzer', false)
vim.api.nvim_buf_set_lines(0, 0, -1, false, {
  'let value = count as i16;',
  'use std::io as input;',
  'let sum = left + right;',
  'let text = "as"; // as',
})
vim.bo.filetype = 'rust'
local function color(row, column)
  return vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(row, column, true)), 'fg#')
end
assert(color(1, 19) == '#569cd6', 'cast as must be blue: ' .. color(1, 19))
assert(color(2, 13) == '#569cd6', 'alias as must be blue')
assert(color(3, 16) == '#d4d4d4', 'symbolic operators keep their color')
assert(color(4, 13) == '#ce9178', 'as inside a string keeps its color')
assert(color(4, 20) == '#6a9955', 'as inside a comment keeps its color')
local preview = require('nido_references').highlight_text({'let value = count as i16;'}, 'rust')
assert(vim.iter(preview[1]):any(function(span)
  return span.text == 'as' and span.color == '#569cd6'
end), 'syntax-only previews use the same keyword color')
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('matching brackets follow the innermost pair, syntax, edits and visual mode', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.attach(80, 24);
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
local buffer = api.nvim_get_current_buf()
local ns = api.nvim_create_namespace('nido_bracket_match')
local function move(row, col)
  api.nvim_win_set_cursor(0, {row, col})
  api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
end
local function ready()
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  vim.cmd('redraw!')
  assert(vim.wait(5000, function() return require('nido_brackets').ready(buffer) end, 5))
end
local function marks()
  local positions = {}
  for _, mark in ipairs(api.nvim_buf_get_extmarks(buffer, ns, 0, -1, {})) do
    positions[#positions + 1] = {mark[2], mark[3]}
  end
  return positions
end
api.nvim_buf_set_lines(buffer, 0, -1, false, {'{', '  call([value]); "{ignored}"', '}', 'outside'})
vim.bo.filetype = 'javascript'
move(2, 8)
ready()
assert(vim.deep_equal(marks(), {{1,7}, {1,13}}), vim.inspect(marks()))
move(2, 7)
assert(vim.deep_equal(marks(), {{1,7}, {1,13}}))
move(2, 13)
assert(vim.deep_equal(marks(), {{1,7}, {1,13}}))
move(2, 14)
assert(vim.deep_equal(marks(), {{1,6}, {1,14}}))
move(2, 21)
assert(vim.deep_equal(marks(), {{0,0}, {2,0}}), 'String brackets must be ignored')
move(4, 0)
assert(#marks() == 0, 'Leaving a scope must remove its borders')
move(2, 8)
vim.cmd('normal! v')
assert(#marks() == 0, 'Visual selection must hide matching borders')
vim.cmd('normal! ' .. string.char(27))
api.nvim_buf_set_lines(buffer, 0, -1, false, {'[new]'})
move(1, 1)
ready()
assert(vim.deep_equal(marks(), {{0,0}, {0,4}}), 'Edits must not leave stale borders')
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('word fallback is case sensitive, uses whole words and clears on whitespace and selection', async () => {
    const grid = new Grid();
    const session = await Session.create(process.cwd(), (event) => {
        if (event.type === 'redraw') grid.apply(event.events);
    });
    try {
        await session.attach(80, 24);
        await session.client.request('nvim_exec_lua', [
            String.raw`
local api = vim.api
api.nvim_buf_set_lines(0, 0, -1, false, {'cells cells cellsOther Cells', '日本 日本 日本語', '  cells'})
api.nvim_win_set_cursor(0, {1, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
assert(vim.wait(3000, function() return #vim.fn.getmatches() > 0 end, 5))
local matches = vim.fn.getmatches()
assert(#matches == 1 and matches[1].pattern == [[\C\V\<cells\>]], vim.inspect(matches))
api.nvim_win_set_cursor(0, {1, 2})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
assert(vim.fn.getmatches()[1] and vim.fn.getmatches()[1].id == matches[1].id,
  'Moving within the selected word must not erase its fallback highlight during debounce')
api.nvim_buf_set_text(0, 2, 2, 2, 2, {'x'})
api.nvim_exec_autocmds('TextChanged', {buffer=0})
assert(vim.fn.getmatches()[1] and vim.fn.getmatches()[1].id == matches[1].id,
  'Unrelated text changes must preserve the still-valid fallback pattern')
vim.cmd('redraw!')
`,
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        await delay(400);
        await session.client.request('nvim_command', ['redraw!']);
        await session.client.request('nvim_eval', ['1']);
        const cells = grid.cells[0];
        const start = cells.findIndex((cell) => cell.text === 'c');
        const highlighted = cells
            .map((cell, index) => (grid.highlights.get(cell.highlight)?.wordHighlight ? index : -1))
            .filter((index) => index >= 0);
        assert.deepEqual(
            highlighted,
            Array.from({ length: 11 }, (_, i) => start + i).filter((i) => i !== start + 5)
        );
        assert.equal(grid.highlights.get(cells[start].highlight)?.background, 0xffffff);
        await session.client.request('nvim_exec_lua', [
            String.raw`
local api = vim.api
api.nvim_win_set_cursor(0, {2, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
assert(vim.wait(3000, function() return #vim.fn.getmatches() > 0 end, 5))
assert(vim.fn.getmatches()[1].pattern == [[\C\V\<日本\>]])
api.nvim_win_set_cursor(0, {3, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
vim.wait(300)
assert(#vim.fn.getmatches() == 0, 'Whitespace must not select the next word')
api.nvim_win_set_cursor(0, {1, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
assert(vim.wait(3000, function() return #vim.fn.getmatches() > 0 end, 5))
vim.cmd('normal! v')
vim.wait(300)
assert(#vim.fn.getmatches() == 0, 'Visual selection must clear word matches')
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('word highlighting reuses one timer during cursor bursts and clears pending work on focus and window changes', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.attach(80, 24);
        const result = await session.client.request('nvim_exec_lua', [
            String.raw`
local api = vim.api
api.nvim_buf_set_lines(0, 0, -1, false, {'alpha alpha beta beta'})
vim.wait(300)
local function timers()
  local active, total = 0, 0
  vim.uv.walk(function(handle)
    if handle:get_type() == 'timer' and not handle:is_closing() then
      total=total+1
      if handle:is_active() then active=active+1 end
    end
  end)
  return active, total
end
local baseline, before = timers()
for move=1,40 do
  api.nvim_win_set_cursor(0, {1, move % 2 == 0 and 12 or 0})
  api.nvim_exec_autocmds('CursorMoved', {buffer=0})
end
local active, after = timers()
assert(active-baseline == 1, 'cursor movement accumulated timers: ' .. active-baseline)
assert(after == before, 'cursor movement allocated new timer handles')
assert(#vim.fn.getmatches() == 0, 'highlight debounce must remain delayed')
assert(vim.wait(3000, function() return #vim.fn.getmatches() == 1 end, 5))
assert(vim.fn.getmatches()[1].pattern == [[\C\V\<beta\>]])
api.nvim_win_set_cursor(0, {1, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
api.nvim_exec_autocmds('FocusLost', {})
vim.wait(300)
assert(#vim.fn.getmatches() == 0 and timers() == baseline, 'focus loss retained pending work')
api.nvim_exec_autocmds('FocusGained', {})
assert(vim.wait(3000, function() return #vim.fn.getmatches() == 1 end, 5))
assert(vim.fn.getmatches()[1].pattern == [[\C\V\<alpha\>]])
api.nvim_win_set_cursor(0, {1, 12})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
vim.cmd('vsplit')
api.nvim_buf_set_lines(0, 0, -1, false, {'    '})
api.nvim_exec_autocmds('TextChanged', {buffer=0})
vim.wait(300)
assert(#vim.fn.getmatches() == 0, 'window changes retained an old pending highlight')
api.nvim_buf_set_lines(0, 0, -1, false, {'final final'})
api.nvim_win_set_cursor(0, {1, 0})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
vim.cmd('enew!')
vim.wait(300)
assert(#vim.fn.getmatches() == 0, 'buffer changes retained an old pending highlight')
local _, open = timers()
api.nvim_exec_autocmds('VimLeavePre', {})
local _, closed = timers()
assert(closed <= open-2, 'word and Git timers must close before shutdown')
return {moves=40, maximumPendingWordTimers=active-baseline, timerAllocations=after-before, latestWord='beta'}
`,
            []
        ]);
        context.diagnostic(JSON.stringify(result));
    } finally {
        await session.stop();
    }
});

test('document highlights reject late responses after moving, editing and leaving the buffer', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.attach(80, 24);
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
local buffer = api.nvim_get_current_buf()
local ns = api.nvim_create_namespace('nvim.lsp.references')
api.nvim_buf_set_lines(buffer, 0, -1, false, {'value other value'})
local callbacks, requests = {}, 0
local original = {vim.lsp.get_clients, vim.lsp.get_client_by_id, vim.lsp.buf_request_all}
local client = {id=1, offset_encoding='utf-16'}
vim.lsp.get_clients = function(filter)
  if filter and filter.method == 'textDocument/documentHighlight' then return {client} end
  return original[1](filter)
end
vim.lsp.get_client_by_id = function(id) return id == 1 and client or original[2](id) end
vim.lsp.buf_request_all = function(buf, method, params, callback)
  if method ~= 'textDocument/documentHighlight' then return original[3](buf, method, params, callback) end
  requests = requests + 1
  callbacks[requests] = callback
  return function() end
end
local result = {[1]={result={
  {range={start={line=0, character=0}, ['end']={line=0, character=5}}, kind=2},
  {range={start={line=0, character=12}, ['end']={line=0, character=17}}, kind=3},
}}}
local function request(column)
  api.nvim_win_set_cursor(0, {1, column})
  api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
  local expected = requests + 1
  assert(vim.wait(3000, function() return requests >= expected end, 5))
  return callbacks[requests]
end
local function marks() return api.nvim_buf_get_extmarks(buffer, ns, 0, -1, {}) end
local ok, err = pcall(function()
  local old = request(0)
  request(6)
  old(result)
  assert(#marks() == 0, 'A late response highlighted the previous word')
  local fresh = request(0)
  fresh(result)
  assert(#marks() == 2, 'The current response was not applied')
  api.nvim_win_set_cursor(0, {1, 2})
  api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
  assert(#marks() == 2, 'Moving inside an already highlighted identifier must not clear its ranges')
  local expected = requests + 1
  assert(vim.wait(3000, function() return requests >= expected end, 5))
  local replaced = callbacks[requests]
  api.nvim_buf_set_text(buffer, 0, 17, 0, 17, {' value'})
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(#marks() == 2, 'An edit outside the selected identifier must retain its tracked ranges')
  replaced({[1]={result={}}})
  assert(#marks() == 2, 'A stale empty response must not erase retained ranges')
  request(18)
  assert(#marks() == 0, 'A different occurrence of the same word must not inherit semantic highlights')
  local empty = request(0)
  empty(result)
  local current = request(2)
  current({[1]={result={}}})
  assert(#marks() == 0, 'A current empty response must replace retained ranges')
  local edited = request(6)
  api.nvim_buf_set_lines(buffer, 0, -1, false, {'changed other value'})
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  edited(result)
  assert(#marks() == 0, 'A late response survived an edit')
  local leaving = request(0)
  vim.cmd('enew!')
  leaving(result)
  assert(#marks() == 0, 'A late response survived a buffer switch')
end)
vim.lsp.get_clients, vim.lsp.get_client_by_id, vim.lsp.buf_request_all = unpack(original)
assert(ok, err)
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

for (const server of ['auto', 'legacy']) {
    test(`TypeScript ${server} occurrence highlights distinguish a shadowed variable after Unicode`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-occurrences-'));
        const grid = new Grid();
        let session: Session | undefined;
        try {
            await writeFile(join(root, 'tsconfig.json'), '{}');
            await writeFile(
                join(root, 'sample.ts'),
                [
                    'export function outer() {',
                    '  const value = 1;',
                    '  console.log("日本😀", value);',
                    '  function inner() { const value = 2; return value; }',
                    '  return value;',
                    '}'
                ].join('\n')
            );
            session = await Session.create(root, (event) => {
                if (event.type === 'redraw') grid.apply(event.events);
            });
            const config = join(root, 'lsp.json');
            await writeFile(config, JSON.stringify({ typescript: { server } }));
            await session.client.request('nvim_exec_lua', [
                "vim.env.NIDO_LSP_CONFIG = ...; require('nido_typescript').setup()",
                [config]
            ]);
            await session.openFile('sample.ts');
            await session.attach(100, 24);
            await session.client.request('nvim_exec_lua', [
                `
local api = vim.api
local ns = api.nvim_create_namespace('nvim.lsp.references')
assert(vim.wait(20000, function()
  return #vim.lsp.get_clients({bufnr=0, method='textDocument/documentHighlight'}) > 0
end, 20), 'TypeScript server did not attach')
local line = api.nvim_buf_get_lines(0, 2, 3, false)[1]
api.nvim_win_set_cursor(0, {3, line:find('value', 1, true) - 1})
api.nvim_exec_autocmds('CursorMoved', {buffer=0})
`,
                []
            ]);
            let positions: number[][] = [];
            for (let attempt = 0; attempt < 200 && positions.length < 3; attempt++) {
                await delay(100);
                positions = await session.client.request('nvim_exec_lua', [
                    `
local api = vim.api
local ns = api.nvim_create_namespace('nvim.lsp.references')
local positions = {}
for _, mark in ipairs(api.nvim_buf_get_extmarks(0, ns, 0, -1, {})) do
  positions[#positions + 1] = {mark[2], mark[3]}
end
vim.cmd('redraw!')
return positions
`,
                    []
                ]);
            }
            assert.deepEqual(positions, [
                [1, 8],
                [2, Buffer.byteLength('  console.log("日本😀", ')],
                [4, 9]
            ]);
            await session.client.request('nvim_eval', ['1']);
            assert.ok(
                grid.cells.some((row) =>
                    row.some((cell) => grid.highlights.get(cell.highlight)?.wordHighlight)
                ),
                'Document highlights must reach the GUI grid'
            );
        } finally {
            await session?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}

test('cursor width follows wide cells and interpolates in both directions and during stationary edits', () => {
    const grid = new Grid();
    grid.apply([
        ['grid_resize', [1, 12, 3]],
        ['grid_line', [1, 0, 0, [['a', 0], ['日'], [''], ['😀'], [''], ['e\u0301'], ['x']]]],
        ['flush']
    ]);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { hasFocus: () => true }
    });
    try {
        const media = { matches: false } as MediaQueryList;
        const cursor = new EditorCursor(
            grid,
            {} as HTMLElement,
            {} as HTMLTextAreaElement,
            media,
            false,
            () => {}
        );
        const update = (now: number, smooth = true): number =>
            cursor.update(now, smooth, false, true).width;
        assert.equal(update(0), 1);
        grid.cursor.column = 1;
        assert.equal(update(10), 1);
        assert.ok(update(60) > 1 && update(60) < 2);
        assert.equal(update(110), 2);
        grid.cursor.column = 3;
        assert.equal(update(120), 2, 'Emoji uses its continuation cell');
        grid.cursor.column = 5;
        update(130);
        assert.ok(update(135) > 1 && update(135) < 2);
        assert.equal(update(230), 1, 'Combining marks stay in one cell');
        grid.cells[0][5] = { text: '本', highlight: 0 };
        grid.cells[0][6] = { text: '', highlight: 0 };
        update(240);
        assert.ok(update(290) > 1 && update(290) < 2);
        assert.equal(update(340), 2);
        grid.cursor.column = 0;
        assert.equal(update(350, false), 1);
        grid.cursor.column = 1;
        media.matches = true;
        assert.equal(update(360), 2, 'Reduced motion skips interpolation');
    } finally {
        if (original) Object.defineProperty(globalThis, 'document', original);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});

function withCursor(
    run: (grid: Grid, cursor: EditorCursor, media: { matches: boolean }) => void
): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { hasFocus: () => true }
    });
    try {
        const grid = new Grid();
        const media = { matches: false };
        const cursor = new EditorCursor(
            grid,
            {} as HTMLElement,
            {} as HTMLTextAreaElement,
            media as MediaQueryList,
            false,
            () => {}
        );
        run(grid, cursor, media);
    } finally {
        if (original) Object.defineProperty(globalThis, 'document', original);
        else Reflect.deleteProperty(globalThis, 'document');
    }
}

test('cursor keeps moving when repeat targets change on every animation frame', () => {
    withCursor((grid, cursor) => {
        cursor.update(0, true, false, true);
        for (let step = 1; step <= 120; step++) {
            grid.cursor.row = step;
            const position = cursor.update(step * (1000 / 60), true, false, true);
            if (step >= 4) {
                assert.ok(
                    step - position.row < 1.01,
                    `Cursor must follow rather than freeze: target ${step}, painted ${position.row}`
                );
            }
        }
    });
});

for (const fps of [60, 120, 165]) {
    for (const interval of [33, 16]) {
        test(`cursor follows held movement and reversals at ${fps} Hz / ${interval} ms repeats`, () => {
            for (const axis of ['row', 'column'] as const) {
                withCursor((grid, cursor) => {
                    grid.cursor = { row: 200, column: 200 };
                    cursor.update(0, true, false, true);
                    const frameTime = 1000 / fps;
                    let now = 0;
                    for (const direction of [1, -1]) {
                        const start = now + frameTime;
                        const from = grid.cursor[axis];
                        let lastTargetFrame = 0;
                        for (let frame = 0; frame < fps * 2; frame++) {
                            now = start + frame * frameTime;
                            const count = Math.floor((now - start) / interval) + 1;
                            const target = from + count * direction;
                            if (grid.cursor[axis] !== target) lastTargetFrame = now;
                            grid.cursor[axis] = target;
                            const position = cursor.update(now, true, false, true);
                            if (now > start + 200) {
                                assert.ok(
                                    Math.abs(target - position[axis]) <
                                        Math.ceil(frameTime / interval) + 0.4,
                                    `${axis}: target ${target}, painted ${position[axis]}`
                                );
                            }
                        }
                        const deadline = lastTargetFrame + interval + frameTime * 2;
                        const position = cursor.update(deadline, true, false, true);
                        assert.equal(
                            position[axis],
                            grid.cursor[axis],
                            'Releasing settles promptly'
                        );
                        assert.equal(cursor.animating, false);
                        now = deadline + 200;
                    }
                });
            }
        });
    }
}

test('cursor preserves single-step easing and resets repeat timing on interruptions', () => {
    withCursor((grid, cursor, media) => {
        cursor.update(0, true, false, true);
        grid.cursor.row = 1;
        assert.equal(cursor.update(10, true, false, true).row, 0);
        const halfway = cursor.update(60, true, false, true).row;
        assert.ok(halfway > 0 && halfway < 1, 'Single steps still animate');
        assert.equal(cursor.update(110, true, false, true).row, 1);

        let now = 120;
        for (const bypass of ['disabled', 'scroll', 'unfocused', 'reduced', 'reset'] as const) {
            grid.cursor.row++;
            if (bypass === 'reset') cursor.resetPosition();
            media.matches = bypass === 'reduced';
            const position = cursor.update(
                now,
                bypass !== 'disabled',
                bypass === 'scroll',
                bypass !== 'unfocused'
            );
            assert.equal(position.row, grid.cursor.row, `${bypass} snaps to the real position`);
            assert.equal(cursor.animating, false);
            media.matches = false;
            grid.cursor.row++;
            cursor.update(now + 1, true, false, true);
            const next = cursor.update(now + 51, true, false, true).row;
            assert.ok(next > grid.cursor.row - 1 && next < grid.cursor.row);
            assert.equal(cursor.update(now + 101, true, false, true).row, grid.cursor.row);
            now += 110;
        }
    });
});
