import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('workspace loading stays visible until Neovim paints the restored code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-workspace-loading-'));
    const profile = join(root, 'profile');
    const file = join(root, 'startup.txt');
    await mkdir(profile);
    await writeFile(file, 'Restored startup code\nsecond line\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1100, height: 850, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const canvas = page.locator('canvas:visible');
        const loading = page.getByRole('status', { name: 'Loading workspaces…' });
        await expect(canvas).toHaveAttribute('aria-description', /Restored startup code/);
        await expect(loading).toHaveCount(0);
        await running.evaluate(({ ipcMain }) => {
            const handlers = (
                ipcMain as unknown as {
                    _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
                }
            )._invokeHandlers;
            const restore = handlers.get('nido:restore')!;
            const attach = handlers.get('nido:attach')!;
            Object.assign(globalThis, { loadingProbe: { attaching: false } });
            handlers.set('nido:restore', async (...args) => {
                await new Promise((resolve) => setTimeout(resolve, 500));
                return restore(...args);
            });
            handlers.set('nido:attach', async (...args) => {
                (
                    globalThis as unknown as { loadingProbe: { attaching: boolean } }
                ).loadingProbe.attaching = true;
                await new Promise((resolve) => setTimeout(resolve, 700));
                return attach(...args);
            });
        });
        await page.reload();
        await expect(loading).toBeVisible();
        await expect
            .poll(() =>
                running.evaluate(
                    () =>
                        (globalThis as unknown as { loadingProbe: { attaching: boolean } })
                            .loadingProbe.attaching
                )
            )
            .toBe(true);
        await expect(canvas).toBeVisible();
        await expect(loading).toBeVisible();
        await page.screenshot({ path: 'test-results/workspace-loading-electron.png' });
        await expect(canvas).toHaveAttribute('aria-description', /Restored startup code/);
        await expect(loading).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
