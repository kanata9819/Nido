import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { SessionEvents } from '../src/main/sessionEvents';
import { Grid } from '../src/renderer/src/grid';
import type { NidoEvent, SessionState, Redraw } from '../src/shared/types';

test('resize bursts skip obsolete queued sizes and keep the latest viewport', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    const request = session.client.request.bind(session.client);
    const sizes: unknown[][] = [];
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    try {
        session.client.request = async (method, args = []) => {
            if (method === 'nvim_ui_try_resize') {
                sizes.push(args);
                if (sizes.length === 1) {
                    entered();
                    await gate;
                }
            }
            return request(method, args);
        };
        const first = session.resize(81, 24);
        await started;
        const queued = Array.from({ length: 20 }, (_, index) =>
            session.resize(82 + index, 25 + index)
        );
        release();
        await Promise.all([first, ...queued]);
        context.diagnostic(JSON.stringify({ resizeRequests: sizes.length, sizes }));
        assert.equal(sizes.length, 2);
        const uis = (await request('nvim_list_uis', [])) as { width: number; height: number }[];
        assert.deepEqual([uis[0].width, uis[0].height], [101, 44]);
    } finally {
        release();
        session.client.request = request;
        await session.stop();
    }
});

test('cursor patches preserve diagnostics and buffers, and explicit clears reach the renderer', () => {
    const sent: NidoEvent[] = [];
    const events = new SessionEvents('alpha', (event) => sent.push(event));
    const buffers = [{ id: 1, name: '/alpha/main.rs', modified: false }];
    const problems = [
        {
            path: buffers[0].name,
            line: 1,
            column: 1,
            severity: 1,
            message: 'error',
            source: 'rustc'
        }
    ];
    events.receiveNotification('nido:state', [
        {
            buffers,
            problems,
            diagnostics: { [buffers[0].name]: 1 },
            lineEnding: 'LF',
            scrollCursor: { row: 2, column: 3 }
        }
    ]);
    const initial = events.state;
    assert.equal(sent[0].type, 'state');
    events.receiveNotification('nido:state', [{ line: 12, column: 4 }]);
    assert.deepEqual(sent[1], { type: 'statePatch', id: 'alpha', state: { line: 12, column: 4 } });
    assert.equal(events.state.buffers, buffers);
    assert.equal(events.state.problems, problems);
    assert.equal(events.state.diagnostics, initial.diagnostics);
    events.receiveNotification('nido:state', [{ line: 12, column: 4 }]);
    assert.equal(sent.length, 2);
    events.receiveNotification('nido:state', [{ lineEnding: null, scrollCursor: null }]);
    assert.deepEqual(sent[2], {
        type: 'statePatch',
        id: 'alpha',
        state: { lineEnding: undefined, scrollCursor: undefined }
    });
    events.receiveNotification('nido:state', [{ buffers: {}, problems: {}, diagnostics: {} }]);
    assert.equal(sent[3].type, 'state');
    assert.deepEqual(events.state.buffers, []);
    assert.deepEqual(events.state.problems, []);
    assert.deepEqual(events.state.diagnostics, {});
});

test('scroll batches publish the latest cursor with collection changes preserved', () => {
    const sent: NidoEvent[] = [];
    const events = new SessionEvents('alpha', (event) => sent.push(event));
    events.receiveNotification('nido:state', [{ buffers: [] }]);
    events.beginScrollBatch();
    events.receiveNotification('nido:state', [{ diagnostics: { '/alpha/main.rs': 2 }, line: 2 }]);
    events.receiveNotification('nido:state', [{ line: 30 }]);
    assert.equal(sent.length, 1);
    events.endScrollBatch();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, 'state');
    assert.equal(events.state.line, 30);
    assert.deepEqual(events.state.diagnostics, { '/alpha/main.rs': 2 });
});

