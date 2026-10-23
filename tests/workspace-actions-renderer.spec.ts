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
test.afterAll(async () => {
    await server?.close();
});

async function restoreWorkspaces(page: Page, deferred: string): Promise<void> {
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces,${deferred}`);
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'restoreWorkspaces')
            )
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.settle('restoreWorkspaces', 0, {
            workspaces: [
                { id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'alpha-shell' },
                { id: 'beta', root: '/beta', name: 'Beta' }
            ],
            active: 'alpha',
            errors: []
        })
    );
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
}

test('a delayed workspace close preserves a newer terminal interaction', async ({ page }) => {
    await restoreWorkspaces(page, 'closeWorkspace');
    await page.getByRole('button', { name: 'Close workspace Beta', exact: true }).click();
    await page.keyboard.press('Control+`');
    const terminal = page.getByRole('textbox', { name: 'Terminal input', exact: true });
    await expect(terminal).toBeFocused();
    await page.evaluate(() => {
        window.rendererTest.emit({ type: 'exit', id: 'beta' });
        window.rendererTest.settle('closeWorkspace', 0, undefined);
    });
    await expect(page.getByRole('tab', { name: 'Workspace Beta', exact: true })).toHaveCount(0);
    await expect(terminal).toBeFocused();
});

test('a failed workspace creation preserves a newer terminal interaction', async ({ page }) => {
    await restoreWorkspaces(page, 'createWorkspace');
    await page.keyboard.press('Control+Shift+n');
    const picker = page.getByRole('dialog', { name: 'folders palette' });
    await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'createWorkspace')
            )
        )
        .toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+`');
    const terminal = page.getByRole('textbox', { name: 'Terminal input', exact: true });
    await expect(terminal).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.settle('createWorkspace', 0, 'Workspace startup failed', true)
    );
    await expect(page.getByRole('alert')).toContainText('Workspace startup failed');
    await expect(terminal).toBeFocused();
});

test('cancelling a workspace close still returns focus to the editor', async ({ page }) => {
    await restoreWorkspaces(page, 'closeWorkspace');
    await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
    await page.evaluate(() => window.rendererTest.settle('closeWorkspace', 0, undefined));
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
});

test('successful workspace creation selects and focuses the new editor', async ({ page }) => {
    await restoreWorkspaces(page, 'createWorkspace');
    await page.keyboard.press('Control+Shift+n');
    const picker = page.getByRole('dialog', { name: 'folders palette' });
    await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'createWorkspace')
            )
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.settle('createWorkspace', 0, {
            id: 'gamma',
            root: '/gamma',
            name: 'Gamma'
        })
    );
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Workspace Gamma', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
    );
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});
