import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';

for (const resume of ['keyboard', 'buffer switch'] as const) {
    test(`clicks preserve the viewport and restore cursor margins on ${resume}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-click-viewport-'));
        const file = join(root, 'rows.txt');
        const source = Array.from({ length: 100 }, (_, i) => `ROW_${i + 1}`).join('\n');
        let session: Session | undefined;
        try {
            await writeFile(file, source);
            await writeFile(join(root, 'other.txt'), 'Other buffer\n');
            session = await Session.create(root, () => {});
            await session.openFile('rows.txt');
            await session.attach(90, 40);
            await session.input('2G');
            const margin = (): Promise<unknown> =>
                session!.client.request('nvim_exec_lua', ['return vim.wo.scrolloff', []]);
            const originalMargin = await margin();
            await session.scroll(28 + 1 / 6, false, true);
            const view = (): Promise<{ topline: number; skipcol: number; lnum: number }> =>
                session!.client.request('nvim_exec_lua', [
                    'return vim.fn.winsaveview()',
                    []
                ]) as Promise<{ topline: number; skipcol: number; lnum: number }>;
            const before = await view();
            assert.equal(before.topline, 29);
            for (let click = 0; click < 2; click++) {
                await session.click(1, 10);
                await session.prefetchScroll();
                const after = await view();
                assert.equal(after.lnum, 30);
                assert.equal(after.topline, before.topline);
                assert.equal(after.skipcol, before.skipcol);
            }
            if (resume === 'keyboard') {
                await session.input('j');
                assert.equal((await view()).lnum, 31);
            } else {
                await session.openFile('other.txt');
            }
            assert.equal(await margin(), originalMargin);
            assert.equal(await readFile(file, 'utf8'), source);
        } finally {
            await session?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
