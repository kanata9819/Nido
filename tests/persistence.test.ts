import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayout, writeLayout, type SavedLayout } from '../src/main/persistence';
import { WorkspaceCheckpoints } from '../src/main/workspaceCheckpoints';
import { Session } from '../src/main/session';
import { explorerFilePath } from '../src/renderer/src/explorerState';

test('Explorer resolves workspace files across Windows separators and WSL aliases', () => {
  for (const [root, file, expected] of [
    ['C:\\Project', 'c:/PROJECT/src/Main.ts', 'src\\main.ts'],
    ['C:/Project/', 'C:\\project\\main.ts', 'main.ts'],
    ['C:\\Project', 'C:\\Projects\\main.ts', ''],
    ['C:\\Project', 'term://C:/Project/shell', ''],
    ['C:\\Project', '', ''],
    ['C:\\Project', 'C:\\Project\\..\\outside.ts', ''],
    ['C:\\Project', 'C:\\Project', ''],
    ['/', '/main.ts', 'main.ts'],
    ['/Project', '/Project/src/Main.ts', 'src/Main.ts'],
    ['/Project', '/project/main.ts', ''],
    [
      '\\\\wsl.localhost\\Fedora\\home\\me\\Project',
      '//wsl$/fedora/home/me/Project/src/Main.ts',
      'src\\Main.ts'
    ],
    ['\\\\wsl$\\Fedora\\Project', '\\\\wsl.localhost\\Fedora\\project\\main.ts', ''],
    ['\\\\wsl$\\Fedora\\Project', '\\\\wsl$\\Ubuntu\\Project\\main.ts', '']
  ]) {
    assert.equal(explorerFilePath(root, file), expected, `${root}: ${file}`);
  }
});

async function temporaryRoot(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nido-checkpoints-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function layoutFor(root: string, line = 1): SavedLayout {
  const file = join(root, 'notes.txt');
  return {
    version: 1,
    active: 0,
    workspaces: [{ root, current: file, files: [{ path: file, line, column: 0 }] }]
  };
}

test('layouts recover the last valid backup after a corrupt or missing primary file', async (context) => {
  const root = await temporaryRoot(context);
  const path = join(root, 'workspaces.json');
  const original = layoutFor(root);
  await writeLayout(path, original);
  await writeLayout(path, layoutFor(root, 2));
  await writeFile(path, '{interrupted');
  assert.deepEqual(await readLayout(path), original);
  await rm(path);
  assert.deepEqual(await readLayout(path), original);
});

test('repairing a corrupt primary preserves its last valid backup', async (context) => {
  const root = await temporaryRoot(context);
  const path = join(root, 'workspaces.json');
  const original = layoutFor(root);
  await writeLayout(path, original);
  await writeLayout(path, layoutFor(root, 2));
  await writeFile(path, '{}');
  await writeLayout(path, layoutFor(root, 3));
  assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')), original);
  assert.deepEqual(await readLayout(path), layoutFor(root, 3));
});

test('unrecoverable layouts fail instead of silently restoring an empty workspace', async (context) => {
  const root = await temporaryRoot(context);
  const path = join(root, 'workspaces.json');
  assert.deepEqual(await readLayout(path), { version: 1, active: 0, workspaces: [] });
  await writeFile(path, '{}');
  await assert.rejects(readLayout(path), /Invalid saved workspace/);
  await rm(path);
  await writeFile(`${path}.bak`, '{interrupted');
  await assert.rejects(readLayout(path), SyntaxError);
});

test('overlapping checkpoints share a write and unchanged layouts avoid extra disk writes', async (context) => {
  const root = await temporaryRoot(context);
  let release!: (layout: SavedLayout) => void;
  let snapshot: Promise<SavedLayout> = new Promise((resolve) => {
    release = resolve;
  });
  const writes: SavedLayout[] = [];
  const checkpoints = new WorkspaceCheckpoints(
    () => snapshot,
    async (layout) => {
      writes.push(layout);
    },
    (error) => {
      throw error;
    }
  );
  const first = checkpoints.save();
  assert.equal(checkpoints.save(), first);
  release(layoutFor(root));
  await checkpoints.idle();
  assert.equal(writes.length, 1);
  await checkpoints.save();
  assert.equal(writes.length, 1);
  snapshot = Promise.resolve(layoutFor(root, 2));
  await checkpoints.save();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].workspaces[0].files[0].line, 2);
});