test('native cursor movement avoids retransmitting a thousand diagnostics on every step', async () => {
    const sent: Extract<NidoEvent, { type: 'state' | 'statePatch' }>[] = [];
    let measuring = false;
    const session = await Session.create(process.cwd(), (event) => {
        if (measuring && (event.type === 'state' || event.type === 'statePatch')) sent.push(event);
    });
    try {
        await session.client.request('nvim_exec_lua', [
            `
            local lines, items = {}, {}
            for i=1,2000 do lines[i] = 'row ' .. i end
            vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
            vim.api.nvim_buf_set_name(0, vim.fn.getcwd() .. '/performance-fixture.txt')
            for i=1,1000 do items[i] = {lnum=i-1,col=0,severity=1,message='Diagnostic ' .. i .. string.rep(' detail',20)} end
            vim.diagnostic.set(vim.api.nvim_create_namespace('performance-fixture'),0,items)
            for i=1,20 do local b=vim.api.nvim_create_buf(true,false); vim.api.nvim_buf_set_name(b,vim.fn.getcwd() .. '/fixture-' .. i .. '.txt') end
            vim.wait(100,function() return false end,10)
        `,
            []
        ]);
        let rendered: SessionState = { ...session.state };
        measuring = true;
        for (let i = 0; i < 20; i++) {
            await session.input('j');
            await session.client.request('nvim_eval', ['1']);
        }
        for (const event of sent) rendered = { ...rendered, ...event.state };
        assert.equal(rendered.line, 21);
        assert.equal(rendered.buffers.length, 21);
        assert.equal(rendered.problems?.length, 1000);
        assert.ok(sent.filter((event) => event.type === 'statePatch').length >= 19);
        assert.ok(sent.filter((event) => 'problems' in event.state).length <= 1);
        assert.ok(
            sent.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0) <
                400_000
        );

        await session.client.request('nvim_exec_lua', [
            `
            vim.diagnostic.reset(vim.api.nvim_create_namespace('performance-fixture'))
            vim.wait(30,function() return false end,5)
        `,
            []
        ]);
        assert.deepEqual(session.state.problems, []);
        assert.deepEqual(session.state.diagnostics, {});
    } finally {
        await session.stop();
    }
});

test('search counts reuse unchanged views and refresh for cursor, edits, patterns and case options', async () => {
    const session = await Session.create(process.cwd(), () => {});
    const lua = (code: string): ReturnType<Session['client']['request']> =>
        session.client.request('nvim_exec_lua', [code, []]);
    const publish = async (): Promise<void> => {
        await lua(
            "vim.api.nvim_exec_autocmds('User', {pattern='NidoScroll'}); vim.wait(80,function() return false end,5)"
        );
    };
    try {
        await lua(`
            vim.api.nvim_buf_set_lines(0,0,-1,false,{'alpha ALPHA','alpha','beta'})
            vim.fn.setreg('/','alpha'); vim.o.ignorecase=false; vim.v.hlsearch=1
            local original = vim.fn.searchcount
            vim.g.nido_test_search_scans = 0
            vim.fn.searchcount = function(options)
                vim.g.nido_test_search_scans = vim.g.nido_test_search_scans + 1
                return original(options)
            end
        `);
        await publish();
        assert.equal(session.state.search && session.state.search.total, 2);
        const scans = await lua('return vim.g.nido_test_search_scans');
        for (let i = 0; i < 3; i++) await publish();
        assert.equal(await lua('return vim.g.nido_test_search_scans'), scans);
        await lua('vim.api.nvim_win_set_cursor(0,{2,0})');
        await publish();
        assert.equal(session.state.search && session.state.search.current, 2);
        await lua('vim.o.ignorecase=true');
        await publish();
        assert.equal(session.state.search && session.state.search.total, 3);
        await lua("vim.api.nvim_buf_set_lines(0,2,3,false,{'alpha'})");
        await publish();
        assert.equal(session.state.search && session.state.search.total, 4);
        await lua("vim.fn.setreg('/','ALPHA'); vim.o.smartcase=true");
        await publish();
        assert.equal(session.state.search && session.state.search.total, 1);
        await lua('vim.v.hlsearch=0');
        await publish();
        assert.equal(session.state.search, false);
    } finally {
        await session.stop();
    }
});

