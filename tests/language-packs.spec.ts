import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electron } from './helpers/electron';

test('language packs install from the manager, run, toggle without losing edits and restore after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-packs-ui-'));
    const project = join(root, 'Project');
    const profile = join(root, 'profile');
    await mkdir(project);
    await writeFile(join(project, 'sample.py'), 'print("hello")\n');
    const source = join(root, 'python-pack.json');
    const invalidSource = join(root, 'invalid-pack.json');
    await writeFile(invalidSource, '{}');
    await writeFile(
        source,
        JSON.stringify({
            schemaVersion: 1,
            id: 'python-ui',
            version: '1.0.0',
            title: 'Python UI',
            description: 'Python language support',
            filetypes: ['python'],
            serverName: 'python_ui',
            command: ['${node}', resolve('tests/fixtures/language-pack-server.mjs')]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const options = { args: ['.', `--user-data-dir=${profile}`], env };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.getByRole('button', { name: 'Open a local or WSL workspace' }).click();
        const address = page.getByRole('textbox', { name: 'Folder path' });
        await address.fill(project);
        await address.press('Enter');
        await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
            'aria-busy',
            'false'
        );
        await page.keyboard.press('Control+Enter');
        await expect(
            page.getByRole('tab', { name: 'Workspace Project', exact: true })
        ).toBeVisible();
        await page.keyboard.press('Control+Shift+x');
        await page.getByRole('tab', { name: 'Language packs', exact: true }).click();
        await expect(page.locator('[data-pack]')).toHaveCount(3);
        await running.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        }, invalidSource);
        await page.getByRole('button', { name: 'Install language pack', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('Invalid language pack');
        await expect(page.locator('[data-pack]')).toHaveCount(3);
        await running.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        }, source);
        await page.getByRole('button', { name: 'Install language pack', exact: true }).click();
        await expect(page.locator('[data-pack]')).toHaveCount(4);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.locator('[data-pack="python-ui"]')).toContainText('Installed');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.py');
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /print/);
        await page.keyboard.press('Control+Shift+x');
        await page.getByRole('tab', { name: 'Language packs', exact: true }).click();
        await expect(page.locator('[data-pack="python-ui"] [data-status]')).toHaveAttribute(
            'data-status',
            'running'
        );
        await page.setViewportSize({ width: 960, height: 720 });
        await page.screenshot({ path: 'test-results/language-packs-en.png' });
        await page.getByRole('checkbox', { name: 'Enable Python UI', exact: true }).uncheck();
        await expect(page.locator('[data-pack="python-ui"] [data-status]')).toHaveAttribute(
            'data-status',
            'disabled'
        );
        await expect(
            page.getByRole('checkbox', { name: 'Enable Python UI', exact: true })
        ).toBeEnabled();
        await page.keyboard.press('Escape');
        const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
        await expect(input).toBeFocused();
        await page.keyboard.type('ggI# edited ');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(join(project, 'sample.py'), 'utf8')).toMatch(/^# edited /);
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await expect(
            page.getByRole('tab', { name: 'Workspace Project', exact: true })
        ).toBeVisible();
        await page.keyboard.press('Control+Shift+x');
        await page.getByRole('tab', { name: 'Language packs', exact: true }).click();
        await expect(page.locator('[data-pack]')).toHaveCount(4);
        await expect(
            page.getByRole('checkbox', { name: 'Enable Python UI', exact: true })
        ).not.toBeChecked();
        await page.getByRole('checkbox', { name: 'Enable Python UI', exact: true }).check();
        await expect(page.locator('[data-pack="python-ui"] [data-status]')).toHaveAttribute(
            'data-status',
            'running'
        );
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Shift+x');
        await page.getByRole('tab', { name: '言語パック', exact: true }).click();
        await expect(
            page.getByRole('button', { name: '言語パックを追加', exact: true })
        ).toBeVisible();
        await page.screenshot({ path: 'test-results/language-packs-ja.png' });
        expect(
            await page
                .locator('[role="tabpanel"]')
                .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
