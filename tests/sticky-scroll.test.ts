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

test('sticky publication reads viewport bounds once per call and follows viewport changes', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        const result = await session.client.request('nvim_exec_lua', [
            `
local api, sticky, brackets = vim.api, require('nido_sticky'), require('nido_brackets')
local buffer, window = api.nvim_get_current_buf(), api.nvim_get_current_win()
local lines = {}
for i=1,1000 do
  lines[#lines+1]='scope ' .. i .. ' {'
  lines[#lines+1]='  content();'
  lines[#lines+1]='}'
end
api.nvim_buf_set_lines(buffer,0,-1,false,lines)
api.nvim_exec_autocmds('TextChanged',{buffer=buffer})
assert(vim.wait(10000,function() return brackets.ready(buffer) end,2))
vim.wait(400)
local original_line, original_notify = vim.fn.line, vim.rpcnotify
local latest, queries = nil, 0
vim.fn.line=function(expr,...)
  if expr=='w$' then queries=queries+1 end
  return original_line(expr,...)
end
vim.rpcnotify=function(channel,name,state,...)
  if name=='nido:sticky_scroll' then latest=state end
  return original_notify(channel,name,state,...)
end
local ok,err=pcall(function()
  for _,line in ipairs({1001,2000,501}) do
    api.nvim_win_set_cursor(window,{line,0})
    vim.cmd('normal! zt')
    local before=queries
    sticky.publish(window,buffer)
    assert(queries-before==1,'Viewport bounds were fetched for every scope')
    assert(latest and #latest.scopes>0,'Visible scopes were lost')
    for _,scope in ipairs(latest.scopes) do
      assert(scope.line<=original_line('w$') and scope.ending>=original_line('w0'),
        'Sticky state retained scopes from the old viewport')
    end
  end
end)
vim.fn.line,vim.rpcnotify=original_line,original_notify
assert(ok,err)
return true
`,
            []
        ]);
        assert.equal(result, true);
    } finally {
        await session.stop();
    }
});

test('sticky outlines cancel obsolete requests and reject late replies through failure and unload', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.client.request('nvim_exec_lua', [
            `
local api, brackets, sticky = vim.api, require('nido_brackets'), require('nido_sticky')
local buffer = api.nvim_get_current_buf()
api.nvim_buf_set_lines(buffer,0,-1,false,{'scope {','  content();','  other();','}'})
api.nvim_exec_autocmds('TextChanged',{buffer=buffer})
assert(vim.wait(5000,function() return brackets.ready(buffer) end,2))
vim.wait(400)
local held, cancelled, mode = {}, {}, 'hold'
local function symbols(line)
  return {{name='scope',kind=12,range={start={line=0,character=0},['end']={line=3,character=1}},
    selectionRange={start={line=line,character=0},['end']={line=line,character=1}}}}
end
local client_id=vim.lsp.start({name='sticky-outline-lifecycle',cmd=function(dispatchers)
  local closed,next_id=false,0
  return {
    request=function(method,_,callback,notify_reply)
      next_id=next_id+1
      local id=next_id
      local function reply(value)
        if notify_reply then notify_reply(id) end
        callback(nil,value)
      end
      if method=='initialize' then
        vim.schedule(function() reply({capabilities={textDocumentSync=1,documentSymbolProvider=true}}) end)
      elseif method=='textDocument/documentSymbol' then
        if mode=='fail' then return false end
        if mode=='sync' then reply(symbols(1))
        else held[#held+1]={id=id,reply=reply} end
      else vim.schedule(function() reply(nil) end) end
      return true,id
    end,
    notify=function(method,params)
      if method=='$/cancelRequest' then cancelled[params.id]=true end
      if method=='exit' then closed=true;dispatchers.on_exit(0,0) end
      return true
    end,
    is_closing=function() return closed end,
    terminate=function() closed=true;dispatchers.on_exit(0,0) end,
  }
end})
assert(vim.wait(5000,function() return #held>0 end,5))
local client=vim.lsp.get_client_by_id(client_id)
local function edit(value)
  api.nvim_buf_set_lines(buffer,1,2,false,{'  content(' .. value .. ');'})
  api.nvim_exec_autocmds('TextChanged',{buffer=buffer})
  vim.wait(270)
end
local function pending()
  local count=0
  for _,request in pairs(client.requests) do
    if request.method=='textDocument/documentSymbol' and request.type=='pending' then count=count+1 end
  end
  return count
end
for i=1,4 do edit(i);assert(pending()==1,'Obsolete outline requests remain pending') end
for i=1,#held-1 do assert(cancelled[held[i].id],'Old request was not cancelled') end
local original_notify,latest=vim.rpcnotify,nil
vim.rpcnotify=function(channel,name,state,...)
  if name=='nido:sticky_scroll' then latest=state end
  return original_notify(channel,name,state,...)
end
local ok,err=pcall(function()
  held[#held].reply(symbols(1))
  for i=1,#held-1 do held[i].reply(symbols(0)) end
  sticky.publish(api.nvim_get_current_win(),buffer)
  assert(latest and latest.scopes[1].line==2,'A late reply replaced the current outline')
  mode='sync';edit(5)
  sticky.publish(api.nvim_get_current_win(),buffer)
  assert(pending()==0 and latest.scopes[1].line==2,'Synchronous outline response was lost')
  mode='fail';edit(6)
  assert(pending()==0,'A failed send left a pending request')
  mode='hold';edit(7)
  held[#held].reply(symbols(1))
  sticky.publish(api.nvim_get_current_win(),buffer)
  assert(latest.scopes[1].line==2,'Outline requests did not recover after send failure')
  edit(8)
  local last=held[#held]
  api.nvim_buf_delete(buffer,{force=true})
  assert(cancelled[last.id],'Wiping the buffer did not cancel its outline request')
  last.reply(symbols(0))
end)
vim.rpcnotify=original_notify
client:stop(true)
assert(ok,err)
`,
            []
        ]);
    } finally {
        await session.stop();
    }
});

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
        const bracketColors = (): string[][] =>
            grid
                .stickyScroll!.scopes.slice(0, 2)
                .map((scope) =>
                    scope.text.flatMap((span) =>
                        [...span.text]
                            .filter((character) => /[(){}]/.test(character))
                            .map(() => span.color)
                    )
                );
        assert.deepEqual(bracketColors(), [['#ffd700'], ['#da70d6', '#da70d6', '#da70d6']]);
        assert.equal(grid.stickyScroll!.scopes[0].endText.at(-1)?.color, '#ffd700');
        assert.equal(grid.stickyScroll!.scopes[1].endText.at(-1)?.color, '#da70d6');
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
        assert.deepEqual(bracketColors(), [['#ffd700'], ['#da70d6', '#da70d6', '#da70d6']]);
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
                  return true, #_G.sticky_callbacks
                end, cancel_request=function() return true end}}
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
