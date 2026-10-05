import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electron } from '../helpers/electron';
import { windowsBaselineCases } from './cases';

async function profileFor(root: string, folders: string[], filename: string): Promise<string> {
    const profile = join(root, 'isolated profile');
    await mkdir(profile);
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1200, height: 900, maximized: false },
            workspaces: folders.map((folder) => ({
                root: folder,
                current: join(folder, filename),
                files: [{ path: join(folder, filename), line: 1, column: 0 }]
            }))
        })
    );
    return profile;
}

async function launch(profile: string): Promise<ElectronApplication> {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );
    env.VIMINIT = 'lua error("Personal configuration must not run")';
    delete env.ELECTRON_RUN_AS_NODE;
    return electron.launch({ args: [`--user-data-dir=${profile}`], env });
}

async function stop(running: ElectronApplication | undefined, root: string): Promise<void> {
    try {
        // These fixtures deliberately leave unsaved buffers: no native confirmation dialog.
        await running?.evaluate(({ app }) => app.exit(0));
    } finally {
        try {
            await running?.close();
        } finally {
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }
}

test(windowsBaselineCases[0], async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-windows-unicode-'));
    const workspace = join(root, '日本語 project');
    const filename = 'メモ 日本語.txt';
    const file = join(workspace, filename);
    let running: ElectronApplication | undefined;
    try {
        await mkdir(workspace);
        await writeFile(file, '日本語のファイル\r\nsecond line\r\n');
        const profile = await profileFor(root, [workspace], filename);
        running = await launch(profile);
        const page = await running.firstWindow();
        await expect(page.getByRole('tab', { name: filename, exact: true })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        await expect(canvas).toHaveAttribute('aria-description', /日本語のファイル/);
        await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('CRLF');
        const metadata = await running.evaluate(({ app }) => ({
            packaged: app.isPackaged,
            profile: app.getPath('userData'),
            executable: process.execPath,
            version: app.getVersion()
        }));
        expect(metadata.packaged).toBe(true);
        expect(resolve(metadata.profile)).toBe(resolve(profile));
        expect(resolve(metadata.executable).toLowerCase()).toBe(
            resolve(process.env.NIDO_PACKAGED_EXE!).toLowerCase()
        );
        expect(metadata.version).toBe(JSON.parse(await readFile('package.json', 'utf8')).version);
        // Query the running Neovim, rather than merely checking that nvim.exe exists.
        await page.keyboard.type(':lua print("BUNDLED_NVIM=" .. vim.v.progpath:gsub("\\\\", "/"))');
        await page.keyboard.press('Enter');
        await expect(canvas).toHaveAttribute(
            'aria-description',
            /BUNDLED_NVIM=.*resources\/nvim-win64\/bin\/nvim\.exe/i
        );
        await page.keyboard.press('Escape');
        await page.keyboard.type('gg0iOK ');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(file, 'utf8'))
            .toBe('OK 日本語のファイル\r\nsecond line\r\n');
    } finally {
        await stop(running, root);
    }
});

test(windowsBaselineCases[1], async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-windows-input-'));
    const workspace = join(root, 'workspace');
    const file = join(workspace, 'input.txt');
    let running: ElectronApplication | undefined;
    try {
        await mkdir(workspace);
        await writeFile(file, 'ab\r\n');
        running = await launch(await profileFor(root, [workspace], 'input.txt'));
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        // All three requests are intentionally in flight together. Paste must share the input queue.
        await page.evaluate(async () => {
            const { active } = await window.nido.restoreWorkspaces();
            await Promise.all([
                window.nido.input(active, 'gg0i'),
                window.nido.paste(active, 'X'),
                window.nido.input(active, 'Y<Esc>')
            ]);
        });
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(file, 'utf8')).toBe('XYab\r\n');
        await page.keyboard.type('A');
        await input.evaluate((node) => {
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
            );
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(file, 'utf8')).toBe('XYab@\r\n');

        await running.evaluate(async ({ clipboard }) => {
            // Preserve every clipboard format; never attach personal clipboard contents to reports.
            const items = await clipboard.read();
            Object.assign(globalThis, { nidoBaselineClipboard: items });
            await clipboard.writeText('クリップボード\r\nsecond clipboard line');
        });
        try {
            await page.keyboard.type('Go');
            await page.keyboard.press('Control+Shift+v');
            await page.keyboard.press('Escape');
            await page.keyboard.press('Control+s');
            await expect
                .poll(() => readFile(file, 'utf8'))
                .toBe('XYab@\r\nクリップボード\r\nsecond clipboard line\r\n');
        } finally {
            await running.evaluate(async ({ clipboard }) => {
                const state = globalThis as typeof globalThis & {
                    nidoBaselineClipboard: Electron.ClipboardItem[];
                };
                clipboard.clear();
                if (state.nidoBaselineClipboard.length)
                    await clipboard.write(state.nidoBaselineClipboard);
                delete (state as Partial<typeof state>).nidoBaselineClipboard;
            });
        }
        await page.keyboard.type('Go');
        await input.evaluate((node) => {
            const textarea = node as HTMLTextAreaElement;
            textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            textarea.value = '日本語入力';
            textarea.dispatchEvent(
                new InputEvent('input', { bubbles: true, data: '日本語入力', isComposing: true })
            );
            textarea.dispatchEvent(
                new CompositionEvent('compositionend', { bubbles: true, data: '日本語入力' })
            );
            textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語入力' }));
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(file, 'utf8'))
            .toBe('XYab@\r\nクリップボード\r\nsecond clipboard line\r\n日本語入力\r\n');
    } finally {
        await stop(running, root);
    }
});

