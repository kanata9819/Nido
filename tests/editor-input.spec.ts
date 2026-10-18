import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('clipboard reads keep pasted text before following typing and saving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-clipboard-order-'));
    const profile = join(root, 'profile');
    const file = join(root, 'notes.txt');
    await mkdir(profile);
    await writeFile(file, 'original\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /original/
        );
        await running.evaluate(({ clipboard }) => {
            // Isolate a slow OS clipboard read without changing the user's clipboard.
            clipboard.readText = async (): Promise<string> => {
                await new Promise((resolve) => setTimeout(resolve, 150));
                return '日本語<clip>';
            };
        });
        await page.keyboard.press('i');
        await page.keyboard.press('Control+Shift+v');
        await page.keyboard.type('XYZ');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect.poll(() => readSavedFile(file)).toBe('日本語<clip>XYZoriginal\n');
        await expect(input).toBeFocused();
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
