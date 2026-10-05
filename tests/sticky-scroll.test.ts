import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';
import { stickyRows } from '../src/renderer/src/stickyScroll';
import type { StickyScrollState } from '../src/shared/types';

const span = [{ text: 'scope {', color: '#d4d4d4' }];
function state(scopes: StickyScrollState['scopes']): StickyScrollState {
    return {
        window: 1,
        buffer: 1,
        top: 0,
        left: 0,
        width: 80,
        height: 30,
        gutter: 6,
        tabstop: 2,
        leftcol: 0,
        scopes
    };
}

test('sticky scopes pin in nesting order, respect the line limit and slide out at their closing line', () => {
    const scopes = [
        { line: 1, ending: 100, top: 0, bottom: 25, text: span, endText: span },
        { line: 4, ending: 20, top: 3, bottom: 5, text: span, endText: span },
        { line: 25, ending: 35, top: 7, bottom: 12, text: span, endText: span }
    ];
    const data = state(scopes);
    assert.deepEqual(
        stickyRows(data, (row) => row * 18, 0, 18, 5),
        []
    );
    const rows = stickyRows(data, (row) => row * 18 - 60, 0, 18, 5);
    assert.deepEqual(
        rows.map((row) => row.scope.line),
        [1, 4]
    );
    assert.deepEqual(
        rows.map((row) => row.offset),
        [0, -6]
    );
    assert.deepEqual(
        stickyRows(data, (row) => row * 18 - 60, 0, 18, 1).map((row) => row.scope.line),
        [1]
    );
    assert.deepEqual(
        stickyRows(data, (row) => row * 18 - 110, 0, 18, 5).map((row) => row.scope.line),
        [1, 25]
    );
    assert.deepEqual(
        stickyRows(data, (row) => row * 18 - 450, 0, 18, 5),
        []
    );
});