test('failed checkpoint writes are retried without repeated error notifications', async (context) => {
  const root = await temporaryRoot(context);
  let fail = true;
  let writes = 0;
  const errors: unknown[] = [];
  const checkpoints = new WorkspaceCheckpoints(
    async () => layoutFor(root),
    async () => {
      if (fail) throw new Error('Disk is unavailable');
      writes++;
    },
    (error) => errors.push(error)
  );
  await checkpoints.save();
  await checkpoints.save();
  assert.equal(errors.length, 1);
  fail = false;
  await checkpoints.save();
  assert.equal(writes, 1);
});

test('checkpoints retain the latest save requested during a slow write without overlapping writes', async (context) => {
  const root = await temporaryRoot(context);
  let line = 1;
  let snapshots = 0;
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: number[] = [];
  let active = 0;
  let maximum = 0;
  const checkpoints = new WorkspaceCheckpoints(
    async () => {
      snapshots++;
      return layoutFor(root, line);
    },
    async (layout) => {
      maximum = Math.max(maximum, ++active);
      writes.push(layout.workspaces[0].files[0].line);
      if (writes.length === 1) {
        started();
        await blocked;
      }
      active--;
    },
    (error) => {
      throw error;
    }
  );
  const first = checkpoints.save();
  await writing;
  for (line = 2; line <= 21; line++) {
    assert.equal(checkpoints.save(), first);
  }
  line = 21;
  assert.deepEqual(writes, [1]);
  release();
  await checkpoints.idle();
  assert.deepEqual(writes, [1, 21], 'idle includes the newest requested layout');
  assert.equal(maximum, 1);
  assert.equal(snapshots, 2, '20 intervening requests share one follow-up snapshot');
  await checkpoints.save();
  assert.deepEqual(writes, [1, 21], 'unchanged layouts still avoid disk writes');
});

test('disposing checkpoints suppresses a queued follow-up after an in-flight write', async (context) => {
  const root = await temporaryRoot(context);
  let snapshots = 0;
  let started!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkpoints = new WorkspaceCheckpoints(
    async () => {
      snapshots++;
      return layoutFor(root, snapshots);
    },
    async () => {
      started();
      await blocked;
    },
    (error) => {
      throw error;
    }
  );
  const first = checkpoints.save();
  await writing;
  checkpoints.save();
  checkpoints.dispose();
  release();
  await first;
  assert.equal(snapshots, 1);
});

test('disposed checkpoints cannot write a late snapshot after the window closes', async (context) => {
  const root = await temporaryRoot(context);
  let release!: (layout: SavedLayout) => void;
  let writes = 0;
  const checkpoints = new WorkspaceCheckpoints(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async () => {
      writes++;
    },
    (error) => {
      throw error;
    }
  );
  const pending = checkpoints.save();
  checkpoints.dispose();
  release(layoutFor(root));
  await pending;
  await checkpoints.save();
  assert.equal(writes, 0);
});

test('background snapshots preserve detached scrolling while saving the editing cursor', async (context) => {
  const root = await temporaryRoot(context);
  await writeFile(
    join(root, 'notes.txt'),
    Array.from({ length: 300 }, (_, i) => `row ${i}`).join('\n')
  );
  const session = await Session.create(root, () => {});
  try {
    await session.attach(80, 20);
    await session.openFile('notes.txt');
    await session.input('60Gzt');
    await session.scroll(30, false, true);
    const view = await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]);
    const snapshot = await session.snapshot({ restoreScroll: false });
    assert.equal(snapshot.files[0].line, 60);
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
      view
    );
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ["return require('nido_scroll').cursor()", []]),
      [60, 0]
    );
  } finally {
    await session.stop();
  }
});

