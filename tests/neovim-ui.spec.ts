import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Neovim commands, completion, messages and confirmation render in native Nido cards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-neovim-ui-'));
    const profile = join(root, 'profile');
    const file = join(root, 'sample.txt');
    await mkdir(profile);
    await writeFile(file, 'Editor text stays in the canvas\n日本語のコード\n');
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1100, height: 850, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
        const canvas = page.locator('canvas:visible');
        const command = page.getByRole('dialog', { name: 'Neovim command line', exact: true });
        const messages = page.getByRole('dialog', { name: 'Neovim messages', exact: true });
        await expect(input).toBeFocused();
        await expect(canvas).toHaveAttribute('aria-description', /Editor text stays in the canvas/);
        await page.keyboard.type(':echo "');
        await expect(command).toBeVisible();
        await input.evaluate((node: HTMLTextAreaElement) => {
            node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            node.value = '日本語😀';
            node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
            node.dispatchEvent(
                new CompositionEvent('compositionend', { bubbles: true, data: '日本語😀' })
            );
        });
        await page.keyboard.type('"');
        await expect(command.getByLabel('Command content')).toContainText(':echo "日本語😀"');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await expect(command.locator('[data-neovim-caret]')).toHaveText('😀');
        await expect(input).toBeFocused();
        await command.getByRole('button', { name: 'Cancel command' }).click();
        await expect(command).toHaveCount(0);
        await expect(input).toBeFocused();

        await page.keyboard.type(':ec');
        await page.keyboard.press('Tab');
        const completion = page.getByRole('listbox', { name: 'Command completion' });
        await expect(completion).toBeVisible();
        await expect(page.getByRole('listbox', { name: 'Code completion' })).toHaveCount(0);
        await completion.getByRole('option', { name: 'echo', exact: true }).click();
        await expect(command.getByLabel('Command content')).toContainText(':echo');
        await completion.getByRole('option', { name: 'echomsg', exact: true }).click();
        await expect(command.getByLabel('Command content')).toContainText(':echomsg');
        await page.keyboard.press('Escape');
        await expect(command).toHaveCount(0);

        await page.keyboard.type(':echomsg');
        await expect(command.getByLabel('Command content')).toContainText(':echomsg');
        await page.keyboard.type(' "Native message 日本語"');
        await page.keyboard.press('Enter');
        await expect(messages).toContainText('Native message 日本語');
        await expect(canvas).not.toHaveAttribute('aria-description', /Native message/);
        await expect(command).toHaveCount(0);
        await page.keyboard.type(':NoSuchNidoCommand');
        await page.keyboard.press('Enter');
        await expect(messages.locator('[data-severity="error"]')).toContainText('E492');
        await expect(canvas).not.toHaveAttribute('aria-description', /E492/);
        await page.screenshot({ path: test.info().outputPath('neovim-messages.png') });
        await page.keyboard.press('Escape');

        await page.keyboard.type(':messages');
        await page.keyboard.press('Enter');
        const history = page.getByRole('dialog', { name: 'Message history' });
        await expect(history).toContainText('Native message 日本語');
        await history.getByRole('button', { name: 'Close messages' }).click();
        await expect(history).toHaveCount(0);
        await expect(input).toBeFocused();

        await page.keyboard.type(':let g:nido_choice = confirm("Continue?", "&Yes\\n&No", 2)');
        await page.keyboard.press('Enter');
        await expect(messages).toContainText('Continue?');
        await page.keyboard.press('y');
        await expect(messages).toHaveCount(0);
        await page.keyboard.type(':echo g:nido_choice');
        await page.keyboard.press('Enter');
        await expect(messages.locator('pre')).toHaveText('1');
        await messages.getByRole('button', { name: 'Close messages' }).click();

        await page.keyboard.type(':echo input("Name: ")');
        await page.keyboard.press('Enter');
        await expect(command.getByLabel('Command content')).toContainText('Name: ');
        await page.keyboard.type('Nido');
        await expect(command.getByLabel('Command content')).toContainText('Name: Nido');
        await page.screenshot({ path: test.info().outputPath('neovim-command.png') });
        await page.keyboard.press('Enter');
        await expect(messages).toContainText('Nido');
        await expect(canvas).toHaveAttribute('aria-description', /Editor text stays in the canvas/);
        await expect(input).toBeFocused();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
