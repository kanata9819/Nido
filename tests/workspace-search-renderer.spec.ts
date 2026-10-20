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

async function open(page: Page, language = 'en'): Promise<void> {
    await page.addInitScript((language) => {
        localStorage.setItem('nido.language', language);
        localStorage.setItem('nido.animations', 'false');
    }, language);
    await page.goto(`${origin}?view=app&defer=searchText,previewReplacement,applyReplacement`);
    await expect(
        page.getByRole('textbox', {
            name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
            exact: true
        })
    ).toBeFocused();
    await page.keyboard.press('Control+Shift+f');
}
async function matches(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'searchText')
                        .length
            )
        )
        .toBeGreaterThan(0);
    await page.evaluate(() => {
        // Settle the latest request; older requests must not replace it.
        const pending = window.rendererTest.pending.filter((call) => call.method === 'searchText');
        for (let index = 0; index < pending.length; index++)
            window.rendererTest.settle('searchText', 0, {
                token: 'search-1',
                truncated: false,
                matches: [
                    { path: 'src/first.txt', line: 1, column: 1, text: 'joke first' },
                    { path: 'src/second.txt', line: 2, column: 1, text: 'joke second' }
                ]
            });
    });
}

test('search and replacement complete using Vim keys without arrows or mouse', async ({ page }) => {
    await open(page);
    const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
    const results = page.getByRole('listbox', { name: 'Search results', exact: true });
    await page.keyboard.type('joke');
    await expect(query).toHaveValue('joke');
    await page.waitForTimeout(180);
    await matches(page);
    await expect(results.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(results).toBeFocused();
    await page.keyboard.press('j');
    await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('k');
    await page.keyboard.press('/');
    await expect(query).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    const replacement = page.getByRole('textbox', { name: 'Replace with', exact: true });
    await expect(replacement).toBeFocused();
    await page.keyboard.type('j$1k');
    await expect(replacement).toHaveValue('j$1k');
    await page.keyboard.press('Enter');
    await expect(results).toBeFocused();
    await page.keyboard.press('Space');
    await expect(
        results.getByRole('option').first().getByLabel('Excluded', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'previewReplacement')
                    .map((call) => call.args)
            )
        )
        .toEqual([['alpha', 'search-1', 'j$1k', [1]]]);
    await page.evaluate(() =>
        window.rendererTest.settle('previewReplacement', 0, {
            token: 'preview-1',
            count: 1,
            files: [
                {
                    path: 'src/second.txt',
                    count: 1,
                    before: '1  joke first\n2  joke second',
                    after: '1  joke first\n2  j$1k second'
                }
            ]
        })
    );
    const files = page.getByRole('listbox', { name: 'Replacement files', exact: true });
    const diff = page.getByRole('region', { name: 'Replacement diff', exact: true });
    await expect(files).toBeFocused();
    const panel = page.getByRole('dialog', { name: 'search palette', exact: true });
    const footer = panel.getByText(
        'Saved UTF-8 files up to 1 MiB · Git ignores respected · Replacements stay unsaved',
        { exact: true }
    );
    const footerBounds = await footer.boundingBox();
    const panelBounds = await panel.boundingBox();
    expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(
        panelBounds!.y + panelBounds!.height
    );
    await page.screenshot({ path: test.info().outputPath('replacement-preview.png') });
    await page.keyboard.press('Enter');
    await expect(diff).toBeFocused();
    await expect(diff.getByLabel('After replacement', { exact: true })).toContainText(
        'j$1k second'
    );
    await page.keyboard.press('j');
    await page.keyboard.press('h');
    await expect(files).toBeFocused();
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls.filter((call) => call.method === 'applyReplacement')
        )
    ).toHaveLength(0);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('button', { name: /Apply replacement/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'applyReplacement')
                        .length
            )
        )
        .toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('applyReplacement', 0, { count: 1, files: 1 })
    );
    await expect(results).toBeFocused();
    await expect(
        page.getByRole('dialog', { name: 'search palette' }).getByRole('status')
    ).toContainText('Unsaved edits');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('search options, folder and focus trap are keyboard accessible, and stale responses stay hidden', async ({
    page
}) => {
    await open(page);
    const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
    await page.keyboard.type('joke');
    await page.keyboard.press('Alt+c');
    await page.keyboard.press('Alt+r');
    await page.keyboard.press('Alt+w');
    await expect(page.getByRole('button', { name: /Match case/ })).toHaveAttribute(
        'aria-pressed',
        'false'
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    const folder = page.getByRole('textbox', { name: 'Search folder', exact: true });
    await expect(folder).toBeFocused();
    await page.keyboard.type('src');
    await page.waitForTimeout(180);
    const last = await page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'searchText').at(-1)?.args
    );
    expect(last).toEqual([
        'alpha',
        'joke',
        { caseSensitive: false, regex: true, wholeWord: true, folder: 'src' }
    ]);
    for (let index = 0; index < 18; index++) {
        await page.keyboard.press(index < 9 ? 'Tab' : 'Shift+Tab');
        expect(
            await page.evaluate(() => !!document.activeElement?.closest('[data-panel="search"]'))
        ).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await expect(query).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await matches(page);
    await expect(page.getByRole('dialog', { name: 'search palette' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('Japanese search shows translated controls and regex errors within a small viewport', async ({
    page
}) => {
    await page.setViewportSize({ width: 960, height: 720 });
    await open(page, 'ja');
    await page.keyboard.type('[');
    await page.keyboard.press('Alt+r');
    await page.waitForTimeout(180);
    await page.evaluate(() => {
        const count = window.rendererTest.pending.filter(
            (call) => call.method === 'searchText'
        ).length;
        for (let index = 0; index < count; index++)
            window.rendererTest.settle(
                'searchText',
                0,
                new Error('Invalid regular expression.').message,
                true
            );
    });
    await expect(page.getByRole('alert')).toHaveText('正規表現が正しくありません。');
    await expect(page.getByRole('button', { name: /正規表現/ })).toHaveAttribute(
        'aria-pressed',
        'true'
    );
    const dialog = page.getByRole('dialog', { name: 'ファイル内を検索', exact: true });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
    await page.screenshot({ path: test.info().outputPath('search-japanese.png') });
});
