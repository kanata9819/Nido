import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
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

test('settings switch the UI language immediately, persist it and switch back to English', async ({ page }) => {
    await page.goto(`${origin}?view=app`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('checkbox', { name: 'Word wrap', exact: true }).uncheck();
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    const japaneseSettings = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(japaneseSettings.getByRole('checkbox', { name: '行の折り返し', exact: true })).not.toBeChecked();
    await expect(japaneseSettings.getByRole('combobox', { name: '言語', exact: true })).toHaveValue('ja');
    await expect(page.getByRole('button', { name: 'エクスプローラー', exact: true })).toHaveAttribute('title', 'エクスプローラー（Space e）');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('ja');
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.filter((call) => call.method === 'setLanguage').at(-1)?.args[0])).toBe('ja');
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.filter((call) => call.method === 'restoreWorkspaces').length)).toBe(1);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('combobox', { name: '言語', exact: true }).selectOption('en');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('en');
});

test('Japanese command search and keyboard navigation keep working after a language change', async ({ page }) => {
    await page.goto(`${origin}?view=app`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
    await page.getByRole('button', { name: 'パレットを閉じる', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'キーボードコマンド', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('textbox', { name: '項目を絞り込む', exact: true }).fill('設定');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+g');
    await expect(page.getByRole('dialog', { name: 'ソース管理', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '3 ブランチ', exact: true })).toBeEnabled();
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: '3 ブランチ', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('an invalid saved language safely opens the English interface', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nido.language', 'unsupported'));
    await page.goto(`${origin}?view=app`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});

test('Rapid insert text keeps spaces and following keys while a mode check is pending', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['mode_change', ['normal', 0]]]
        })
    );
    await page.keyboard.type('Go## Unsaved heading');
    await input.evaluate((node) =>
        node.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: '@',
                code: 'KeyQ',
                ctrlKey: true,
                altKey: true,
                modifierAltGraph: true,
                bubbles: true,
                cancelable: true
            })
        )
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'input')
                    .map((call) => call.args[1])
                    .join('')
            )
        )
        .toBe('Go## Unsaved heading@');
    await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('Rapid Normal-mode menu keys open the debugger and keep its focus', async ({ page }) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.type(' D');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'n'));
    const debuggerPanel = page.getByRole('region', { name: 'Debugger', exact: true });
    await expect(debuggerPanel).toBeVisible();
    await expect
        .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await expect(debuggerPanel).toHaveCount(0);
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('Open debug panel');
    await page.keyboard.press('Enter');
    await expect(debuggerPanel).toBeVisible();
    await expect
        .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
});

test('Debugger focuses arriving variables, restores focus after stepping and respects focus outside its panel', async ({
    page
}) => {
    await page.goto(`${origin}?view=debug`);
    await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
    const renderVariables = async (id: number): Promise<void> => {
        await page.evaluate(
            (id) =>
                window.rendererTest.render({
                    debugState: {
                        status: 'paused',
                        output: '',
                        targets: [],
                        variables: [
                            {
                                id,
                                name: 'number',
                                value: '21',
                                type: 'int',
                                scope: 'Locals',
                                depth: 0,
                                expandable: false,
                                expanded: false,
                                loading: false,
                                changed: false
                            }
                        ]
                    }
                }),
            id
        );
    };
    await renderVariables(1);
    const variable = page.getByRole('treeitem', { name: 'number = 21 (int)' });
    await expect(variable).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.render({
            debugState: { status: 'running', output: '', targets: [], variables: [] }
        })
    );
    await expect(variable).toHaveCount(0);
    await renderVariables(2);
    await expect(variable).toBeFocused();
    const outside = page.getByRole('button', { name: 'Outside debugger' });
    await outside.focus();
    await renderVariables(3);
    await expect(outside).toBeFocused();
    await page.reload();
    await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
    await outside.focus();
    await renderVariables(4);
    await expect(outside).toBeFocused();
});

