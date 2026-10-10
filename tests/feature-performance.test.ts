import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { SessionFiles } from '../src/main/sessionFiles';
import { HistoryService } from '../src/main/historyService';
import type { LocalHistory } from '../src/main/localHistory';

async function withSession(check: (session: Session) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'nido-feature-performance-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'sample.txt'), 'one\ntwo\n');
        session = await Session.create(root, () => {});
        await session.openFile('sample.txt');
        await check(session);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

test('line ending detection scans only changed lines and tracks inserts, deletes, options and reloads', () =>
    withSession(async (session) => {
        await session.client.request('nvim_exec_lua', [
            `
local api, module = vim.api, require('nido_eol')
local lines = {}
for i=1,10000 do lines[i] = 'row ' .. i end
api.nvim_buf_set_lines(0, 0, -1, false, lines)
assert(module.detect() == 'LF')
local get_lines = api.nvim_buf_get_lines
local full, read = 0, 0
api.nvim_buf_get_lines = function(buffer, first, last, strict)
  local result = get_lines(buffer, first, last, strict)
  if first == 0 and last == -1 then full = full + 1 end
  read = read + #result
  return result
end
local ok, err = pcall(function()
  for i=1,20 do
    api.nvim_buf_set_lines(0, 0, 1, false, {'edit ' .. i})
    assert(module.detect() == 'LF')
  end
  assert(full == 0 and read == 20, '20 edits read only 20 changed lines')
  api.nvim_buf_set_lines(0, 0, -1, false, {'one\\r', 'two'})
  assert(module.detect() == 'Mixed')
  vim.bo.endofline = false
  assert(module.detect() == 'CRLF')
  api.nvim_buf_set_lines(0, 0, 0, false, {'inserted'})
  assert(module.detect() == 'Mixed')
  api.nvim_buf_set_lines(0, 1, 2, false, {})
  assert(module.detect() == 'LF')
  vim.bo.fileformat = 'dos'
  assert(module.detect() == 'CRLF')
  vim.bo.fileformat = 'unix'
  assert(module.detect() == 'LF')
  vim.fn.writefile({'one\\r', 'two'}, api.nvim_buf_get_name(0))
  vim.cmd('edit! ++ff=unix')
  assert(module.detect() == 'Mixed', 'reload rebuilds line-ending metadata')
end)
api.nvim_buf_get_lines = get_lines
assert(ok, err)
`,
            []
        ]);
    }));

test('reference searches cancel old requests, publish partial results and finish after a timeout', () =>
    withSession(async (session) => {
        await session.client.request('nvim_exec_lua', [
            `
local module = require('nido_references')
local clients, locations, notify, defer = vim.lsp.get_clients, vim.lsp.util.locations_to_items, vim.rpcnotify, vim.defer_fn
local latest, callbacks, cancelled = {}, {}, 0
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:references' then latest = vim.deepcopy(state); return end
  return notify(channel, method, state, ...)
end
vim.lsp.util.locations_to_items = function(items) return items end
vim.defer_fn = function(callback, delay) return defer(callback, delay == 10000 and 50 or delay) end
vim.lsp.get_clients = function(options)
  if not options or options.method ~= 'textDocument/references' then return clients(options) end
  return {
    {offset_encoding='utf-16', request=function(_, _, _, callback)
      callback(nil, {{filename=vim.api.nvim_buf_get_name(0), lnum=1, col=1, text='one'}})
      return true, 1
    end},
    {offset_encoding='utf-16', request=function(_, _, _, callback)
      table.insert(callbacks, callback); return true, #callbacks
    end, cancel_request=function() cancelled = cancelled + 1 end},
  }
end
local ok, err = pcall(function()
  module.find()
  assert(latest.loading and #latest.items == 1, 'fast server publishes results before slow server')
  local old_version = latest.version
  module.find()
  assert(cancelled == 1, 'new search cancels the old slow request')
  assert(not pcall(module.preview, 1, old_version), 'old result indices are rejected')
  callbacks[1](nil, {})
  assert(latest.loading, 'stale callbacks cannot finish a new search')
  assert(vim.wait(1000, function() return not latest.loading end, 5))
  assert(cancelled == 2 and #latest.items == 1 and latest.error:find('timed out'))
  callbacks[2](nil, {})
  assert(#latest.items == 1, 'late callbacks cannot replace the timeout result')
end)
vim.lsp.get_clients, vim.lsp.util.locations_to_items, vim.rpcnotify, vim.defer_fn = clients, locations, notify, defer
assert(ok, err)
`,
            []
        ]);
    }));

test('debugger batches output bursts while final state and last output are immediate', () =>
    withSession(async (session) => {
        await session.client.request('nvim_exec_lua', [
            `
require('nido_debug').action('breakpoint', vim.g.nido_channel)
local dap, notify = require('dap'), vim.rpcnotify
local count, latest = 0, {}
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:debug' then count = count + 1; latest = vim.deepcopy(state); return end
  return notify(channel, method, state, ...)
end
local ok, err = pcall(function()
  for _=1,20 do dap.listeners.after.event_output.nido(nil, {output=string.rep('x', 1000)}) end
  assert(count == 0, 'output bursts wait for a single flush')
  assert(vim.wait(1000, function() return count == 1 end, 5))
  assert(#latest.output == 20000)
  dap.listeners.after.event_output.nido(nil, {output='tail'})
  dap.listeners.after.event_terminated.nido()
  assert(count == 2 and latest.status == 'finished' and latest.output:sub(-4) == 'tail')
  vim.wait(100, function() return false end, 5)
  assert(count == 2, 'final publication cancels the pending output flush')
end)
vim.rpcnotify = notify
assert(ok, err)
`,
            []
        ]);
    }));

test('Markdown snapshots skip unchanged text and follow unsaved edits', () =>
    withSession(async (session) => {
        await session.client.request('nvim_exec_lua', [
            "vim.bo.filetype='markdown'; vim.api.nvim_buf_set_lines(0, 0, -1, false, {'# Draft'})",
            []
        ]);
        const first = await session.markdownPreview();
        assert.equal(first.text, '# Draft');
        const unchanged = await session.markdownPreview(first.token);
        assert.equal(unchanged.text, undefined);
        assert.equal(unchanged.token, first.token);
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 0, 1, false, {'# Changed'})",
            []
        ]);
        const changed = await session.markdownPreview(first.token);
        assert.equal(changed.text, '# Changed');
        assert.notEqual(changed.token, first.token);
        assert.equal(await session.modified(), true);
    }));

