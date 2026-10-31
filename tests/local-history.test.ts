import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHistory } from '../src/main/localHistory';
import { HistoryService } from '../src/main/historyService';
import { Session } from '../src/main/session';
import {
  historyLimits,
  type HistoryContent,
  type HistoryToken,
  type HistoryVersion
} from '../src/shared/history';
import type { NidoEvent } from '../src/shared/types';

const content = (text: string): HistoryContent => ({
  text,
  endOfLine: text.endsWith('\n'),
  fileformat: 'unix'
});

async function fixture(context: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-time-machine-')));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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

test('recorded history lists contain only committed retained metadata in transaction order', async (context) => {
  const root = await fixture(context);
  const directory = join(root, 'history');
  const file = join(root, 'notes.txt');
  const store = new LocalHistory(directory, {
    versions: 2,
    historyBytes: 1800,
    totalBytes: 10000,
    files: 200
  });
  const lists = await Promise.all(
    ['first\n', 'second\n', 'third\n'].map((text) =>
      store.recordAndList(file, content(text), 'draft')
    )
  );
  assert.deepEqual(
    lists.map((list) => list.length),
    [1, 2, 2]
  );
  assert.equal(lists[1][1].id, lists[0][0].id);
  assert.equal(lists[2][1].id, lists[1][0].id);
  assert.ok(lists.flat().every((version) => !('text' in version)));
  assert.deepEqual(await new LocalHistory(directory).list(file), lists[2]);

  // Escaped content exceeds the byte budget before the revision count limit.
  const retained = await store.recordAndList(file, content('\u0001'.repeat(240)), 'draft');
  assert.equal(retained.length, 1);
  assert.deepEqual(await new LocalHistory(directory).list(file), retained);
});

test('history lists read existing revisions once and still detect external changes and corruption', async (context) => {
  const root = await fixture(context);
  const directory = join(root, 'history');
  const file = join(root, 'notes.txt');
  const store = new LocalHistory(directory);
  const value = { ...content('current\n'), path: file, buffer: 1, tick: 1, modified: false };
  await store.record(file, content('previous\n'), 'saved');
  await store.record(file, value, 'saved');
  const historyPath = join(directory, (await readdir(directory))[0]);
  const before = await stat(historyPath);
  const service = new HistoryService(store);
  const session = { historyCurrent: async () => value } as unknown as Session;
  let parsed = 0;
  const parse = JSON.parse;
  const mocked = context.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    parsed++;
    return parse(...args);
  });
  const listed = await service.list(session);
  mocked.mock.restore();
  assert.equal(parsed, 1, 'opening history must parse the existing history only once');
  assert.equal(listed.versions.length, 2);
  assert.equal((await stat(historyPath)).mtimeMs, before.mtimeMs);
  assert.ok(listed.versions.every((version) => !('text' in version)));

  const external = await new LocalHistory(directory).record(
    file,
    content('external revision\n'),
    'saved'
  );
  assert.ok((await service.list(session)).versions.some((version) => version.id === external.id));
  const valid = await readFile(historyPath, 'utf8');
  await writeFile(historyPath, '{interrupted');
  await assert.rejects(service.list(session), SyntaxError);
  assert.equal(await readFile(historyPath, 'utf8'), '{interrupted');
  await writeFile(historyPath, valid);
  assert.equal((await service.list(session)).versions.length, 4);
});

