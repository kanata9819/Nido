import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHistory } from '../src/main/localHistory';
import { HistoryService } from '../src/main/historyService';
import { Session } from '../src/main/session';
import type { HistoryContent, HistoryToken, HistoryVersion } from '../src/shared/history';

const content = (text: string): HistoryContent => ({
    text,
    endOfLine: text.endsWith('\n'),
    fileformat: 'unix'
});

async function fixture(context: TestContext): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-time-machine-')));
    context.after(() =>
        rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    );
    return root;
}

test('local history serializes concurrent revisions, avoids duplicate writes and survives restart', async (context) => {
    const root = await fixture(context);
    const directory = join(root, 'history');
    const file = join(root, '日本語 notes.txt');
    const store = new LocalHistory(directory);
    const versions = await Promise.all(
        ['one\n', 'two\n', 'three\n'].map((text) => store.record(file, content(text), 'draft'))
    );
    assert.equal((await store.list(file)).length, 3);
    const historyPath = join(directory, (await readdir(directory))[0]);
    const before = await stat(historyPath);
    assert.equal((await store.record(file, content('three\n'), 'draft')).id, versions[2].id);
    assert.equal((await stat(historyPath)).mtimeMs, before.mtimeMs);
    const restarted = new LocalHistory(directory);
    assert.deepEqual(
        (await restarted.list(file)).map((version) => version.id),
        versions.toReversed().map((version) => version.id)
    );
    assert.equal((await restarted.version(file, versions[0].id)).text, 'one\n');
    assert.equal('text' in (await restarted.list(file))[0], false);
});

test('history retention bounds per-file revisions and total disk usage without touching unrelated files', async (context) => {
    const root = await fixture(context);
    const directory = join(root, 'history');
    const limits = { versions: 3, historyBytes: 1800, totalBytes: 2400, files: 2 };
    const store = new LocalHistory(directory, limits);
    const first = join(root, 'first.txt');
    for (let i = 0; i < 8; i++)
        await store.record(first, content(`${i}${'x'.repeat(250)}\n`), 'draft');
    assert.ok((await store.list(first)).length <= 3);
    await writeFile(join(directory, 'keep.txt'), 'unrelated');
    await store.record(join(root, 'second.txt'), content('second\n'), 'saved');
    await store.record(join(root, 'third.txt'), content('third\n'), 'saved');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    assert.ok(files.length <= limits.files);
    const sizes = await Promise.all(
        files.map(async (name) => (await stat(join(directory, name))).size)
    );
    assert.ok(sizes.every((size) => size <= limits.historyBytes));
    assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= limits.totalBytes);
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'unrelated');
    assert.equal((await store.list(join(root, 'third.txt'))).length, 1);
    assert.equal((await store.list(first)).length, 0);
});

test('damaged history is reported and preserved instead of overwritten', async (context) => {
    const root = await fixture(context);
    const directory = join(root, 'history');
    const store = new LocalHistory(directory);
    const file = join(root, 'notes.txt');
    await store.record(file, content('original\n'), 'saved');
    const historyPath = join(directory, (await readdir(directory))[0]);
    await writeFile(historyPath, '{interrupted');
    await assert.rejects(store.record(file, content('new\n'), 'draft'), SyntaxError);
    assert.equal(await readFile(historyPath, 'utf8'), '{interrupted');
});

test('unsaved drafts survive a new Neovim session and restore without writing the file, with native undo', async (context) => {
    const root = await fixture(context);
    const file = join(root, 'notes.txt');
    await writeFile(file, 'original\nsecond\n');
    let session = await Session.create(root, () => {});
    const directory = join(root, 'history');
    let service = new HistoryService(new LocalHistory(directory));
    try {
        await session.openFile('notes.txt');
        await session.input('gg0Cunsaved draft<Esc>');
        await session.inputMode();
        await service.capture(session);
        const history = await service.list(session);
        const draft = history.versions.find((version) => version.kind === 'draft')!;
        assert.ok(draft);
        assert.equal(
            history.versions.some((version) => version.kind === 'saved'),
            true
        );
        await session.stop();
        session = await Session.create(root, () => {});
        await session.openFile('notes.txt');
        service = new HistoryService(new LocalHistory(directory));
        const afterRestart = await service.list(session);
        assert.equal(
            afterRestart.versions.some((version) => version.id === draft.id),
            true
        );
        const preview = await service.preview(session, file, draft.id);
        assert.match(preview.diff, /-unsaved draft/);
        await service.restore(session, file, draft.id, preview.token);
        assert.equal(await session.client.request('nvim_get_current_line', []), 'unsaved draft');
        assert.equal(await session.bufferModified(session.state.current), true);
        assert.equal(await readFile(file, 'utf8'), 'original\nsecond\n');
        await session.input('u');
        await session.inputMode();
        assert.equal(await session.client.request('nvim_get_current_line', []), 'original');
    } finally {
        await session.stop();
    }
});

