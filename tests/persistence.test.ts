import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayout, writeLayout, type SavedLayout } from '../src/main/persistence';
import { WorkspaceCheckpoints } from '../src/main/workspaceCheckpoints';
import { Session } from '../src/main/session';

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
        const view = await session.client.request('nvim_exec_lua', [
            'return vim.fn.winsaveview()',
            []
        ]);
        const snapshot = await session.snapshot({ restoreScroll: false });
        assert.equal(snapshot.files[0].line, 60);
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
            view
        );
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', [
                "return require('nido_scroll').cursor()",
                []
            ]),
            [60, 0]
        );
    } finally {
        await session.stop();
    }
});