test('a failed history list write preserves committed revisions and permits retry', async (context) => {
  const root = await fixture(context);
  const directory = join(root, 'history');
  const file = join(root, 'notes.txt');
  const store = new LocalHistory(directory);
  const original = await store.record(file, content('original\n'), 'saved');
  const historyPath = join(directory, (await readdir(directory))[0]);
  const before = await readFile(historyPath, 'utf8');
  const value = { ...content('edited\n'), path: file, buffer: 1, tick: 2, modified: true };
  const service = new HistoryService(store);
  const session = { historyCurrent: async () => value } as unknown as Session;
  await mkdir(`${historyPath}.tmp`);
  await assert.rejects(service.list(session));
  assert.equal(await readFile(historyPath, 'utf8'), before);
  await rm(`${historyPath}.tmp`, { recursive: true });
  const retried = await service.list(session);
  assert.equal(retried.versions.length, 2);
  assert.equal(retried.versions[1].id, original.id);
  assert.equal((await store.version(file, retried.versions[0].id)).text, value.text);
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

test('history retention budgets escaped JSON and UTF-8 exactly and preserves history on overflow', async (context) => {
  const root = await fixture(context);
  const directory = join(root, 'history');
  const file = join(root, '日本語 "notes".txt');
  const original = new LocalHistory(directory);
  const first = await original.record(file, content('日本語\\\t\r\n'), 'saved');
  const historyPath = join(directory, (await readdir(directory))[0]);
  const saved = await readFile(historyPath, 'utf8');
  const bytes = Buffer.byteLength(saved);
  const exact = new LocalHistory(directory, {
    versions: 20,
    historyBytes: bytes,
    totalBytes: bytes,
    files: 200
  });
  const second = await exact.record(file, content('日本語\\\t\r\n'), 'draft');
  assert.equal(second.id, first.id, 'an identical revision fits the exact byte limit');
  const replacement = await exact.record(file, content('別の語\\\t\r\n'), 'draft');
  assert.equal((await stat(historyPath)).size, bytes);
  assert.deepEqual(
    (await exact.list(file)).map(({ id }) => id),
    [replacement.id]
  );
  assert.equal((await exact.version(file, replacement.id)).text, '別の語\\\t\r\n');
  const before = await readFile(historyPath, 'utf8');
  await assert.rejects(
    exact.record(file, content('\u0001'.repeat(bytes)), 'draft'),
    /storage is full/
  );
  assert.equal(await readFile(historyPath, 'utf8'), before);
  assert.deepEqual(await new LocalHistory(directory).list(file), await exact.list(file));
});

test('history retention serializes large revisions once while discarding the oldest versions', async (context) => {
  const root = await fixture(context);
  const directory = join(root, 'history');
  const file = join(root, 'large.txt');
  const store = new LocalHistory(directory, { ...historyLimits, historyBytes: 8 * 1024 * 1024 });
  const versions: HistoryVersion[] = [];
  for (let i = 0; i < 8; i++) {
    versions.push(await store.record(file, content(`${i}${'x'.repeat(800_000)}`), 'draft'));
  }
  const stringify = JSON.stringify;
  let serializedBytes = 0;
  let latest: HistoryVersion;
  const started = performance.now();
  try {
    JSON.stringify = (value, replacer, space) => {
      const result = stringify(value, replacer as never, space);
      if (typeof result === 'string') serializedBytes += Buffer.byteLength(result);
      return result;
    };
    latest = await store.record(file, content('\u0001'.repeat(800_000)), 'draft');
  } finally {
    JSON.stringify = stringify;
  }
  context.diagnostic(JSON.stringify({ serializedBytes, recordMs: performance.now() - started }));
  if (!process.env.NIDO_PERFORMANCE_BASELINE) {
    assert.ok(
      serializedBytes < 12 * 1024 * 1024,
      `encoded ${serializedBytes} bytes for an 8 MiB history`
    );
  }
  const remaining = await store.list(file);
  assert.deepEqual(
    remaining.map(({ id }) => id),
    [
      latest.id,
      ...versions
        .slice(-4)
        .reverse()
        .map(({ id }) => id)
    ]
  );
  assert.equal((await store.version(file, latest.id)).text, '\u0001'.repeat(800_000));
  const historyPath = join(directory, (await readdir(directory))[0]);
  assert.ok((await stat(historyPath)).size <= 8 * 1024 * 1024);
  assert.deepEqual(await new LocalHistory(directory).list(file), remaining);
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

test('a draft larger than the former limit can be recovered after restarting', async (context) => {
  const root = await fixture(context);
  const file = join(root, 'large.txt');
  const original = `original\n${`${'x'.repeat(1024)}\n`.repeat(1100)}`;
  await writeFile(file, original);
  const directory = join(root, 'history');
  let session = await Session.create(root, () => {});
  let service = new HistoryService(new LocalHistory(directory));
  try {
    await session.openFile('large.txt');
    await session.input('gg0iDRAFT <Esc>');
    await session.inputMode();
    await service.capture(session);
    const draft = (await service.store.list(file)).find((version) => version.kind === 'draft')!;
    assert.ok(draft);
    assert.ok(draft.bytes > 1024 * 1024);
    await session.stop();
    session = await Session.create(root, () => {});
    service = new HistoryService(new LocalHistory(directory));
    await session.openFile('large.txt');
    const preview = await service.preview(session, file, draft.id);
    await service.restore(session, file, draft.id, preview.token);
    const restored = (await session.historyCurrent()).text;
    assert.equal(restored, `DRAFT ${original}`);
    assert.equal(await readFile(file, 'utf8'), original);
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
  const notices: Extract<NidoEvent, { type: 'notification' }>[] = [];
  const session = await Session.create(root, (event) => {
    if (event.type === 'notification') notices.push(event);
  });
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
      "vim.api.nvim_buf_set_lines(0, 0, -1, false, {string.rep('x', 4194305)})",
      []
    ]);
    assert.deepEqual(await session.historySnapshots(tokens), []);
    await assert.rejects(session.historyCurrent(), /4 MiB and 100,000 lines/);
    assert.equal(
      notices.filter((notice) => notice.message.includes('exceeds the Time Machine limit')).length,
      1
    );
    await session.historySnapshots(tokens);
    assert.equal(
      notices.filter((notice) => notice.message.includes('exceeds the Time Machine limit')).length,
      1
    );
    await session.client.request('nvim_exec_lua', [
      "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'small again'})",
      []
    ]);
    await session.historySnapshots(tokens);
    await session.client.request('nvim_exec_lua', [
      "vim.api.nvim_buf_set_lines(0, 0, -1, false, {string.rep('x', 4194305)})",
      []
    ]);
    await session.historySnapshots(tokens);
    assert.equal(
      notices.filter((notice) => notice.message.includes('exceeds the Time Machine limit')).length,
      2
    );
    await session.client.request('nvim_exec_lua', [
      `local b = vim.api.nvim_create_buf(true, false)
       vim.api.nvim_buf_set_name(b, vim.fn.getcwd() .. '/second-large.txt')
       vim.api.nvim_buf_set_lines(b, 0, -1, false, {string.rep('x', 4194305)})
       vim.api.nvim_set_current_buf(b)`,
      []
    ]);
    await session.historySnapshots(tokens);
    const warnings = notices.filter((notice) =>
      notice.message.includes('exceeds the Time Machine limit')
    );
    assert.equal(warnings.length, 3);
    assert.match(warnings[2].title, /second-large\.txt/);
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
