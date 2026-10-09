import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
    server = await createServer({
        configFile: false,
        root: resolve('tests/renderer'),
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd()] } }
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
});
test.afterAll(async () => {
    await server?.close();
});

const versions = [
    { id: 'draft', timestamp: 1735689610000, kind: 'draft', bytes: 9, lines: 1 },
    { id: 'saved', timestamp: 1735689600000, kind: 'saved', bytes: 6, lines: 1 }
];

test('Time Machine ignores late previews and keeps restore disabled until the selected revision is ready', async ({
    page
}) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}?view=history&defer=history,historyPreview,historyRestore`);
    await page.evaluate(
        (versions) =>
            window.rendererTest.settle('history', 0, { path: '/alpha/notes.txt', versions }),
        versions
    );
    const list = page.getByRole('listbox', { name: 'Edit history' });
    const restore = page.getByRole('button', { name: /Restore to editor/ });
    await expect(list).toBeFocused();
    await expect(restore).toBeDisabled();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'historyPreview')
                        .length
            )
        )
        .toBe(1);
    await list.press('Home');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'historyPreview')
                        .length
            )
        )
        .toBe(2);
    await page.evaluate(
        (version) =>
            window.rendererTest.settle('historyPreview', 1, {
                path: '/alpha/notes.txt',
                version,
                token: 'buffer:latest',
                diff: '@@ -1 +1 @@\n-old\n+selected draft',
                identical: false
            }),
        versions[0]
    );
    await expect(restore).toBeEnabled();
    await page.evaluate(
        (version) =>
            window.rendererTest.settle('historyPreview', 0, {
                path: '/alpha/notes.txt',
                version,
                token: 'stale',
                diff: '@@ -1 +1 @@\n-obsolete\n+wrong selection',
                identical: false
            }),
        versions[1]
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('selected draft');
    await expect(page.locator('[data-git-scroll="after"]')).not.toContainText('wrong selection');
    await list.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'historyRestore')
                    .map((call) => call.args)
            )
        )
        .toEqual([['alpha', '/alpha/notes.txt', 'draft', 'buffer:latest']]);
    await list.press('Control+Enter');
    expect(
        await page.evaluate(
            () =>
                window.rendererTest.calls.filter((call) => call.method === 'historyRestore').length
        )
    ).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle(
            'historyRestore',
            0,
            new Error('The file changed. Refresh the preview before restoring.').message,
            true
        )
    );
    await expect(page.getByRole('alert')).toHaveText(
        'The file changed. Refresh the preview before restoring.'
    );
    expect(errors).toEqual([]);
});

test('ten thousand diff rows stay bounded in the DOM while scrolling and jumping between distant changes', async ({
    page
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${origin}?view=highlight`);
    await page.evaluate(() =>
        window.rendererTest.render({
            diff:
                '@@ -1,10000 +1,10000 @@\n' +
                Array.from({ length: 10000 }, (_, i) =>
                    i === 2 || i === 9500 ? `-old ${i}\n+changed ${i}` : ` row ${i}`
                ).join('\n')
        })
    );
    const after = page.locator('[data-git-scroll="after"]');
    await expect(after).toContainText('changed 2');
    expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
    await after.focus();
    await after.press('n');
    await after.press('n');
    await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 9500');
    expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
    const positions = await page
        .locator('[data-git-scroll]')
        .evaluateAll((nodes) => nodes.map((node) => node.scrollTop));
    expect(Math.abs(positions[0] - positions[1])).toBeLessThanOrEqual(1);
    await after.press('Shift+N');
    await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 2');
    await after.evaluate((node) => {
        node.scrollTop = 5000 * 22;
    });
    await expect(after).toContainText('row 5000');
    expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
    const mounted = await page.locator('[data-diff-row]').count();
    console.log(`10,000-row diff: ${mounted} mounted rows across both panes (previously 20,000).`);
});

test('diff syntax colors follow excerpt positions when a hunk starts far into the file', async ({
    page
}) => {
    await page.goto(`${origin}?view=highlight&defer=highlightSources`);
    await page.evaluate(() =>
        window.rendererTest.render({
            diff: '@@ -50,2 +80,2 @@\n-const old = 1;\n+const next = 2;\n shared'
        })
    );
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'highlightSources')
                        .length
            )
        )
        .toBeGreaterThan(0);
    await page.evaluate(() => {
        const pending = window.rendererTest.pending.filter(
            (call) => call.method === 'highlightSources'
        );
        window.rendererTest.settle('highlightSources', pending.length - 1, [
            [
                [{ text: 'const old = 1;', color: '#ff0000' }],
                [{ text: 'shared', color: '#0000ff' }]
            ],
            [
                [{ text: 'const next = 2;', color: '#00ff00' }],
                [{ text: 'shared', color: '#0000ff' }]
            ]
        ]);
    });
    await expect(page.locator('[data-git-scroll="before"] code span').first()).toHaveCSS(
        'color',
        'rgb(255, 0, 0)'
    );
    await expect(page.locator('[data-git-scroll="after"] code span').first()).toHaveCSS(
        'color',
        'rgb(0, 255, 0)'
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('80');
});
