import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { electron } from './helpers/electron';

for (const existing of [false, true]) {
    test(`new terminal session selects ${existing ? 'another folder from an active workspace' : 'home'} and restores`, async () => {
        const profile = await mkdtemp(join(tmpdir(), 'nido-terminal-session-'));
        const layoutPath = join(profile, 'workspaces.json');
        const initial = await realpath(existing ? profile : homedir());
        const root = existing ? join(initial, 'terminal with spaces') : initial;
        if (existing) {
            await mkdir(root);
            await writeFile(
                layoutPath,
                JSON.stringify({
                    version: 1,
                    active: 0,
                    workspaces: [{ root: initial, current: '', files: [] }]
                })
            );
        }
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const options = { args: ['.', `--user-data-dir=${profile}`], env };
        let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
        try {
            running = await electron.launch(options);
            let page = await running.firstWindow();
            if (existing) {
                await expect(
                    page.getByRole('textbox', { name: 'Neovim input', exact: true })
                ).toBeFocused();
                await page.keyboard.press('Control+Shift+p');
                await page
                    .getByRole('textbox', { name: 'Filter items' })
                    .fill('New terminal session');
                await page
                    .getByRole('dialog', { name: 'commands palette' })
                    .getByRole('button', { name: /New terminal session/ })
                    .click();
            } else {
                await expect(
                    page.getByRole('heading', { name: 'Make yourself at home.' })
                ).toBeVisible();
                await expect(
                    page.evaluate(() => window.nido.createWorkspace('', 'editor'))
                ).rejects.toThrow('absolute folder path');
                await expect(
                    page.evaluate(() => window.nido.createWorkspace('relative', 'terminal'))
                ).rejects.toThrow('absolute folder path');
                await page
                    .getByRole('button', { name: 'New terminal session', exact: true })
                    .click();
            }
            const picker = page.getByRole('dialog', { name: 'folders palette' });
            await expect(picker).toContainText('New terminal session');
            await expect(picker.getByRole('combobox', { name: 'Session type' })).toHaveCount(0);
            await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
                'aria-busy',
                'false'
            );
            await expect(picker.getByRole('textbox', { name: 'Folder path' })).toHaveValue(initial);
            if (existing) {
                await page.keyboard.press('Control+l');
                await page.keyboard.type(root);
            }
            await page.keyboard.press('Control+Enter');
            const terminalName = `Workspace Terminal · ${basename(root)}`;
            await expect(
                page.getByRole('tab', { name: terminalName, exact: true })
            ).toHaveAttribute('aria-selected', 'true');
            await expect(
                page.getByRole('textbox', { name: 'Terminal input', exact: true })
            ).toBeFocused();
            await expect(page.getByRole('tablist', { name: 'Files', exact: true })).toBeHidden();
            await expect(page.getByRole('tree')).toHaveCount(0);
            await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(
                existing ? 2 : 1
            );
            await page.keyboard.type('echo NIDO_TERMINAL_READY');
            await page.keyboard.press('Enter');
            await expect(
                page.locator('canvas[aria-label="Terminal display"]:visible')
            ).toHaveAttribute('aria-description', /\nNIDO_TERMINAL_READY[ \t]*(?:\n|$)/);
            await page.screenshot({
                path: `test-results/terminal-session-${existing ? 'workspace' : 'home'}.png`
            });
            await running.close();
            running = undefined;
            const saved = JSON.parse(await readFile(layoutPath, 'utf8'));
            expect(saved.workspaces).toHaveLength(existing ? 2 : 1);
            expect(saved.workspaces.at(-1)).toMatchObject({ root, kind: 'terminal', files: [] });

            running = await electron.launch(options);
            page = await running.firstWindow();
            await expect(
                page.getByRole('tab', { name: terminalName, exact: true })
            ).toHaveAttribute('aria-selected', 'true');
            await expect(
                page.getByRole('textbox', { name: 'Terminal input', exact: true })
            ).toBeFocused();
            // A second click must create a separate session, even in the same folder.
            await page.getByRole('button', { name: 'New terminal session', exact: true }).click();
            await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
                'aria-busy',
                'false'
            );
            await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(root);
            await page.keyboard.press('Control+Enter');
            await expect(page.getByRole('tab', { name: terminalName, exact: true })).toHaveCount(2);
            await expect(
                page.getByRole('textbox', { name: 'Terminal input', exact: true })
            ).toBeFocused();
            await expect(page.getByRole('alert')).toHaveCount(0);
        } finally {
            await running?.close();
            await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
