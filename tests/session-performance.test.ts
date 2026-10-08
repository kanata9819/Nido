import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import { SessionEvents } from '../src/main/sessionEvents';
import type { NidoEvent, SessionState } from '../src/shared/types';

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
            "vim.api.nvim_exec_autocmds('User', {pattern='NidoScroll'}); vim.wait(20,function() return false end,5)"
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