test('workspace recovery preserves multiple untitled drafts and the active cursor', async (context) => {
  const root = await temporaryRoot(context);
  const path = join(root, 'workspaces.json');
  await writeFile(join(root, 'notes.txt'), 'unchanged on disk\n');
  const first = await Session.create(root, () => {});
  const restored = await Session.create(root, () => {});
  try {
    await first.openFile('notes.txt');
    await first.client.request('nvim_exec_lua', [
      `vim.cmd('enew')
      vim.api.nvim_buf_set_lines(0, 0, -1, false, {'first 日本語', 'second', 'NUL' .. string.char(0) .. 'tail'})
      vim.bo.modified = true
      vim.cmd('enew')
      vim.api.nvim_buf_set_lines(0, 0, -1, false, {'another draft'})
      vim.bo.endofline = false
      vim.bo.modified = true
      vim.api.nvim_win_set_cursor(0, {1, 4})`,
      []
    ]);
    const snapshot = await first.snapshot();
    assert.equal(snapshot.untitled?.length, 2);
    assert.equal(snapshot.untitled?.[0].lines[2], 'NUL\0tail');
    assert.equal(snapshot.currentUntitled, 1);
    await writeLayout(path, { version: 1, active: 0, workspaces: [snapshot] });
    assert.deepEqual(await restored.restore((await readLayout(path)).workspaces[0]), []);
    const recovered = await restored.snapshot();
    assert.deepEqual(recovered.untitled, snapshot.untitled);
    assert.equal(recovered.currentUntitled, 1);
    assert.equal(await restored.modified(), true);
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'unchanged on disk\n');
    assert.equal((await restored.snapshot({ includeUntitled: false })).untitled, undefined);
    await first.openFile('notes.txt');
    const fileActive = await first.snapshot();
    const recoveredFileActive = await Session.create(root, () => {});
    try {
      await recoveredFileActive.restore(fileActive);
      const active = await recoveredFileActive.snapshot();
      assert.equal(active.current, fileActive.current);
      assert.equal(active.currentUntitled, undefined);
      assert.deepEqual(active.untitled, fileActive.untitled);
    } finally {
      await recoveredFileActive.stop();
    }
    await restored.client.request('nvim_exec_lua', [
      `vim.api.nvim_buf_set_name(0, ...)
      vim.cmd('write')`,
      [join(root, 'saved.txt')]
    ]);
    const afterSave = await restored.snapshot();
    assert.equal(afterSave.untitled?.length, 1);
    assert.equal(afterSave.untitled?.[0].id, snapshot.untitled?.[0].id);
    await writeLayout(path, { version: 1, active: 0, workspaces: [afterSave] });
    await writeFile(path, '{corrupt');
    const fromBackup = (await readLayout(path)).workspaces[0];
    assert.deepEqual(fromBackup.untitled, [snapshot.untitled?.[0]]);
    assert.equal(fromBackup.currentUntitled, undefined);
    assert.match(await readFile(join(root, 'saved.txt'), 'utf8'), /^another draft(?:\r?\n)?$/);
  } finally {
    await Promise.all([first.stop(), restored.stop()]);
  }
});

test('oversized untitled drafts fail checkpoints rather than silently losing recovery data', async (context) => {
  const root = await temporaryRoot(context);
  const session = await Session.create(root, () => {});
  try {
    await session.client.request('nvim_exec_lua', [
      `vim.api.nvim_buf_set_lines(0, 0, -1, false, {string.rep('x', 8 * 1024 * 1024 + 1)})
      vim.bo.modified = true`,
      []
    ]);
    await assert.rejects(session.snapshot(), /Workspace recovery supports up to 100/);
    assert.equal((await session.snapshot({ includeUntitled: false })).untitled, undefined);
  } finally {
    await session.stop();
  }
});

test('explicit discard removes untitled drafts from the backup layout', async (context) => {
  const root = await temporaryRoot(context);
  const path = join(root, 'workspaces.json');
  const withDraft = layoutFor(root);
  withDraft.workspaces[0].untitled = [
    { lines: ['private draft'], endOfLine: true, fileformat: 'unix', line: 1, column: 0 }
  ];
  withDraft.workspaces[0].currentUntitled = 0;
  await writeLayout(path, withDraft);
  await writeLayout(path, layoutFor(root), { replaceBackup: true });
  await writeFile(path, '{corrupt');
  assert.deepEqual(await readLayout(path), layoutFor(root));
});
