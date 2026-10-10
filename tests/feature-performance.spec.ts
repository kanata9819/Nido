import { test, expect, type Page } from '@playwright/test';
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
test.afterAll(async () => server?.close());

async function open(page: Page, view: string, deferred: string): Promise<void> {
    await page.addInitScript(() => {
        localStorage.setItem('nido.language', 'en');
        localStorage.setItem('nido.animations', 'false');
    });
    await page.goto(`${origin}?view=${view}&defer=${deferred}`);
    await expect(page.locator('canvas').or(page.getByRole('listbox')).first()).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
}

test('ten thousand references keep bounded DOM and keyboard jumps, and rapid selection requests only the final preview', async ({
    page
}) => {
    await open(page, 'app', 'previewReference');
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: {
                references: {
                    version: 10,
                    loading: true,
                    error: '',
                    items: Array.from({ length: 10000 }, (_, i) => ({
                        path: `/alpha/file-${i}.ts`,
                        line: i + 1,
                        column: 1,
                        text: `reference ${i}`
                    }))
                }
            }
        })
    );
    await page.clock.runFor(50);
    const list = page.getByRole('listbox', { name: 'Reference results' });
    await expect(list).toBeFocused();
    expect(await list.getByRole('option').count()).toBeLessThan(40);
    await page.clock.runFor(100);
    await page.evaluate(() => {
        window.rendererTest.calls.length = 0;
    });
    await list.press('End');
    await expect(list).toHaveAttribute('aria-activedescendant', 'reference-9999');
    await expect(list.locator('#reference-9999')).toBeVisible();
    await expect(list.locator('#reference-9999')).toHaveAttribute('aria-setsize', '10000');
    expect(await list.getByRole('option').count()).toBeLessThan(40);
    await list.press('Enter');
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.find((call) => call.method === 'openReference')?.args
        )
    ).toEqual(['alpha', 10000, 10]);
    await list.focus();
    await list.press('Home');
    for (let i = 0; i < 20; i++) {
        await list.press('ArrowDown');
        await page.clock.runFor(20);
    }
    await page.clock.runFor(100);
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls
                .filter((call) => call.method === 'previewReference')
                .map((call) => call.args)
        )
    ).toEqual([['alpha', 21, 10]]);
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 1, {
            first: 21,
            line: 21,
            lines: [[{ text: 'FINAL_PREVIEW', color: '#fff' }]]
        })
    );
    await expect(page.getByRole('region', { name: 'Reference preview' })).toContainText(
        'FINAL_PREVIEW'
    );
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 0, {
            first: 1,
            line: 1,
            lines: [[{ text: 'STALE_PREVIEW', color: '#fff' }]]
        })
    );
    await expect(page.getByText('STALE_PREVIEW')).toHaveCount(0);
});

test('file search sends the query, cancels closing searches and ignores old results', async ({
    page
}) => {
    await open(page, 'app', 'findFiles');
    await page.keyboard.press('Control+p');
    await page.clock.runFor(100);
    const filter = page.getByRole('textbox', { name: 'Filter items' });
    await filter.fill('needle');
    await page.clock.runFor(100);
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls
                .filter((call) => call.method === 'findFiles')
                .map((call) => call.args)
        )
    ).toEqual([
        ['alpha', ''],
        ['alpha', 'needle']
    ]);
    await page.evaluate(() =>
        window.rendererTest.settle('findFiles', 1, [
            { name: 'needle.ts', path: 'deep/needle.ts', directory: false }
        ])
    );
    await expect(page.getByRole('button', { name: /needle.ts/ })).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.settle('findFiles', 0, [
            { name: 'needle-old.ts', path: 'needle-old.ts', directory: false }
        ])
    );
    await expect(page.getByRole('button', { name: /needle-old.ts/ })).toHaveCount(0);
    const cancelled = await page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'cancelFindFiles').length
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    expect(
        await page.evaluate(
            () =>
                window.rendererTest.calls.filter((call) => call.method === 'cancelFindFiles').length
        )
    ).toBe(cancelled + 1);
});

test('partial references never steal editor focus or reopen a closed panel; a new search opens it', async ({
    page
}) => {
    await open(page, 'app', '');
    const update = async (search: number, version: number, loading: boolean): Promise<void> => {
        await page.evaluate(
            ({ search, version, loading }) =>
                window.rendererTest.emit({
                    type: 'statePatch',
                    id: 'alpha',
                    state: {
                        references: {
                            search,
                            version,
                            loading,
                            error: '',
                            items: [
                                { path: '/alpha/main.ts', line: 1, column: 1, text: 'reference' }
                            ]
                        }
                    }
                }),
            { search, version, loading }
        );
        await page.clock.runFor(50);
    };
    await update(1, 1, true);
    const panel = page.getByRole('region', { name: 'References', exact: true });
    await expect(panel).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'Neovim input' });
    await editor.focus();
    await update(1, 2, true);
    await expect(editor).toBeFocused();
    await page.getByRole('button', { name: 'Hide references' }).click();
    await update(1, 3, false);
    await expect(panel).toBeHidden();
    await expect(editor).toBeFocused();
    await update(2, 4, true);
    await expect(panel).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
});