test('Git diff ignores an older response after selecting another file', async ({ page }) => {
    await page.goto(`${origin}?view=git&defer=gitDiff`);
    const list = page.getByRole('listbox', { name: 'Changed files' });
    await expect(list).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await list.press('j');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('gitDiff', 1, '@@ -1 +1 @@\n-old\n+SECOND_CONTENT')
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
    await page.evaluate(() =>
        window.rendererTest.settle('gitDiff', 0, '@@ -1 +1 @@\n-old\n+STALE_CONTENT')
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
    await expect(page.locator('[data-git-scroll="after"]')).not.toContainText('STALE_CONTENT');
});

test('Git history pagination does not reload the first page', async ({ page }) => {
    await page.goto(`${origin}?view=git&defer=gitHistory`);
    await page.getByRole('button', { name: '2 History', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle(
            'gitHistory',
            0,
            Array.from({ length: 100 }, (_, index) => ({
                hash: index.toString(16).padStart(40, '0'),
                subject: `Commit ${index}`,
                author: 'Ada',
                date: '2026-01-01'
            }))
        )
    );
    await page.getByRole('button', { name: 'Load older commits' }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[1])).toBe(100);
    await page.evaluate(() =>
        window.rendererTest.settle('gitHistory', 0, [
            { hash: 'f'.repeat(40), subject: 'Older commit', author: 'Ada', date: '2025-01-01' }
        ])
    );
    await expect(
        page.getByRole('listbox', { name: 'Commit history' }).getByRole('option')
    ).toHaveCount(101);
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'gitHistory').length
        )
    ).toBe(2);
    await page.getByRole('button', { name: '1 Changes', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeVisible();
    await page.getByRole('button', { name: '2 History', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[1])).toBe(0);
    await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeDisabled();
    await page.evaluate(() => window.rendererTest.settle('gitHistory', 0, []));
    await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeEnabled();
});

test('A new diff clears the previous highlighting failure', async ({ page }) => {
    await page.goto(`${origin}?view=highlight&defer=highlightSources`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('highlightSources', 0, 'unavailable', true)
    );
    await expect(page.getByRole('status')).toHaveText('Syntax highlighting unavailable');
    await page.evaluate(() => window.rendererTest.render({ path: 'second.ts' }));
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('highlightSources', 0, [[], []]));
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('after');
});

test('Folder browsing cancels old results and clamps selection after favorites change', async ({
    page
}) => {
    await page.goto(`${origin}?view=folders&defer=browseFolders`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    const path = page.getByRole('textbox', { name: 'Folder path' });
    await path.fill('/beta');
    await path.press('Enter');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 1, {
            path: '/beta',
            parent: '/',
            folders: []
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, {
            path: '/alpha',
            parent: '/',
            folders: [{ name: 'STALE_FOLDER', path: '/alpha/stale', directory: true }]
        })
    );
    await expect(path).toHaveValue('/beta');
    await expect(page.getByText('STALE_FOLDER')).toHaveCount(0);
    await page.evaluate(() =>
        window.rendererTest.render({
            favorites: [
                { root: '/first', name: 'First', kind: 'editor' },
                { root: '/second', name: 'Second', kind: 'editor' }
            ]
        })
    );
    const list = page.getByRole('listbox', { name: 'Folders' });
    await list.press('j');
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-1');
    await page.evaluate(() =>
        window.rendererTest.render({
            favorites: [{ root: '/first', name: 'First', kind: 'editor' }]
        })
    );
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-0');
});

test('Notification replacement resets fading and cancels the previous dismissal', async ({
    page
}) => {
    await page.clock.install();
    await page.goto(`${origin}?view=notification`);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'notification',
            id: 'alpha',
            severity: 'info',
            title: 'First',
            message: 'first notice'
        })
    );
    await expect(page.getByRole('status')).toHaveText(/first notice/);
    await page.clock.runFor(2000);
    await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'true');
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'notification',
            id: 'alpha',
            severity: 'info',
            title: 'Second',
            message: 'second notice'
        })
    );
    await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'false');
    await page.clock.runFor(300);
    await expect(page.getByRole('status')).toHaveText(/second notice/);
    await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
    await expect(page.getByRole('status')).toHaveCount(0);
});

test('Favorite toggling permits only one pending request', async ({ page }) => {
    await page.goto(`${origin}?view=favorites&defer=setWorkspaceFavorite`);
    const toggle = page.getByRole('button', { name: 'Toggle favorite' });
    await toggle.click();
    await expect(page.getByRole('status')).toHaveText('busy');
    expect(await page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('setWorkspaceFavorite', 0, [
            { root: '/alpha', name: 'Alpha', kind: 'editor' }
        ])
    );
    await toggle.click();
    expect(await page.evaluate(() => window.rendererTest.pending[0].args)).toEqual([
        '/alpha',
        'editor',
        false
    ]);
});

