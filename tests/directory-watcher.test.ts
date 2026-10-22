import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DirectoryWatcher } from '../src/main/directoryWatcher';

async function until(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 6000;
    while (!predicate() && Date.now() < deadline) await delay(20);
    assert.ok(predicate(), message);
}

async function fixture(
    context: TestContext,
    polling = false
): Promise<{
    root: string;
    watcher: DirectoryWatcher;
    batches: string[][];
    resolutions: string[];
}> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-directory-watch-')));
    const batches: string[][] = [];
    const resolutions: string[] = [];
    const watcher = new DirectoryWatcher(
        async (path) => {
            resolutions.push(path);
            return realpath(join(root, path));
        },
        (paths) => batches.push(paths),
        polling
    );
    context.after(async () => {
        watcher.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    return { root, watcher, batches, resolutions };
}

test('native directory notifications refresh only subscribed folders and ignore content edits', async (context) => {
    const { root, watcher, batches, resolutions } = await fixture(context);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'closed'));
    await writeFile(join(root, 'src', 'existing.txt'), 'before');
    await watcher.set(['', 'src']);
    await until(() => batches.length > 0, 'Initial listing reconciliation was not delivered.');
    batches.length = 0;
    const setupReads = resolutions.length;
    await writeFile(join(root, 'src', 'existing.txt'), 'after');
    await writeFile(join(root, 'closed', 'generated.txt'), 'hidden');
    await delay(400);
    assert.equal(batches.length, 0, 'Content edits or a collapsed folder refreshed the tree.');
    await writeFile(join(root, 'src', 'created.txt'), 'new');
    await until(() => batches.some((paths) => paths.includes('src')), 'Creation was not reported.');
    assert.deepEqual(new Set(batches.flat()), new Set(['src']));
    assert.equal(
        resolutions.length,
        setupReads,
        'Native idle/change handling polled the filesystem.'
    );
    batches.length = 0;
    await watcher.set(['']);
    await unlink(join(root, 'src', 'created.txt'));
    await delay(400);
    assert.equal(batches.length, 0, 'A collapsed folder refreshed the tree.');
});

test('a thousand file deletions are coalesced without re-resolving watched directories', async (context) => {
    const { root, watcher, batches, resolutions } = await fixture(context);
    const files = Array.from({ length: 1000 }, (_, index) => join(root, `${index}.txt`));
    await Promise.all(files.map((file) => writeFile(file, 'generated')));
    await watcher.set(['']);
    await until(() => batches.length > 0, 'Initial listing reconciliation was not delivered.');
    batches.length = 0;
    const setupReads = resolutions.length;
    const started = performance.now();
    await Promise.all(files.map((file) => unlink(file)));
    await until(() => batches.length > 0, 'External deletion did not refresh the directory.');
    await delay(350);
    const elapsed = performance.now() - started;
    assert.ok(batches.length <= Math.ceil(elapsed / 250) + 1, 'One update was sent per file.');
    assert.deepEqual(new Set(batches.flat()), new Set(['']));
    assert.equal(resolutions.length, setupReads);
    context.diagnostic(
        JSON.stringify({
            deletedFiles: files.length,
            batches: batches.length,
            elapsedMs: Math.round(elapsed),
            extraDirectoryResolutions: resolutions.length - setupReads
        })
    );
});

test('continuous changes flush before the burst ends and recreated directories stay observable', async (context) => {
    const { root, watcher, batches } = await fixture(context);
    const nested = join('src', 'nested');
    await mkdir(join(root, nested), { recursive: true });
    await watcher.set(['', 'src', nested]);
    await until(() => batches.length > 0, 'Initial listing reconciliation was not delivered.');
    batches.length = 0;
    for (let index = 0; index < 24; index++) {
        await writeFile(join(root, `${index}.txt`), 'generated');
        await delay(30);
    }
    assert.ok(
        batches.length >= 2,
        'Continuous activity postponed every update until the burst ended.'
    );
    batches.length = 0;
    await rename(join(root, 'src'), join(root, 'previous-src'));
    await mkdir(join(root, nested), { recursive: true });
    await until(
        () => batches.some((paths) => paths.includes(nested)),
        'Directory replacement was not reconciled.'
    );
    await watcher.ready();
    batches.length = 0;
    await writeFile(join(root, nested, 'after-recreation.txt'), 'new inode');
    await until(
        () => batches.some((paths) => paths.includes(nested)),
        'The watcher remained attached to the old directory.'
    );
});

test('polling fallback detects directory changes and stops after unsubscribe', async (context) => {
    const { root, watcher, batches, resolutions } = await fixture(context, true);
    await watcher.set(['']);
    await until(() => batches.length > 0, 'Initial listing reconciliation was not delivered.');
    batches.length = 0;
    await writeFile(join(root, 'external.txt'), 'new');
    await until(() => batches.length > 0, 'Fallback polling did not detect a new file.');
    assert.deepEqual(new Set(batches.flat()), new Set(['']));
    await watcher.set([]);
    batches.length = 0;
    const before = resolutions.length;
    await unlink(join(root, 'external.txt'));
    await delay(1800);
    assert.equal(batches.length, 0);
    assert.equal(resolutions.length, before, 'Unsubscribed directories were still being polled.');
});

test('closing during watcher setup cancels subscriptions and pending notifications', async (context) => {
    const { root } = await fixture(context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const batches: string[][] = [];
    const watcher = new DirectoryWatcher(
        async () => {
            await gate;
            return root;
        },
        (paths) => batches.push(paths)
    );
    context.after(() => watcher.close());
    const pending = watcher.set(['']);
    await delay(20);
    watcher.close();
    release();
    await pending;
    await writeFile(join(root, 'after-close.txt'), 'closed');
    await delay(350);
    assert.equal(batches.length, 0);
});