test('queued history previews only calculate the latest request', async () => {
    let calculated = 0;
    const snapshot = {
        path: '/notes.txt',
        buffer: 1,
        tick: 1,
        fileformat: 'unix',
        endOfLine: true,
        modified: false,
        text: 'current\n'
    };
    const session = {
        historyCurrent: async () => snapshot,
        historyDiff: async () => {
            calculated++;
            return '';
        }
    } as unknown as Session;
    const store = {
        version: async (_path: string, id: string) => ({
            id,
            timestamp: 1,
            kind: 'draft',
            bytes: 8,
            lines: 1,
            text: 'before\n'
        })
    } as unknown as LocalHistory;
    const service = new HistoryService(store);
    const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => service.preview(session, snapshot.path, String(i)))
    );
    assert.equal(calculated, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 19);
    assert.equal(results[19].status, 'fulfilled');
});

test('file search finds matches past 5000 entries and twelve levels, supports cancellation and refreshes cached directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-file-search-'));
    try {
        await mkdir(join(root, 'a'));
        for (let start = 0; start < 5100; start += 100) {
            await Promise.all(
                Array.from({ length: 100 }, (_, i) =>
                    writeFile(join(root, 'a', `file-${start + i}.txt`), '')
                )
            );
        }
        const deep = Array(14).fill('deep').join('/');
        await mkdir(join(root, deep), { recursive: true });
        await writeFile(join(root, deep, 'unique-target.ts'), '');
        const files = new SessionFiles(root, {} as Session['client']);
        assert.equal((await files.findFiles()).length, 100);
        assert.equal((await files.findFiles('file-5099')).length, 1);
        assert.equal((await files.findFiles('unique-target')).length, 1);
        const pending = files.findFiles('no-match');
        files.cancelFindFiles();
        assert.deepEqual(await pending, []);
        const small = join(root, 'small');
        await mkdir(small);
        await writeFile(join(small, 'before.txt'), '');
        const cached = new SessionFiles(small, {} as Session['client']);
        let reads = 0;
        const read = cached.files.bind(cached);
        cached.files = async (...args) => {
            reads++;
            return read(...args);
        };
        await cached.findFiles();
        await cached.findFiles();
        assert.equal(reads, 1, 'unchanged directory entries are reused');
        await writeFile(join(small, 'added.txt'), '');
        const changedTime = new Date(Date.now() + 1000);
        await utimes(small, changedTime, changedTime);
        assert.equal((await cached.findFiles('added')).length, 1);
        await unlink(join(small, 'added.txt'));
        const removedTime = new Date(Date.now() + 2000);
        await utimes(small, removedTime, removedTime);
        assert.equal((await cached.findFiles('added')).length, 0);
        await cached.fileAction('createFile', 'created.txt', '', async () => {});
        assert.equal((await cached.findFiles('created')).length, 1);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