test('restoration rejects stale text, changed line endings and read-only buffers', async (context) => {
    const root = await fixture(context);
    await writeFile(join(root, 'notes.txt'), 'original\n');
    const session = await Session.create(root, () => {});
    const service = new HistoryService(new LocalHistory(join(root, 'history')));
    const lua = (code: string): Promise<unknown> =>
        session.client.request('nvim_exec_lua', [code, []]);
    try {
        await session.openFile('notes.txt');
        const { path, versions } = await service.list(session);
        await session.input('Cfirst draft<Esc>');
        await session.inputMode();
        const preview = await service.preview(session, path, versions[0].id);
        await session.input('0Cnewer draft<Esc>');
        await session.inputMode();
        await assert.rejects(
            service.restore(session, path, versions[0].id, preview.token),
            /file changed/
        );
        const next = await service.preview(session, path, versions[0].id);
        const tick = await lua('return vim.api.nvim_buf_get_changedtick(0)');
        await lua("vim.bo.fileformat = 'dos'");
        assert.equal(await lua('return vim.api.nvim_buf_get_changedtick(0)'), tick);
        await assert.rejects(
            service.restore(session, path, versions[0].id, next.token),
            /file changed/
        );
        await lua('vim.bo.readonly = true');
        const readonly = await service.preview(session, path, versions[0].id);
        await assert.rejects(
            service.restore(session, path, versions[0].id, readonly.token),
            /read-only/
        );
        assert.equal(await session.client.request('nvim_get_current_line', []), 'newer draft');
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'original\n');
    } finally {
        await session.stop();
    }
});

test('the first dirty snapshot preserves the disk baseline line endings independently of current edits', async (context) => {
    const root = await fixture(context);
    const file = join(root, 'notes.txt');
    await writeFile(file, 'original\r\nsecond\r\n');
    const session = await Session.create(root, () => {});
    const service = new HistoryService(new LocalHistory(join(root, 'history')));
    try {
        await session.openFile('notes.txt');
        await session.input('gg0Cdraft<Esc>');
        await session.inputMode();
        await session.client.request('nvim_exec_lua', ["vim.bo.fileformat = 'unix'", []]);
        await service.capture(session);
        const { path, versions } = await service.list(session);
        const baseline = await service.store.version(
            path,
            versions.find((v) => v.kind === 'saved')!.id
        );
        assert.equal(baseline.text, 'original\nsecond\n');
        assert.equal(baseline.fileformat, 'dos');
        assert.equal((await service.store.version(path, versions[0].id)).fileformat, 'unix');
    } finally {
        await session.stop();
    }
});

test('history write failures before restoration keep the buffer intact and failures afterward report partial success', async (context) => {
    const root = await fixture(context);
    const file = join(root, 'notes.txt');
    await writeFile(file, 'original\n');
    class FailingHistory extends LocalHistory {
        fail: 'all' | 'restored' | undefined;
        override record(
            path: string,
            value: HistoryContent,
            kind: HistoryVersion['kind']
        ): Promise<HistoryVersion> {
            if (this.fail === 'all' || (this.fail === 'restored' && kind === 'restored'))
                return Promise.reject(new Error('Disk full'));
            return super.record(path, value, kind);
        }
    }
    const store = new FailingHistory(join(root, 'history'));
    const service = new HistoryService(store);
    const session = await Session.create(root, () => {});
    try {
        await session.openFile('notes.txt');
        const { path, versions } = await service.list(session);
        await session.input('gg0Ckeep my draft<Esc>');
        await session.inputMode();
        const preview = await service.preview(session, path, versions[0].id);
        store.fail = 'all';
        await assert.rejects(
            service.restore(session, path, versions[0].id, preview.token),
            /Disk full/
        );
        assert.equal(await session.client.request('nvim_get_current_line', []), 'keep my draft');
        store.fail = 'restored';
        assert.equal(await service.restore(session, path, versions[0].id, preview.token), false);
        assert.equal(await session.client.request('nvim_get_current_line', []), 'original');
        const kept = (await store.list(path))[0];
        assert.equal((await store.version(path, kept.id)).text, 'keep my draft\n');
        assert.equal(await readFile(file, 'utf8'), 'original\n');
    } finally {
        await session.stop();
    }
});

test('unchanged history transfers no text and oversized buffers stay outside the background capture', async (context) => {
    const root = await fixture(context);
    await writeFile(join(root, 'notes.txt'), 'small\n');
    await writeFile(join(root, 'binary.dat'), Buffer.from('head\0tail\n'));
    const session = await Session.create(root, () => {});
    try {
        await session.openFile('notes.txt');
        const initial = await session.historySnapshots([]);
        assert.equal(initial.length, 1);
        const tokens: HistoryToken[] = initial.map((value) => [
            value.buffer,
            value.tick,
            value.fileformat,
            value.endOfLine
        ]);
        assert.deepEqual(await session.historySnapshots(tokens), []);
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 0, -1, false, {string.rep('x', 1048577)})",
            []
        ]);
        assert.deepEqual(await session.historySnapshots(tokens), []);
        await assert.rejects(session.historyCurrent(), /1 MB and 20,000 lines/);
        await session.openFile('binary.dat');
        await assert.rejects(session.historyCurrent(), /only supports text files/);
        await session.client.request('nvim_exec_lua', [
            `for i = 1, 12 do
              local b = vim.api.nvim_create_buf(true, false)
              vim.api.nvim_buf_set_name(b, vim.fn.getcwd() .. '/draft-' .. i .. '.txt')
              vim.api.nvim_buf_set_lines(b, 0, -1, false, {'draft ' .. i})
              vim.api.nvim_set_current_buf(b)
            end`,
            []
        ]);
        const batch = await session.historySnapshots([]);
        assert.equal(batch.length, 8);
        assert.ok(
            batch[0].path.endsWith('draft-12.txt'),
            'the active draft must not wait behind restored buffers'
        );
    } finally {
        await session.stop();
    }
});
