import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Ctrl+Shift+F searches and jumps; F2 renames related symbols from Insert mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-search-rename-ui-'));
    const profile = await mkdtemp(join(tmpdir(), 'nido-search-rename-profile-'));
    const file = join(root, 'main.ts');
    await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true } })
    );
    await writeFile(
        join(root, 'lib.ts'),
        "export const original = 42;\nexport const text = 'original';\n"
    );
    await writeFile(file, "import { original } from './lib';\nconsole.log(original);\n");
    await writeFile(join(root, 'notes.txt'), 'intro\n日本語 needle.*\nlast\n');
    await writeFile(join(root, 'z-other.txt'), 'another needle.*\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1200, height: 900, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 2, column: 12 }] }]
        })
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${profile}`],
        env
    });
    try {
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.keyboard.press('Control+Shift+f');
        const search = page.getByRole('dialog', { name: 'search palette' });
        const query = search.getByRole('textbox', { name: 'Search in files' });
        await expect(query).toBeFocused();
        await query.fill('missing-text');
        await expect(search.getByText('No matching lines.', { exact: true })).toBeVisible();
        await query.fill('needle.*');
        await page.keyboard.press('Enter');
        await expect(search).toHaveCount(0);
        await expect(input).toBeFocused();
        await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
        // Editing at the match checks the UTF-8 byte column, not just the opened tab.
        await page.keyboard.type('iX');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(root, 'notes.txt'), 'utf8'))
            .toBe('intro\n日本語 Xneedle.*\nlast\n');
        await page.keyboard.press('Control+Shift+f');
        await expect(query).toBeFocused();
        await query.fill('needle.*');
        await expect(search.getByRole('status')).toHaveText('2 matching lines');
        await query.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
        await expect(query).toBeFocused();
        await page.keyboard.press('Control+j');
        await expect(search.getByRole('button', { name: /z-other.txt:1:/ })).toHaveClass(
            /selectedItem/
        );
        await page.keyboard.press('Control+k');
        await expect(search.getByRole('button', { name: /notes.txt:2:/ })).toHaveClass(
            /selectedItem/
        );
        await page.screenshot({ path: test.info().outputPath('workspace-search.png') });
        await page.keyboard.press('Escape');
        await expect(input).toBeFocused();

        await page.keyboard.press('Control+Shift+f');
        await query.fill('export const original');
        await page.keyboard.press('Enter');
        await expect(search).toHaveCount(0);
        await expect(input).toBeFocused();
        await page.keyboard.type('0ww');
        await page.keyboard.press('Control+Shift+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('Rename symbol');
        await expect(page.getByRole('button', { name: /Rename symbol/ })).toBeVisible({
            timeout: 20000
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('F2');
        const rename = page.getByRole('dialog', { name: 'Neovim command line' });
        await expect(rename).toContainText('New Name:');
        await page.keyboard.press('Escape');
        await expect(rename).toHaveCount(0);
        await expect(input).toBeFocused();
        await page.keyboard.type('i');
        await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
        await page.keyboard.press('F2');
        await expect(rename).toContainText('New Name:');
        await page.keyboard.press('Control+u');
        await page.keyboard.type('renamed');
        await expect(rename).toContainText('renamed');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        await expect(canvas).toHaveAttribute('aria-description', /export const renamed/);
        await page.keyboard.press('Escape');
        await page.keyboard.type(':wall');
        await page.keyboard.press('Enter');
        await expect.poll(() => readFile(file, 'utf8')).toContain('console.log(renamed)');
        await expect
            .poll(() => readFile(join(root, 'lib.ts'), 'utf8'))
            .toBe("export const renamed = 42;\nexport const text = 'original';\n");
        await expect(input).toBeFocused();
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
