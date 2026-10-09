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