test('Rust sticky headers pick up delayed semantic colors even when their source rows are offscreen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-sticky-colors-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'scopes.rs'),
            [
                'impl Screen {',
                '    pub fn apply_csi(&mut self, csi: CsiActions) {',
                ...Array.from({ length: 40 }, () => '        let value = 0;'),
                '    }',
                '}'
            ].join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        const lua = async (source: string): Promise<unknown> => {
            const result = await session!.client.request('nvim_exec_lua', [source, []]);
            await session!.client.request('nvim_eval', ['1']);
            return result;
        };
        await lua("vim.lsp.enable('rust_analyzer', false)");
        await session.openFile('scopes.rs');
        await lua("vim.wait(300); vim.cmd('normal! 12Gzt'); vim.cmd.redraw()");
        const headerColor = (): string | undefined =>
            grid.stickyScroll?.scopes
                .find((scope) => scope.line === 1)
                ?.text.find((span) => span.text.includes('Screen'))?.color;
        const syntaxColor = headerColor();
        assert.ok(syntaxColor);
        assert.notEqual(syntaxColor, '#4ec9b0');
        await lua(`
            _G.sticky_semantic_requests = {}
            -- A real Neovim LSP client with a controlled in-process transport.
            -- Hold semantic replies until the headers have already been cached offscreen.
            _G.sticky_color_client = vim.lsp.start({
              name='sticky-color-fixture',
              cmd=function(dispatchers)
                local closed, next_id = false, 0
                return {
                  request=function(method, _, callback, notify_reply)
                    next_id = next_id + 1
                    local id = next_id
                    local function reply(result)
                      if notify_reply then notify_reply(id) end
                      callback(nil, result)
                    end
                    if method == 'initialize' then
                      vim.schedule(function() reply({capabilities={
                        textDocumentSync=1,
                        semanticTokensProvider={full=true, legend={
                          tokenTypes={'struct', 'parameter'}, tokenModifiers={'declaration'}
                        }}
                      }}) end)
                    elseif method == 'textDocument/semanticTokens/full' then
                      table.insert(_G.sticky_semantic_requests, reply)
                    else
                      vim.schedule(function() reply(nil) end)
                    end
                    return true, id
                  end,
                  notify=function(method)
                    if method == 'exit' then closed=true; dispatchers.on_exit(0, 0) end
                    return true
                  end,
                  is_closing=function() return closed end,
                  terminate=function() closed=true; dispatchers.on_exit(0, 0) end,
                }
              end,
            })
            assert(vim.wait(5000, function() return #_G.sticky_semantic_requests > 0 end))
            table.remove(_G.sticky_semantic_requests, 1)({data={0, 5, 6, 0, 0}})
            assert(vim.wait(5000, function()
              return #(vim.lsp.semantic_tokens.get_at_pos(0, 0, 5) or {}) > 0
            end))
            vim.wait(80)
            vim.cmd.redraw()
            assert(#vim.inspect_pos(0, 0, 5).semantic_tokens == 0,
              'offscreen source rows have no painted semantic extmarks')
        `);
        assert.equal(
            headerColor(),
            '#4ec9b0',
            'late Rust type colors replace the cached plain header'
        );
        await lua(`
            vim.api.nvim_set_hl(0, '@lsp.typemod.struct.declaration.rust', {fg='#4fc1ff'})
            vim.lsp.semantic_tokens.force_refresh(0)
            assert(vim.wait(5000, function() return #_G.sticky_semantic_requests > 0 end))
            table.remove(_G.sticky_semantic_requests, 1)({data={0, 5, 6, 0, 1, 11, 12, 5, 1, 0}})
            assert(vim.wait(5000, function()
              local tokens = vim.lsp.semantic_tokens.get_at_pos(0, 0, 5) or {}
              return tokens[1] and tokens[1].modifiers.declaration
            end))
            vim.wait(80)
            vim.cmd.redraw()
        `);
        assert.equal(headerColor(), '#4fc1ff', 'semantic refreshes preserve modifier priority');
        await lua(
            'vim.lsp.get_client_by_id(_G.sticky_color_client):stop(true); vim.wait(300); vim.cmd.redraw()'
        );
        assert.equal(
            headerColor(),
            syntaxColor,
            'detaching the server restores syntax-only colors'
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('sticky scope geometry shares the completed Neovim frame, survives pixel scrolling, and guards stale jumps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-sticky-session-'));
    const grid = new Grid();
    grid.pixelScrollEnabled = true;
    let pixelOffset: unknown;
    let session: Session | undefined;
    try {
        const file = join(root, 'scopes.txt');
        await writeFile(
            file,
            [
                'class Panel {',
                '  render() {',
                '    if (ready) {',
                ...Array.from({ length: 40 }, (_, i) => `      item${i}();`),
                '    }',
                '  }',
                '}',
                ...Array.from({ length: 50 }, () => 'outside();')
            ].join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') {
                grid.apply(event.events);
                for (const [name, ...calls] of event.events) {
                    if (name === 'nido_pixel_scroll') pixelOffset = calls.at(-1)?.[0];
                }
            }
        });
        await session.openFile('scopes.txt');
        await session.client.request('nvim_exec_lua', [
            "assert(vim.wait(5000, function() return require('nido_brackets').pairs(0)[1] ~= nil or #require('nido_brackets').pairs(vim.api.nvim_get_current_buf()) > 0 end)); vim.wait(180); vim.cmd.redraw()",
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        await session.scroll(12.5, false, true);
        const sticky = grid.stickyScroll;
        assert.ok(sticky);
        assert.deepEqual(
            sticky.scopes.slice(0, 3).map((scope) => scope.line),
            [1, 2, 3]
        );
        assert.equal(sticky.scopes[0].text.map((part) => part.text).join(''), 'class Panel {');
        assert.equal(pixelOffset, 0.5);
        const cursor = await session.client.request('nvim_win_get_cursor', [0]);
        await session.jumpSticky(sticky.window, sticky.buffer + 999, 2);
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), cursor);
        await session.jumpSticky(sticky.window, sticky.buffer, 2);
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 0]);
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                "return require('nido_scroll').cursor() == nil",
                []
            ]),
            true
        );
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'plain text', 'no scopes'}); vim.cmd('doautocmd TextChanged'); vim.wait(300); vim.cmd.redraw()",
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.deepEqual(grid.stickyScroll?.scopes, []);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('sticky headers follow wrapped lines, virtual rows and folds, and ignore outdated outline responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-sticky-outline-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'outline.txt'),
            [
                'class Panel {',
                '  render() {',
                ...Array.from({ length: 12 }, () => '    item();'),
                '  }',
                '}',
                ...Array.from({ length: 40 }, () => 'outside();')
            ].join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.openFile('outline.txt');
        const lua = async (source: string): Promise<unknown> => {
            const timeout = setTimeout(() => session!.process.kill(), 10000);
            try {
                const result = await session!.client.request('nvim_exec_lua', [source, []]);
                await session!.client.request('nvim_eval', ['1']);
                return result;
            } finally {
                clearTimeout(timeout);
            }
        };
        await lua("vim.wait(300); vim.cmd('normal! 8Gzt'); vim.cmd.redraw()");
        const firstBottom = grid.stickyScroll!.scopes.find((scope) => scope.line === 2)!.bottom;
        await lua(
            "vim.api.nvim_buf_set_lines(0, 9, 10, false, {string.rep('x', 200)}); vim.cmd('doautocmd TextChanged'); vim.wait(300); vim.cmd.redraw()"
        );
        const wrappedBottom = grid.stickyScroll!.scopes.find((scope) => scope.line === 2)!.bottom;
        assert.ok(wrappedBottom >= firstBottom + 2, 'wrapped source lines extend the screen range');
        await lua(
            "vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace('sticky-lens-test'), 11, 0, {virt_lines={{{'Run Tests', 'NidoCodeLens'}}}, virt_lines_above=true}); vim.cmd.redraw()"
        );
        assert.equal(
            grid.stickyScroll!.scopes.find((scope) => scope.line === 2)!.bottom,
            wrappedBottom + 1
        );
        await lua("vim.wo.foldmethod='manual'; vim.cmd('11,14fold'); vim.cmd.redraw()");
        assert.equal(
            grid.stickyScroll!.scopes.find((scope) => scope.line === 2)!.bottom,
            wrappedBottom - 3
        );

        await lua(`
            _G.sticky_callbacks = {}
            local original = vim.lsp.get_clients
            vim.lsp.get_clients = function(filter)
              if filter and filter.method == 'textDocument/documentSymbol' then
                return {{initialized=true, request=function(_, _, _, callback)
                  table.insert(_G.sticky_callbacks, callback)
                end}}
              end
              return original(filter)
            end
            vim.cmd('doautocmd Syntax')
            assert(vim.wait(5000, function() return #_G.sticky_callbacks == 1 end))
            _G.sticky_callbacks[1](nil, {{name='Panel', kind=5,
              range={start={line=0,character=0}, ['end']={line=16,character=0}},
              selectionRange={start={line=0,character=0}, ['end']={line=0,character=11}}
            }})
            vim.wait(30)
            vim.cmd.redraw()
        `);
        assert.deepEqual(
            grid.stickyScroll!.scopes.map((scope) => [scope.line, scope.ending]),
            [[1, 16]]
        );
        await lua(`
            local before = #_G.sticky_callbacks
            vim.cmd('doautocmd Syntax')
            assert(vim.wait(5000, function() return #_G.sticky_callbacks > before end))
            local stale = _G.sticky_callbacks[#_G.sticky_callbacks]
            vim.api.nvim_buf_set_lines(0, 0, -1, false, {'plain text', 'no scopes'})
            stale(nil, {{name='OldScope', kind=5,
              range={start={line=0,character=0}, ['end']={line=16,character=0}}
            }})
            vim.cmd('doautocmd TextChanged')
            vim.wait(300)
            vim.cmd.redraw()
        `);
        assert.deepEqual(grid.stickyScroll!.scopes, []);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});