async function switchBranch(page: Page, name: string): Promise<void> {
    await page.keyboard.press('Control+Shift+g');
    await expect(page.getByRole('navigation', { name: 'Git views' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Git changes' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('3');
    const browser = page.getByRole('region', { name: 'Git browser' });
    const branches = page.getByRole('listbox', { name: 'Branches' });
    await expect(branches).toBeFocused();
    await expect(browser).toHaveAttribute('aria-busy', 'false');
    await branches
        .getByRole('option')
        .filter({ has: page.getByText(name, { exact: true }) })
        .click();
    await page.keyboard.press('Enter');
}

test(windowsBaselineCases[2], async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-windows-branches-'));
    const alpha = join(root, 'Alpha');
    const beta = join(root, 'Beta');
    const git = (folder: string, ...args: string[]): string =>
        execFileSync(
            'git',
            [
                '-C',
                folder,
                '-c',
                'user.name=Nido Test',
                '-c',
                'user.email=nido-test@example.invalid',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'core.autocrlf=false',
                ...args
            ],
            { encoding: 'utf8', windowsHide: true }
        );
    let running: ElectronApplication | undefined;
    try {
        for (const folder of [alpha, beta]) {
            await mkdir(folder);
            await writeFile(join(folder, 'notes.txt'), 'original\r\n');
            git(folder, 'init', '--initial-branch=main');
            git(folder, 'add', 'notes.txt');
            git(folder, 'commit', '-m', 'Initial fixture');
            git(folder, 'branch', 'other');
        }
        running = await launch(await profileFor(root, [alpha, beta], 'notes.txt'));
        const page = await running.firstWindow();
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.keyboard.type('gg0iALPHA UNSAVED ');
        await page.keyboard.press('Escape');
        const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        await expect(canvas).toHaveAttribute('aria-description', /ALPHA UNSAVED/);
        await page.getByRole('tab', { name: 'Workspace Beta', exact: true }).click();
        await expect(input).toBeFocused();
        await expect(canvas).toHaveAttribute('aria-description', /original/);
        await switchBranch(page, 'other');
        await expect.poll(() => git(beta, 'branch', '--show-current').trim()).toBe('other');
        await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: 'Workspace Alpha', exact: true }).click();
        await expect(canvas).toHaveAttribute('aria-description', /ALPHA UNSAVED original/);
        expect(await readFile(join(alpha, 'notes.txt'), 'utf8')).toBe('original\r\n');
        await page.getByRole('tab', { name: 'Workspace Beta', exact: true }).click();
        await expect(input).toBeFocused();
        await page.keyboard.type('gg0iBETA UNSAVED ');
        await page.keyboard.press('Escape');
        await expect(canvas).toHaveAttribute('aria-description', /BETA UNSAVED/);
        await switchBranch(page, 'main');
        await expect(page.getByRole('alert')).toContainText('Save unsaved editor changes');
        expect(git(beta, 'branch', '--show-current').trim()).toBe('other');
        expect(await readFile(join(beta, 'notes.txt'), 'utf8')).toBe('original\r\n');
    } finally {
        await stop(running, root);
    }
});