test('search counting coalesces rapid movement and rejects stale edits, buffers and cleared searches', async (context) => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
local original_count, original_defer, original_notify, original_hrtime = vim.fn.searchcount, vim.defer_fn, vim.rpcnotify, vim.uv.hrtime
local scans, held, latest = 0, {}, nil
local function publish()
  api.nvim_exec_autocmds('User', {pattern='NidoSearch'})
  vim.wait(5)
end
local function flush()
  for _=1,5 do
    local callbacks = held
    held = {}
    for _, callback in ipairs(callbacks) do callback() end
    vim.wait(5)
    if #held == 0 then return end
  end
  error('Search counting did not settle')
end
api.nvim_buf_set_lines(0,0,-1,false,vim.fn['repeat']({'alpha ALPHA'},1000))
vim.fn.setreg('/', 'alpha'); vim.o.ignorecase=false; vim.o.smartcase=false; vim.v.hlsearch=1
vim.wait(100)
local now = original_hrtime()
vim.uv.hrtime = function() return now end -- This entire burst is inside the counting window.
vim.fn.searchcount = function(options) scans=scans+1; return original_count(options) end
vim.defer_fn = function(callback, ms)
  if ms >= 8 and ms <= 32 then held[#held+1]=callback; return end
  return original_defer(callback, ms)
end
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:state' then latest=vim.deepcopy(state) end
  return original_notify(channel, method, state, ...)
end
local ok, err = pcall(function()
  for row=101,140 do
    api.nvim_win_set_cursor(0,{row,0})
    publish()
  end
  assert(scans == 0 and latest.line == 140, 'Cursor state must arrive without a full-buffer scan')
  flush()
  assert(scans == 1 and latest.search.current == 140 and latest.search.total == 1000,
    'A burst must count only its latest cursor position')
  api.nvim_win_set_cursor(0,{150,0}); publish()
  api.nvim_win_set_cursor(0,{140,0}); publish()
  flush()
  assert(scans == 1 and latest.search.current == 140, 'Returning to a cached position cancels an obsolete count')
  api.nvim_win_set_cursor(0,{160,0}); publish()
  api.nvim_buf_set_lines(0,0,-1,false,{'beta','beta'})
  vim.fn.setreg('/','beta')
  -- The queued callback must recheck text, pattern and position even before their next autocmd.
  flush()
  assert(latest.search.pattern == 'beta' and latest.search.total == 2,
    'A queued count must not publish the old text or pattern')
  api.nvim_win_set_cursor(0,{2,0}); publish()
  local buffer = api.nvim_create_buf(true,false)
  api.nvim_set_current_buf(buffer)
  api.nvim_buf_set_lines(buffer,0,-1,false,{'beta beta beta'})
  flush()
  assert(latest.current == buffer and latest.search.total == 3, 'A count must follow the current buffer')
  vim.fn.setreg('/','missing'); publish()
  vim.v.hlsearch=0; publish()
  local before = scans
  flush()
  assert(latest.search == false and scans == before, 'Clearing search cancels its queued work')
end)
vim.fn.searchcount, vim.defer_fn, vim.rpcnotify, vim.uv.hrtime = original_count, original_defer, original_notify, original_hrtime
assert(ok, err)
return {moves=40, burstScans=1, totalScans=scans}
`,
            []
        ]);
        context.diagnostic(JSON.stringify(result));
    } finally {
        await session.stop();
    }
});

test('slow search counts have a bounded wait during continuous input', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
api.nvim_buf_set_lines(0,0,-1,false,{'alpha','alpha','alpha','alpha','alpha'})
vim.fn.setreg('/','alpha'); vim.v.hlsearch=0
api.nvim_exec_autocmds('User',{pattern='NidoSearch'}); vim.wait(5)
local hrtime, defer, count, notify = vim.uv.hrtime, vim.defer_fn, vim.fn.searchcount, vim.rpcnotify
local now, held, latest = 0, {}, nil
vim.uv.hrtime = function() return now end
vim.defer_fn = function(callback, ms)
  if ms <= 80 then held[#held+1]={callback=callback,delay=ms}; return end
  return defer(callback,ms)
end
vim.fn.searchcount = function(options)
  local result = count(options)
  now=now+10000000 -- Model a slow count without sleeping inside the test.
  return result
end
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:state' then latest=vim.deepcopy(state) end
  return notify(channel,method,state,...)
end
local function publish()
  api.nvim_exec_autocmds('User',{pattern='NidoSearch'}); vim.wait(5)
end
local ok, err = pcall(function()
  vim.v.hlsearch=1; publish()
  local initial=held; held={}
  for _, item in ipairs(initial) do item.callback() end
  vim.wait(5)
  for row=2,5 do
    now=now+40000000
    api.nvim_win_set_cursor(0,{row,0}); publish()
    assert(held[#held].delay <= 80, 'A slow count must not postpone a settled view beyond 80ms')
  end
  assert(held[#held].delay == 0, 'Continuous input must not postpone counting beyond 120ms')
  local callbacks=held; held={}
  for _, item in ipairs(callbacks) do item.callback() end
  vim.wait(5)
  assert(latest.search.current == 5 and latest.search.total == 5, 'The bounded update must count the latest position')
end)
vim.uv.hrtime, vim.defer_fn, vim.fn.searchcount, vim.rpcnotify = hrtime, defer, count, notify
assert(ok,err)
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

test('incremental prefetch preserves every visible frame and bounds each batch of grid traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-traffic-'));
    const frames: Redraw[] = [];
    const visibleFrames: Grid['cells'][] = [];
    const grid = new Grid();
    const session = await Session.create(root, (event) => {
        if (event.type === 'redraw') {
            grid.apply(event.events);
            frames.push(event.events);
            visibleFrames.push(grid.cells.slice());
        }
    });
    try {
        await writeFile(
            join(root, 'rows.txt'),
            Array.from(
                { length: 5000 },
                (_, i) => `row ${i + 1} ${'nested { let x = 1; } '.repeat(8)}`
            ).join('\n')
        );
        await session.attach(100, 40);
        await session.openFile('rows.txt');
        await session.input('2000Gzt');
        // Partial bracket marks do not mean parsing or delayed word highlights have finished.
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                `local buffer = vim.api.nvim_get_current_buf()
local namespace = vim.api.nvim_create_namespace('nido_brackets')
vim.api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
local ready = vim.wait(5000, function()
  return require('nido_brackets').ready(buffer) and #vim.fn.getmatches() > 0
    and #vim.api.nvim_buf_get_extmarks(buffer, namespace, {1999, 0}, {1999, -1}, {limit=1}) > 0
end, 5)
vim.cmd.redraw()
return ready`,
                []
            ]),
            true,
            'Bracket analysis and word highlighting must complete before measuring prefetch frames.'
        );
        const view = await session.client.request('nvim_exec_lua', [
            // A timer wait can finish before Neovim flushes its last cursor-line repaint.
            'vim.cmd.redraw(); return vim.fn.winsaveview()',
            []
        ]);
        const visible = grid.cells.slice();
        frames.length = 0;
        visibleFrames.length = 0;
        // Independent highlighting and guide refreshes share the redraw channel with cache refills.
        await session.client.request('nvim_exec_lua', ['vim.cmd.redraw({bang=true})', []]);
        await session.prefetchScroll();
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
            view
        );
        const viewportFrames = frames.filter((frame) =>
            // Standalone highlighting repaints can contain grid_line without moving the view.
            frame.some(([name]) => name === 'nido_scroll' || name === 'nido_scroll_cache')
        );
        assert.ok(
            viewportFrames.length > 1,
            `temporary views must never become separate visible frames: ${JSON.stringify(
                frames.map((frame) => frame.map(([name]) => name))
            )}`
        );
        const bytes = Buffer.byteLength(JSON.stringify(viewportFrames));
        assert.ok(bytes < 400_000, `incremental refill traffic must remain bounded: ${bytes}`);
        assert.ok(
            viewportFrames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) < 80_000),
            'each strip must publish a bounded batch'
        );
        for (const rendered of visibleFrames) {
            for (let row = 0; row < visible.length; row++) {
                assert.equal(
                    rendered[row],
                    visible[row],
                    'every published frame must preserve the visible row images'
                );
            }
        }
        assert.equal(grid.needsUpperRows, false);
        await session.scroll(-100, true, true);
        assert.equal(
            grid.hasUpperRows,
            true,
            'a fast upward move retains the remaining cached history'
        );
        const downView = await session.client.request('nvim_exec_lua', [
            'return vim.fn.winsaveview()',
            []
        ]);
        const downRows = grid.cells.slice();
        frames.length = 0;
        visibleFrames.length = 0;
        await session.prefetchScroll(true);
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
            downView
        );
        assert.equal(
            frames.filter((frame) =>
                frame.some(([name, args]) => name === 'nido_scroll_cache' && args[3] === true)
            ).length,
            1
        );
        assert.ok(Buffer.byteLength(JSON.stringify(frames)) < 400_000);
        for (const rendered of visibleFrames) assert.deepEqual(rendered, downRows);
        assert.equal(grid.needsLowerRows, false);
        assert.equal(grid.futureRows.length, 256);
        const future = grid.futureRows.slice(0, 3);
        await session.scroll(3, true, true);
        const text = (rows: Grid['cells']): string[] =>
            rows.map((row) => row.map((cell) => cell.text).join(''));
        assert.deepEqual(
            text(grid.cells.slice(grid.rows - 4, grid.rows - 2)),
            text(future.slice(0, 2))
        );
        // Neovim replaces the end of an incomplete wrapped bottom row with @ markers.
        assert.deepEqual(
            text([grid.cells[grid.rows - 2].slice(0, -3)]),
            text([future[2].slice(0, -3)])
        );
        await session.input('gg');
        await session.prefetchScroll(true);
        assert.equal(grid.futureRows.length, 256, 'BOF still permits downward prefetch');
        await session.input('Gzt');
        await session.scroll(1000, true, true);
        const wrappedEnd = await session.client.request('nvim_exec_lua', [
            'return vim.fn.winsaveview()',
            []
        ]);
        await session.prefetchScroll(true);
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
            wrappedEnd,
            'prefetch preserves a wrapped viewport near EOF'
        );
        await session.client.request('nvim_exec_lua', [
            'vim.wo.wrap=false; vim.wo.scrolloff=0',
            []
        ]);
        await session.input('Gzt');
        await session.scroll(1000, true, true);
        await session.prefetchScroll(true);
        assert.equal(grid.futureRows.length, 0);
        assert.equal(grid.needsLowerRows, false, 'EOF must not repeatedly refill an empty cache');
    } finally {
        await session.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('scroll input runs between prefetch strips without losing the viewport or cached rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-priority-'));
    const grid = new Grid();
    const session = await Session.create(root, (event) => {
        if (event.type === 'redraw') grid.apply(event.events);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    try {
        await writeFile(
            join(root, 'rows.txt'),
            Array.from({ length: 2000 }, (_, i) => `ROW_${i + 1}`).join('\n')
        );
        await session.attach(80, 40);
        await session.openFile('rows.txt');
        await session.client.request('nvim_exec_lua', ['vim.wo.wrap=false; vim.cmd.redraw()', []]);
        const request = session.client.request.bind(session.client);
        let strips = 0;
        session.client.request = async (method, args = []) => {
            if (method === 'nvim_exec_lua' && String(args[0]).includes('.prefetch(')) {
                if (++strips === 1) {
                    entered();
                    await gate;
                }
            }
            return request(method, args);
        };
        let complete = false;
        const prefetch = session.prefetchScroll(true).then(() => {
            complete = true;
        });
        await started;
        const scroll = session.scroll(3, true, true);
        release();
        await scroll;
        assert.equal(complete, false, 'input must finish before speculative cache work completes');
        assert.equal(strips, 1, 'queued input must run before the next strip');
        await prefetch;
        assert.ok(strips > 1);
        assert.equal(await request('nvim_eval', ["line('w0')"]), 4);
        assert.equal(grid.futureRows.length, 256);
        assert.match(grid.futureRows[0].map((cell) => cell.text).join(''), /ROW_43\b/);
        for (let i = 0; i < 4; i++) await session.scroll(16, true, true);
        const before = strips;
        await session.prefetchScroll(true);
        assert.ok(
            strips - before < 8,
            'warm refills must reuse known rows instead of fetching all 256 again'
        );
        assert.equal(grid.futureRows.length, 256);
        assert.deepEqual(
            grid.futureRows.map((row) =>
                Number(
                    row
                        .map((cell) => cell.text)
                        .join('')
                        .match(/ROW_(\d+)/)?.[1]
                )
            ),
            Array.from({ length: 256 }, (_, i) => 107 + i),
            'reused and newly fetched strips must remain contiguous after movement'
        );
    } finally {
        release();
        await session.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('buffer switches discard cached rows and cancel an unfinished prefetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-buffer-'));
    const grid = new Grid();
    const session = await Session.create(root, (event) => {
        if (event.type === 'redraw') grid.apply(event.events);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    try {
        for (const name of ['old', 'new', 'third']) {
            await writeFile(
                join(root, `${name}.txt`),
                Array.from({ length: 2000 }, (_, i) => `${name}_ROW_${i + 1}`).join('\n')
            );
        }
        await session.attach(80, 40);
        await session.openFile('old.txt');
        await session.input('400Gzt');
        await session.prefetchScroll(true);
        assert.equal(grid.futureRows.length, 256);
        assert.match(grid.futureRows[0].map((cell) => cell.text).join(''), /old_ROW_/);
        await session.openFile('new.txt');
        await session.client.request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
        assert.match(grid.description, /new_ROW_1\b/);
        assert.equal(grid.historyRows.length, 0);
        assert.equal(grid.futureRows.length, 0, 'old file rows must never preview in the new file');
        const request = session.client.request.bind(session.client);
        let strips = 0;
        session.client.request = async (method, args = []) => {
            if (method === 'nvim_exec_lua' && String(args[0]).includes('.prefetch(')) {
                if (++strips === 1) {
                    entered();
                    await gate;
                }
            }
            return request(method, args);
        };
        const prefetch = session.prefetchScroll(true);
        await started;
        const opening = session.openFile('third.txt');
        release();
        await Promise.all([prefetch, opening]);
        await request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
        assert.equal(strips, 1, 'a buffer switch cancels the remaining strips');
        assert.match(grid.description, /third_ROW_1\b/);
        assert.equal(grid.futureRows.length, 0);
        await session.prefetchScroll(true);
        assert.equal(grid.futureRows.length, 256);
        assert.ok(
            grid.futureRows.every((row) => /third_ROW_/.test(row.map((cell) => cell.text).join('')))
        );
        await session.input('<Esc>:buffer old.txt<CR>');
        await request('nvim_eval', ['1']);
        assert.match(grid.description, /old_ROW_400\b/);
        assert.equal(grid.futureRows.length, 0, 'native :buffer switches also invalidate previews');
    } finally {
        release();
        await session.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('fractional gestures publish every offset without native repaints and preserve the edit anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-fractional-work-'));
    const frames: Redraw[] = [];
    const session = await Session.create(root, (event) => {
        if (event.type === 'redraw') frames.push(event.events);
    });
    try {
        await writeFile(
            join(root, 'rows.txt'),
            Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n')
        );
        await session.openFile('rows.txt');
        await session.input('50Gzt');
        await session.scroll(0.125, false, true);
        await session.client.request('nvim_exec_lua', [
            `
            local scroll=require('nido_scroll')
            local original_scroll=scroll.scroll
            local original=vim.cmd.redraw
            local scrolling=false
            vim.g.test_scroll_repaints=0
            -- Deferred sticky-header redraws are independent of the scroll operation.
            vim.cmd.redraw=function(...)
                if scrolling then
                    vim.g.test_scroll_repaints=vim.g.test_scroll_repaints+1
                end
                return original(...)
            end
            scroll.scroll=function(...)
                scrolling=true
                local changed=original_scroll(...)
                scrolling=false
                return changed
            end
        `,
            []
        ]);
        frames.length = 0;
        for (let i = 0; i < 4; i++) await session.scroll(0.125, false, true);
        assert.equal(await session.client.request('nvim_eval', ['g:test_scroll_repaints']), 0);
        const offsets = frames.flatMap((frame) =>
            frame.flatMap(([name, ...calls]) =>
                name === 'nido_pixel_scroll' ? calls.map((args) => Number(args[0])) : []
            )
        );
        assert.deepEqual(offsets, [0.25, 0.375, 0.5, 0.625]);
        assert.ok(frames.every((frame) => frame.at(-1)?.[0] === 'flush'));
        await session.scroll(1, false, true);
        assert.equal(await session.client.request('nvim_eval', ['g:test_scroll_repaints']), 1);
        await session.input('iQ<Esc>');
        assert.equal(await session.client.request('nvim_eval', ['line(".")']), 50);
        assert.equal(await session.client.request('nvim_get_current_line', []), 'Qrow 50');
    } finally {
        await session.stop();
        await rm(root, { recursive: true, force: true });
    }
});
