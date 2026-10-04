import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gf errors use the existing notification card and leave file navigation usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-goto-file-ui-'));
    const profile = join(root, 'profile');
    const file = join(root, 'notes.txt');
    await mkdir(profile);
    await writeFile(file, 'event.preventDefault\nfound.txt\n');
    await writeFile(join(root, 'found.txt'), 'Opened with gf\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1200, height: 900, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
        env
    });
    try {
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        const notice = page.getByRole('alert', { name: 'File navigation' });
        await expect(input).toBeFocused();
        await expect(canvas).toHaveAttribute('aria-description', /event\.preventDefault/);
        await page.keyboard.type('gf');
        await expect(notice).toHaveText(
            'File navigationE447: Can\'t find file "event.preventDefault" in pathEsc to dismiss'
        );
        await expect(notice).toHaveAttribute('data-severity', 'error');
        await expect(input).toBeFocused();
        await expect(canvas).not.toHaveAttribute('aria-description', /E447|Press ENTER/);
        await page.screenshot({
            path: process.env.NIDO_GF_SCREENSHOT ?? 'test-results/gf-notification.png'
        });
        await page.keyboard.press('Escape');
        await expect(notice).toHaveCount(0);
        await page.keyboard.type('gf');
        await expect(notice).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(notice).toHaveCount(0);
        await page.keyboard.type('j0gf');
        await expect(canvas).toHaveAttribute('aria-description', /Opened with gf/);
        await expect(page.getByRole('tab', { name: 'found.txt', exact: true })).toBeVisible();
        await expect(notice).toHaveCount(0);
        await expect(input).toBeFocused();
        await page.keyboard.press('Control+o');
        await expect(canvas).toHaveAttribute('aria-description', /event\.preventDefault/);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