test('Git badges clear immediately when switching workspaces', async ({ page }) => {
    await page.goto(`${origin}?view=badges&defer=gitStatus`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, {
            root: '/alpha',
            branch: 'main',
            changes: [{ path: 'first.ts', status: 'M', staged: false }]
        })
    );
    await expect(page.getByRole('status')).toContainText('Modified');
    await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
    await expect(page.getByRole('status')).toHaveText('{}');
    await expect
        .poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[0]))
        .toBe('beta');
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, 'Not a Git repository', true)
    );
    await expect(page.getByRole('status')).toHaveText('{}');
});

test('Completion keeps pending navigation blocked and closes on punctuation', async ({ page }) => {
    await page.goto(`${origin}?view=completion`);
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await input.focus();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['popupmenu_show', [[['word', 'Text', '', '']], 0, 1, 1]]]
        })
    );
    const menu = page.getByRole('listbox', { name: 'Code completion' });
    await expect(menu).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                ['nido_completion_refresh', [true]],
                ['popupmenu_hide', []]
            ]
        })
    );
    await expect(menu).toHaveAttribute('aria-busy', 'true');
    await input.press('Tab');
    await expect(input).toBeFocused();
    await expect(menu).toBeVisible();
    await input.press('.');
    await expect(menu).toHaveCount(0);
});

test('Explorer requests reset their field and clear the previous validation error', async ({
    page
}) => {
    await page.goto(`${origin}?view=explorer`);
    await expect(page.getByRole('dialog', { name: 'Explorer commands' })).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.render({
            request: {
                action: 'rename',
                path: 'first.ts',
                title: 'Rename',
                value: 'first.ts'
            }
        })
    );
    const field = page.getByRole('textbox');
    await expect(field).toHaveValue('first.ts');
    await field.fill('folder/new.ts');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Use Move to');
    await page.evaluate(() =>
        window.rendererTest.render({
            request: {
                action: 'createFile',
                path: '',
                title: 'New file',
                value: 'src/new.ts'
            }
        })
    );
    await expect(field).toHaveValue('src/new.ts');
    await expect(field).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Reference selection resets with a new result and old previews cannot replace it', async ({
    page
}) => {
    await page.goto(`${origin}?view=references&defer=previewReference`);
    const list = page.getByRole('listbox', { name: 'Reference results' });
    await expect(list).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await list.press('j');
    await expect(list).toHaveAttribute('aria-activedescendant', 'reference-1');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 1, {
            first: 1,
            line: 1,
            lines: [[{ text: 'LATEST_PREVIEW', color: '#fff' }]]
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 0, {
            first: 1,
            line: 1,
            lines: [[{ text: 'STALE_PREVIEW', color: '#fff' }]]
        })
    );
    await expect(page.getByRole('region', { name: 'Reference preview' })).toContainText(
        'LATEST_PREVIEW'
    );
    await expect(page.getByText('STALE_PREVIEW')).toHaveCount(0);
    await page.evaluate(() =>
        window.rendererTest.render({
            references: {
                version: 2,
                loading: false,
                error: '',
                items: [{ path: '/alpha/new.ts', line: 1, column: 1, text: 'new reference' }]
            }
        })
    );
    await expect(list).toHaveAttribute('aria-activedescendant', 'reference-0');
    await expect
        .poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args.slice(1)))
        .toEqual([1, 2]);
});

test('App opens references and debugger on new events while respecting a closed panel', async ({
    page
}) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 1,
                column: 1,
                filetype: '',
                references: { version: 1, loading: false, error: '', items: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'References', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Hide references' }).click();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 2,
                column: 1,
                filetype: '',
                references: { version: 1, loading: false, error: '', items: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'References', exact: true })).toBeHidden();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 2,
                column: 1,
                filetype: '',
                debug: { status: 'running', output: '', variables: [], targets: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
    const debugStatus = async (status: 'paused' | 'running' | 'building'): Promise<void> => {
        await page.evaluate(
            (nextStatus) =>
                window.rendererTest.emit({
                    type: 'state',
                    id: 'alpha',
                    state: {
                        buffers: [],
                        current: 0,
                        mode: 'n',
                        line: 2,
                        column: 1,
                        filetype: '',
                        debug: { status: nextStatus, output: '', variables: [], targets: [] }
                    }
                }),
            status
        );
    };
    await debugStatus('paused');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
        'Debug · paused'
    );
    await page.getByRole('button', { name: 'Hide debugger' }).click();
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    await debugStatus('running');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
    await debugStatus('paused');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
    await expect(input).toBeFocused();
    await debugStatus('building');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});
