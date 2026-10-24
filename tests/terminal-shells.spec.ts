import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { TerminalShell } from '../src/shared/types';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;
const errors = new WeakMap<Page, string[]>();

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
test.beforeEach(({ page }) => {
    const messages: string[] = [];
    errors.set(page, messages);
    page.on('pageerror', (error) => messages.push(error.message));
});
test.afterEach(({ page }) => {
    expect(errors.get(page), 'Shell settings must not cause renderer errors').toEqual([]);
});

async function open(page: Page, saved: TerminalShell, language = 'en'): Promise<void> {
    await page.addInitScript(
        ({ saved, language }) => {
            localStorage.setItem('nido.language', language);
            localStorage.setItem('nido.animations', 'false');
            localStorage.setItem('nido.terminalShell', saved);
        },
        { saved, language }
    );
    await page.goto(`${origin}?view=app&defer=availableTerminalShells`);
    await expect(
        page.getByRole('textbox', {
            name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
            exact: true
        })
    ).toBeFocused();
    await openSettings(page, language);
}

async function openSettings(page: Page, language = 'en'): Promise<void> {
    await page
        .getByRole('button', { name: language === 'ja' ? '設定' : 'Settings', exact: true })
        .click();
    await expect(
        page.getByRole('dialog', { name: language === 'ja' ? '設定' : 'Settings', exact: true })
    ).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some(
                    (call) => call.method === 'availableTerminalShells'
                )
            )
        )
        .toBe(true);
}

async function inventory(page: Page, shells: TerminalShell[]): Promise<void> {
    await page.evaluate(
        (shells) => window.rendererTest.settle('availableTerminalShells', 0, shells),
        shells
    );
}

async function savedShell(page: Page): Promise<string | null> {
    return page.evaluate(() => localStorage.getItem('nido.terminalShell'));
}

test('waits for inventory before replacing a missing saved shell and only offers installed shells', async ({
    page
}) => {
    await open(page, 'pwsh');
    const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
    await shell.scrollIntoViewIfNeeded();
    await expect(shell).toBeDisabled();
    await expect(shell).toHaveAttribute('aria-busy', 'true');
    await expect(shell.locator('option')).toHaveText(['Auto (installed shell)']);
    await expect(page.getByText('Checking installed shells…', { exact: true })).toBeVisible();
    expect(await savedShell(page)).toBe('pwsh');

    await inventory(page, ['auto', 'powershell.exe', 'cmd.exe']);
    await expect(shell).toBeEnabled();
    await expect(shell.locator('option')).toHaveText([
        'Auto (installed shell)',
        'Windows PowerShell',
        'Command Prompt (cmd)'
    ]);
    await expect(shell).toHaveValue('auto');
    await expect.poll(() => savedShell(page)).toBe('auto');
    await shell.selectOption('cmd.exe');
    await expect.poll(() => savedShell(page)).toBe('cmd.exe');
    await expect(page.getByText('Only installed shells are shown.', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/terminal-shells.png' });
});

test('keeps a valid saved shell and refreshes inventory when settings reopen', async ({ page }) => {
    await open(page, 'powershell.exe');
    const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
    await inventory(page, ['auto', 'powershell.exe', 'cmd.exe']);
    await expect(shell).toHaveValue('powershell.exe');
    expect(await savedShell(page)).toBe('powershell.exe');

    await page.keyboard.press('Escape');
    await openSettings(page);
    await expect(shell).toBeDisabled();
    expect(await savedShell(page)).toBe('powershell.exe');
    await inventory(page, ['auto', 'pwsh']);
    await expect(shell.locator('option')).toHaveText([
        'Auto (installed shell)',
        'PowerShell 7 (pwsh)'
    ]);
    await expect(shell).toHaveValue('auto');
    await expect.poll(() => savedShell(page)).toBe('auto');
    expect(
        await page.evaluate(
            () =>
                window.rendererTest.calls.filter(
                    (call) => call.method === 'availableTerminalShells'
                ).length
        )
    ).toBe(2);
});

test('preserves the saved shell when inventory fails', async ({ page }) => {
    await open(page, 'pwsh');
    const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
    await page.evaluate(() =>
        window.rendererTest.settle('availableTerminalShells', 0, 'Probe failed', true)
    );
    await shell.scrollIntoViewIfNeeded();
    await expect(shell).toBeDisabled();
    await expect(shell).toHaveAttribute('aria-busy', 'false');
    await expect(shell.locator('option')).toHaveText(['Auto (installed shell)']);
    await expect(
        page.getByText('Could not check installed shells.', { exact: true })
    ).toBeVisible();
    expect(await savedShell(page)).toBe('pwsh');
});

test('ignores inventory that finishes after settings close', async ({ page }) => {
    await open(page, 'pwsh');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
    await inventory(page, ['auto', 'cmd.exe']);
    expect(await savedShell(page)).toBe('pwsh');

    await openSettings(page);
    await inventory(page, ['auto', 'pwsh']);
    await expect(page.getByRole('combobox', { name: 'Shell', exact: true })).toHaveValue('pwsh');
    expect(await savedShell(page)).toBe('pwsh');
});

test('translates Japanese shell labels and keeps installed PowerShell 7 selected', async ({
    page
}) => {
    await open(page, 'pwsh', 'ja');
    const shell = page.getByRole('combobox', { name: 'シェル', exact: true });
    await shell.scrollIntoViewIfNeeded();
    await expect(shell.locator('option')).toHaveText(['自動（利用可能なシェル）']);
    await expect(
        page.getByText('インストール済みのシェルを確認中…', { exact: true })
    ).toBeVisible();
    await inventory(page, ['auto', 'pwsh', 'cmd.exe', 'wsl.exe']);
    await expect(shell).toBeEnabled();
    await expect(shell.locator('option')).toHaveText([
        '自動（利用可能なシェル）',
        'PowerShell 7 (pwsh)',
        'コマンドプロンプト（cmd）',
        'WSL'
    ]);
    await expect(shell).toHaveValue('pwsh');
    expect(await savedShell(page)).toBe('pwsh');
});