test('Enter during file search opens the arriving result, while closing cancels the pending choice', async ({
    page
}) => {
    await open(page, 'app', 'findFiles');
    await page.keyboard.press('Control+p');
    const filter = page.getByRole('textbox', { name: 'Filter items' });
    await filter.fill('quick');
    await filter.press('Enter');
    await page.clock.runFor(100);
    await page.evaluate(() =>
        window.rendererTest.settle('findFiles', 0, [
            { name: 'quick.ts', path: 'quick.ts', directory: false }
        ])
    );
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls
                .filter((call) => call.method === 'openFile')
                .map((call) => call.args)
        )
    ).toEqual([['alpha', 'quick.ts']]);
    await page.keyboard.press('Control+p');
    await filter.fill('cancel');
    await filter.press('Enter');
    await page.clock.runFor(100);
    await filter.press('Escape');
    await page.evaluate(() =>
        window.rendererTest.settle('findFiles', 0, [
            { name: 'cancel.ts', path: 'cancel.ts', directory: false }
        ])
    );
    await page.clock.runFor(100);
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'openFile').length
        )
    ).toBe(1);
});

test('Markdown stays beside the editable canvas, coalesces edits, preserves scroll and stops on close or file switch', async ({
    page
}) => {
    await open(page, 'app', 'markdownPreview');
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { filetype: 'markdown', current: 1 }
        })
    );
    await page.clock.runFor(50);
    await page.keyboard.press('Control+Shift+v');
    const pane = page.getByRole('region', { name: 'Markdown preview', exact: true });
    const content = page.getByLabel('Markdown preview content', { exact: true });
    await expect(pane).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.settle('markdownPreview', 0, {
            token: '1:1',
            path: '/alpha/notes.md',
            text: '# First\n\n' + 'Paragraph\n\n'.repeat(100)
        })
    );
    await expect(content.getByRole('heading', { name: 'First' })).toBeVisible();
    await expect(content).toBeFocused();
    await expect(page.locator('canvas:visible')).toBeVisible();
    await content.press('Control+d');
    const scroll = await content.evaluate((node) => node.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await content.press('Control+j');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.evaluate(() => {
        for (let i = 0; i < 20; i++)
            window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] });
    });
    await page.clock.runFor(200);
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls
                .filter((call) => call.method === 'markdownPreview')
                .map((call) => call.args)
        )
    ).toEqual([
        ['alpha', ''],
        ['alpha', '1:1']
    ]);
    await page.evaluate(() =>
        window.rendererTest.settle('markdownPreview', 0, {
            token: '1:2',
            path: '/alpha/notes.md',
            text: '# Live\n\n' + 'Paragraph\n\n'.repeat(100)
        })
    );
    await expect(content.getByRole('heading', { name: 'Live' })).toHaveCount(1);
    expect(await content.evaluate((node) => node.scrollTop)).toBe(scroll);
    await page.evaluate(() =>
        window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
    );
    await page.clock.runFor(200);
    await page.evaluate(() =>
        window.rendererTest.settle('markdownPreview', 0, { token: '1:2', path: '/alpha/notes.md' })
    );
    await expect(content.getByRole('heading', { name: 'Live' })).toHaveCount(1);
    await content.focus();
    await content.press('Escape');
    await expect(pane).toBeHidden();
    const count = await page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'markdownPreview').length
    );
    await page.evaluate(() =>
        window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['nido_edit']] })
    );
    await page.clock.runFor(200);
    expect(
        await page.evaluate(
            () =>
                window.rendererTest.calls.filter((call) => call.method === 'markdownPreview').length
        )
    ).toBe(count);
    await page.keyboard.press('Control+Shift+v');
    await expect(pane).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { filetype: 'typescript', current: 2 }
        })
    );
    await page.clock.runFor(200);
    await expect(pane).toBeHidden();
    await page.evaluate(() =>
        window.rendererTest.settle('markdownPreview', 0, {
            token: '1:3',
            path: '/alpha/notes.md',
            text: '# Stale'
        })
    );
    await expect(page.getByRole('heading', { name: 'Stale' })).toHaveCount(0);
});

test('rapid Time Machine selection starts only the final preview and keeps restore disabled while waiting', async ({
    page
}) => {
    await open(page, 'history', 'history,historyPreview');
    await page.evaluate(() =>
        window.rendererTest.settle('history', 0, {
            path: '/alpha/notes.txt',
            versions: Array.from({ length: 30 }, (_, i) => ({
                id: String(i),
                timestamp: i + 1,
                kind: 'draft',
                bytes: 1,
                lines: 1
            }))
        })
    );
    const list = page.getByRole('listbox', { name: 'Edit history' });
    for (let i = 0; i < 20; i++) {
        await list.press('ArrowDown');
        await page.clock.runFor(20);
    }
    await expect(page.getByRole('button', { name: /Restore to editor/ })).toBeDisabled();
    await page.clock.runFor(100);
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls
                .filter((call) => call.method === 'historyPreview')
                .map((call) => call.args)
        )
    ).toEqual([['alpha', '/alpha/notes.txt', '21']]);
});
