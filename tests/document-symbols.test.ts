import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from '../src/main/session';
import type { DocumentSymbolList } from '../src/shared/types';

async function finished(session: Session, after = 0): Promise<DocumentSymbolList> {
    for (let attempt = 0; attempt < 600; attempt++) {
        const list = session.state.symbols;
        if (list && list.version > after && !list.loading) return list;
        await delay(5);
    }
    throw new Error('Symbol request did not finish.');
}

async function lua(session: Session, source: string, args: unknown[] = []): Promise<unknown> {
    return session.client.request('nvim_exec_lua', [source, args]);
}

const mockClient = `
local original = vim.lsp.get_clients
vim.lsp.get_clients = function(opts)
  if opts and opts.method == 'textDocument/documentSymbol'
      and debug.getinfo(2, 'S').source:find('nido_symbols', 1, true) then
    return _G.symbol_clients or {_G.symbol_client}
  end
  return original(opts)
end
`;

test('the bundled TypeScript server supplies searchable class, method and function symbols', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-symbol-typescript-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'tsconfig.json'), '{}');
        await writeFile(
            join(root, 'sample.ts'),
            'export class Widget {\n  run() { return 1; }\n}\nexport function helper() { return 2; }\n'
        );
        session = await Session.create(root, () => {});
        await session.openFile('sample.ts');
        await session.attach(80, 24);
        assert.equal(
            await lua(
                session,
                `return vim.wait(20000, function()
  for _, client in ipairs(vim.lsp.get_clients({bufnr=0, method='textDocument/documentSymbol'})) do
    if client.initialized then return true end
  end
  return false
end, 25)`
            ),
            true
        );
        const requestVersion = await session.findSymbols();
        const list = await finished(session);
        assert.ok(list.version > requestVersion);
        assert.equal(list.error, '');
        assert.deepEqual(
            list.items.map(({ name }) => name),
            ['Widget', 'run', 'helper']
        );
        assert.equal(list.items[1].container, 'Widget');
        await session.openSymbol(2, list.version);
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 2]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('document symbols flatten classes and methods, convert UTF-16 positions and preserve unsaved text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-symbols-'));
    let session: Session | undefined;
    const text = 'class Palette {\n日本語😀 method() {}\n}\nfunction tail() {}\n';
    try {
        await writeFile(join(root, 'sample.txt'), text);
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        await session.openFile('sample.txt');
        await lua(
            session,
            `
local function range(line, column)
  return {start={line=line, character=column}, ['end']={line=line, character=column+1}}
end
_G.symbol_client = {offset_encoding='utf-16', request=function(_, method, params, callback, buffer)
  assert(method == 'textDocument/documentSymbol' and buffer == vim.api.nvim_get_current_buf())
  local symbols = {
    {name='tail', kind=12, location={uri=params.textDocument.uri, range=range(3, 9)}},
    {name='Palette', kind=5, selectionRange=range(0, 6), children={
      {name='method', kind=6, selectionRange=range(1, 6)},
    }},
    {name='tail', kind=12, location={uri=params.textDocument.uri, range=range(3, 9)}},
    {name='outside', kind=12, location={uri=vim.uri_from_fname('/outside.txt'), range=range(0, 0)}},
  }
  vim.schedule(function() callback(nil, symbols) end)
  return true, 1
end}
${mockClient}
vim.api.nvim_buf_set_lines(0, 2, 3, false, {'} // unsaved'})
vim.api.nvim_win_set_cursor(0, {4, 0})
`
        );
        await session.findSymbols();
        const list = await finished(session);
        assert.equal(list.error, '');
        assert.deepEqual(list.items, [
            { name: 'Palette', kind: 'Class', container: '', line: 1, column: 7 },
            { name: 'method', kind: 'Method', container: 'Palette', line: 2, column: 15 },
            { name: 'tail', kind: 'Function', container: '', line: 4, column: 10 }
        ]);
        await session.openSymbol(2, list.version);
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 14]);
        assert.equal(await session.modified(), true);
        assert.equal(await readFile(join(root, 'sample.txt'), 'utf8'), text);
        const previous = await lua(
            session,
            'return vim.fn.getjumplist()[1][#vim.fn.getjumplist()[1]].lnum'
        );
        assert.equal(previous, 4);
        await assert.rejects(session.openSymbol(1, list.version - 1), /Symbols changed/);
        await lua(session, "vim.api.nvim_buf_set_lines(0, 0, 1, false, {'changed'})");
        await assert.rejects(session.openSymbol(1, list.version), /file changed/);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('symbol requests cancel superseded work and reject results after edits or buffer switches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-symbol-races-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'sample.txt'), 'first\nsecond\n');
        await writeFile(join(root, 'other.txt'), 'other\n');
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        await session.openFile('sample.txt');
        await lua(
            session,
            `
_G.symbol_callbacks, _G.symbol_cancelled = {}, {}
_G.symbol_client = {offset_encoding='utf-8',
  request=function(_, _, _, callback)
    table.insert(_G.symbol_callbacks, callback)
    return true, #_G.symbol_callbacks
  end,
  cancel_request=function(_, id) table.insert(_G.symbol_cancelled, id) end,
}
${mockClient}
_G.symbol_result = function(index, name)
  local range = {start={line=0, character=0}, ['end']={line=0, character=1}}
  _G.symbol_callbacks[index](nil, {{name=name, kind=12, selectionRange=range}})
end
`
        );
        await session.findSymbols();
        await session.findSymbols();
        assert.deepEqual(await lua(session, 'return _G.symbol_cancelled'), [1]);
        await lua(session, "_G.symbol_result(2, 'newest'); _G.symbol_result(1, 'obsolete')");
        const list = await finished(session);
        assert.deepEqual(
            list.items.map((item) => item.name),
            ['newest']
        );
        await session.findSymbols();
        await lua(
            session,
            "vim.api.nvim_buf_set_lines(0, 0, 1, false, {'edit'}); _G.symbol_result(3, 'before edit')"
        );
        const edited = await finished(session, list.version);
        assert.equal(edited.error, 'The file changed. Reopen symbol search.');
        assert.deepEqual(edited.items, []);
        await session.findSymbols();
        await session.openFile('other.txt');
        await lua(session, "_G.symbol_result(4, 'before switching')");
        const switched = await finished(session, edited.version);
        assert.equal(switched.error, 'The file changed. Reopen symbol search.');
        assert.deepEqual(switched.items, []);
        await assert.rejects(session.openSymbol(1, switched.version), /file changed/);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('unsupported symbol search and timed-out language servers finish with readable errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-symbol-unavailable-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'notes.txt'), 'unchanged\n');
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        await session.openFile('notes.txt');
        const requestVersion = await session.findSymbols();
        const unsupported = await finished(session);
        assert.equal(unsupported.version, requestVersion);
        assert.equal(unsupported.error, 'No language server supports symbols for this file.');
        assert.deepEqual(unsupported.items, []);
        await lua(
            session,
            `
_G.symbol_client = {offset_encoding='utf-8',
  request=function() return true, 7 end,
  cancel_request=function(_, id) assert(id == 7); _G.symbol_timeout_cancelled = true end,
}
${mockClient}
local defer = vim.defer_fn
vim.defer_fn = function(callback, timeout)
  return defer(callback, timeout == 10000 and 10 or timeout)
end
`
        );
        await session.findSymbols();
        const timedOut = await finished(session, unsupported.version);
        assert.equal(timedOut.error, 'The symbol request timed out.');
        assert.equal(await lua(session, 'return _G.symbol_timeout_cancelled'), true);
        assert.deepEqual(timedOut.items, []);
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'unchanged\n');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('synchronous symbol clients merge duplicates and malformed responses cannot crash the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-symbol-client-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'notes.txt'), 'first\nsecond\n');
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        await session.openFile('notes.txt');
        await lua(
            session,
            `
local function symbol(name, line)
  return {name=name, kind=12, selectionRange={start={line=line, character=0}, ['end']={line=line, character=1}}}
end
_G.symbol = symbol
_G.symbol_clients = {
  {offset_encoding='utf-8', request=function(_, _, _, callback)
    callback(nil, {symbol('first', 0)})
    return true, 1
  end},
  {offset_encoding='utf-8', request=function(_, _, _, callback)
    callback(nil, {symbol('first', 0), symbol('second', 1)})
    return true, 2
  end},
}
${mockClient}
`
        );
        const requestVersion = await session.findSymbols();
        const list = await finished(session);
        assert.equal(list.version, requestVersion + 2);
        assert.deepEqual(
            list.items.map((item) => item.name),
            ['first', 'second']
        );
        assert.equal(list.error, '');
        await lua(
            session,
            `_G.symbol_clients = {{offset_encoding='utf-8', request=function(_, _, _, callback)
  callback(nil, {{kind=12, selectionRange={start={line='invalid'}, ['end']={line=0,character=1}}}})
  return true, 3
end}}`
        );
        await assert.doesNotReject(session.findSymbols());
        const invalid = await finished(session, list.version);
        assert.match(invalid.error, /^Invalid symbols returned by the language server:/);
        assert.deepEqual(invalid.items, []);
        assert.equal(
            await lua(session, 'return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]'),
            'first'
        );
        await lua(
            session,
            `_G.symbol_clients = {{offset_encoding='utf-8', request=function(_, _, _, callback)
  callback(nil, {_G.symbol('valid', 0), _G.symbol(42, 0)})
  return true, 4
end}}`
        );
        await assert.doesNotReject(session.findSymbols());
        const mixed = await finished(session, invalid.version);
        assert.match(mixed.error, /^Invalid symbols returned by the language server:/);
        assert.deepEqual(
            mixed.items.map(({ name }) => name),
            ['valid']
        );
        await lua(
            session,
            `_G.symbol_clients = {
  {offset_encoding='utf-8', request=function(_, _, _, callback)
    callback({message='One server failed'})
    return true, 5
  end},
  {offset_encoding='utf-8', request=function(_, _, _, callback)
    callback(nil, {_G.symbol('still available', 1)})
    return true, 6
  end},
}`
        );
        await session.findSymbols();
        const partial = await finished(session, mixed.version);
        assert.equal(partial.error, 'One server failed');
        assert.deepEqual(
            partial.items.map(({ name }) => name),
            ['still available']
        );
        await session.openSymbol(1, partial.version);
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 0]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
