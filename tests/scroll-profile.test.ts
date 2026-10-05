import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

test('directional scrolling profiles a large bracket-heavy buffer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-direction-profile-'));
    const grid = new Grid();
    let session: Session | undefined;
    const reports: object[] = [];
    try {
        await writeFile(
            join(root, 'large.txt'),
            Array.from(
                { length: 1500 },
                (_, i) => `fn block_${i}() {\n    if ready {\n        work();\n    }\n}`
            ).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.attach(100, 40);
        await session.openFile('large.txt');
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await lua(`vim.wo.wrap = false; vim.wait(250)
local original = vim.fn.foldclosed
vim.g.profile_fold_calls = 0
vim.fn.foldclosed = function(...)
  vim.g.profile_fold_calls = vim.g.profile_fold_calls + 1
  return original(...)
end`);
        for (const follow of [false, true]) {
            for (const delta of [0.25, -0.25]) {
                await session.input('2000Gzt');
                await lua('vim.cmd.redraw()');
                await session.prefetchScroll();
                await lua('vim.g.profile_fold_calls = 0');
                const samples: number[] = [];
                let prefetches = 0;
                let prefetchMs = 0;
                const start = performance.now();
                for (let i = 0; i < 80; i++) {
                    const before = performance.now();
                    await session.scroll(delta, follow, true);
                    samples.push(performance.now() - before);
                    if (!grid.hasUpperRows) {
                        const warming = performance.now();
                        await session.prefetchScroll();
                        prefetchMs += performance.now() - warming;
                        prefetches++;
                    }
                }
                const totalMs = performance.now() - start;
                samples.sort((a, b) => a - b);
                const folds = Number(await lua('return vim.g.profile_fold_calls'));
                assert.ok(
                    folds < 80 * 40,
                    'guide queries must depend on visible scopes, not file length'
                );
                reports.push({
                    direction: delta > 0 ? 'down' : 'up',
                    follow,
                    totalMs,
                    p50: samples[40],
                    p95: samples[76],
                    max: samples[79],
                    prefetches,
                    prefetchMs,
                    folds
                });
                assert.equal(samples.length, 80);
            }
        }
        assert.equal(reports.length, 4);
        await mkdir(join(process.cwd(), 'test-results'), { recursive: true });
        await writeFile(
            join(process.cwd(), 'test-results/scroll-direction-profile.json'),
            JSON.stringify(reports, null, 2)
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});
