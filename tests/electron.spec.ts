import { test, expect, _electron as electron, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('favorite workspaces support keyboard access, existing tabs, restart and missing folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-favorites-ui-'));
    const alpha = join(root, 'Alpha');
    const beta = join(root, 'Beta');
    await mkdir(alpha);
    await mkdir(beta);
    const profile = join(root, 'profile');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, alpha);
        const alphaStar = page.getByRole('button', {
            name: 'Favorite workspace Alpha',
            exact: true
        });
        await expect(alphaStar).toHaveAttribute('aria-pressed', 'false');
        await alphaStar.click();
        await expect(alphaStar).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, beta);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+Shift+p');
        await page
            .getByRole('textbox', { name: 'Filter items' })
            .fill('Add workspace to favorites');
        await page.keyboard.press('Enter');
        await expect(
            page.getByRole('button', { name: 'Favorite workspace Beta', exact: true })
        ).toHaveAttribute('aria-pressed', 'true');

        await page.keyboard.press('Control+Shift+n');
        const choices = page.getByRole('listbox', { name: 'Folders' });
        await expect(choices).toBeFocused();
        await expect(choices.getByRole('option', { name: /^Favorite / })).toHaveCount(2);
        await page.keyboard.press('j');
        await expect(
            choices.getByRole('option', { name: 'Favorite Beta (editor)', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('k');
        await page.keyboard.press('Enter');
        await expect(
            page.getByRole('tab', { name: 'Workspace Alpha', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(2);

        await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(1);
        await page.keyboard.press('Control+Shift+n');
        await expect(
            choices.getByRole('option', { name: 'Favorite Alpha (editor)', exact: true })
        ).toBeVisible();
        await choices
            .getByRole('button', { name: 'Remove favorite Beta (editor)', exact: true })
            .click();
        await expect(
            choices.getByRole('option', { name: 'Favorite Beta (editor)', exact: true })
        ).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Favorite workspace Beta', exact: true })
        ).toHaveAttribute('aria-pressed', 'false');
        await page.screenshot({ path: 'test-results/workspace-favorites.png' });
        await choices.getByRole('option', { name: 'Favorite Alpha (editor)', exact: true }).click();
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(2);
        await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
        await page.getByRole('button', { name: 'Close workspace Beta', exact: true }).click();
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
        const closed = running.waitForEvent('close');
        await page.evaluate(() => {
            void window.nido.windowAction('close');
        });
        await closed;
        running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
        page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Favorite workspace Alpha', exact: true })
        ).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
        await rm(alpha, { recursive: true, force: true });
        await page.keyboard.press('Control+Shift+n');
        await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByText(/ENOENT/)).toBeVisible();
        await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
        await page
            .getByRole('button', { name: 'Remove favorite Alpha (editor)', exact: true })
            .click();
        await expect(page.getByRole('option', { name: /^Favorite / })).toHaveCount(0);
        await expect
            .poll(async () => JSON.parse(await readFile(join(profile, 'favorites.json'), 'utf8')))
            .toEqual([]);
        const rejected = await page.evaluate(async () => {
            try {
                await window.nido.setWorkspaceFavorite('relative', 'editor', true);
                return false;
            } catch {
                return true;
            }
        });
        expect(rejected).toBe(true);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Rust Run and Debug lenses work entirely from the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-runnable-ui-'));
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(
        join(workspace, 'Cargo.toml'),
        '[package]\nname="nido_lens_ui"\nversion="0.1.0"\nedition="2021"\n'
    );
    await writeFile(
        join(workspace, 'src/main.rs'),
        'fn main() {\n    println!("keyboard-run");\n}\n#[test]\nfn keyboard_test() { println!("keyboard-test"); }\n' +
            Array.from({ length: 4 }, (_, index) => `#[test]\nfn extra_${index}() {}\n`).join('')
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.keyboard.type(':edit src/main.rs');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /Run \(gR\) \| Debug \(gD\)/, {
            timeout: 25000
        });
        await expect(canvas).toHaveAttribute(
            'aria-description',
            /Run Tests \(gR\) \| Debug \(gD\)/
        );
        await expect(canvas).toHaveAttribute('aria-description', /extra_3/);
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const ctx = node.getContext('2d')!;
            const clear = ctx.fillRect.bind(ctx);
            ctx.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height === node.clientHeight) {
                    node.setAttribute('data-code-points', '[]');
                    node.removeAttribute('data-lens-point');
                }
                clear(x, y, width, height);
            };
            const pointsByImage = new WeakMap<
                HTMLCanvasElement,
                { value: string; x: number; y: number; font: number }[]
            >();
            const text = CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText = function (value, x, y, ...rest) {
                const points = pointsByImage.get(this.canvas) || [];
                points.push({ value, x, y, font: parseFloat(this.font) });
                pointsByImage.set(this.canvas, points);
                text.call(this, value, x, y, ...rest);
            };
            const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                draw(...args);
                if (args.length !== 5) return;
                for (const { value, x, y: localY, font } of pointsByImage.get(
                    args[0] as HTMLCanvasElement
                ) || []) {
                    const y = localY + Number(args[2]);
                    if (value === 'f' || value === 'p') {
                        const points = JSON.parse(node.getAttribute('data-code-points') || '[]');
                        points.push({ value, x, y, font });
                        node.setAttribute('data-code-points', JSON.stringify(points));
                    } else if (
                        value.includes('Run Tests') &&
                        !node.hasAttribute('data-lens-point')
                    ) {
                        node.setAttribute('data-lens-point', JSON.stringify({ y, font }));
                    }
                }
            }) as typeof draw;
        });
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
        await expect(canvas).toHaveAttribute('data-lens-point', /y/);
        const points = JSON.parse((await canvas.getAttribute('data-code-points'))!) as {
            value: string;
            x: number;
            y: number;
            font: number;
        }[];
        const [main, testFunction] = points.filter((point) => point.value === 'f');
        const body = points.find((point) => point.value === 'p')!;
        const lineHeight = await page.evaluate(() =>
            Number(localStorage.getItem('nido.lineHeight'))
        );
        const lens = JSON.parse((await canvas.getAttribute('data-lens-point'))!);
        const lensHeight = 2 * (testFunction.y - lens.y) - lineHeight - (main.font - lens.font);
        expect(body.y - main.y).toBeCloseTo(lineHeight, 0);
        expect(lensHeight / lineHeight).toBeGreaterThan(0.65);
        expect(lensHeight / lineHeight).toBeLessThan(0.75);
        await expect
            .poll(async () => (await canvas.getAttribute('aria-description'))!.split('\n').length)
            .toBeGreaterThan(Math.floor((await canvas.boundingBox())!.height / lineHeight) + 1);
        await canvas.click({ position: { x: testFunction.x + 2, y: testFunction.y - 4 } });
        await expect(page.getByText('Ln 5, Col 1', { exact: true })).toBeVisible();
        await expect
            .poll(() => input.evaluate((node) => node.offsetTop))
            .toBeCloseTo(testFunction.y - (lineHeight + main.font) / 2 + 3, 0);
        await page.keyboard.type(':');
        await expect
            .poll(() => input.evaluate((node) => node.offsetTop))
            .toBe(
                Math.floor((await canvas.boundingBox())!.height / lineHeight) * lineHeight -
                    lineHeight
            );
        await page.keyboard.press('Escape');
        await page.keyboard.type('gggR');
        const output = page.getByLabel('Debug output');
        await expect(output).toContainText('keyboard-run', { timeout: 15000 });
        await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
            'Run · finished'
        );
        await expect(input).toBeFocused();
        await page.keyboard.type('5GgR');
        await expect(output).toContainText('keyboard-test', { timeout: 15000 });
        await expect(output).toContainText('Process exited: 0');
        await page.keyboard.type('gggD');
        await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
            'Debug · finished',
            { timeout: 15000 }
        );
        await expect(output).toContainText('keyboard-run');
        await expect(input).toBeFocused();
        await page.screenshot({ path: 'test-results/rust-runnable-lenses.png' });
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

for (const animations of [true, false]) {
    test(`navigation notices use native cards without stealing editor focus (animations ${animations})`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-native-notice-'));
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        await writeFile(join(workspace, 'notes.txt'), 'hello\n');
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const running = await electron.launch({
            args: ['.', `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        try {
            const page = await running.firstWindow();
            await page.evaluate(
                (enabled) => localStorage.setItem('nido.animations', String(enabled)),
                animations
            );
            await page.reload();
            await expect(
                page.getByRole('heading', { name: 'Make yourself at home.' })
            ).toBeVisible();
            await page.keyboard.press('Control+Shift+n');
            await chooseWorkspace(page, workspace);
            const input = page.getByRole('textbox', { name: 'Neovim input' });
            await expect(input).toBeFocused();
            await page.keyboard.type(':edit notes.txt');
            await page.keyboard.press('Enter');
            await expect(page.locator('canvas:visible')).toHaveAttribute(
                'aria-description',
                /hello/
            );
            await page.keyboard.type(':lua vim.notify("No locations found", vim.log.levels.INFO)');
            await page.keyboard.press('Enter');
            const notice = page.getByRole('status', { name: 'Code navigation' });
            await expect(notice).toContainText('No locations found');
            await expect(input).toBeFocused();
            await page.screenshot({ path: 'test-results/native-notification.png' });
            await page.keyboard.press('Escape');
            await expect(notice).toHaveCount(0);
            await page.keyboard.type(':lua vim.notify("No locations found", vim.log.levels.INFO)');
            await page.keyboard.press('Enter');
            await expect(notice).toBeVisible();
            await expect(notice).toHaveCSS('opacity', '1');
            await expect(notice).toHaveCSS('transition-duration', animations ? '0.3s' : '0s');
            const displayedAt = Date.now();
            if (animations) {
                await expect
                    .poll(
                        async () =>
                            Number(
                                await notice.evaluate(
                                    (element) => getComputedStyle(element).opacity
                                )
                            ),
                        {
                            intervals: [50],
                            timeout: 2500
                        }
                    )
                    .toBeLessThan(1);
                expect(Date.now() - displayedAt).toBeGreaterThan(1700);
            }
            await expect(notice).toHaveCount(0, { timeout: 3000 });
            expect(Date.now() - displayedAt).toBeGreaterThan(1700);
            await expect(input).toBeFocused();
            await page.clock.install({ time: new Date(0) });
            await page.clock.pauseAt(new Date(1000));
            const showError = async (): Promise<void> => {
                await running.evaluate(({ BrowserWindow }) => {
                    BrowserWindow.getAllWindows()[0].webContents.send('nido:event', {
                        type: 'error',
                        id: 'test',
                        message:
                            "Error: Error invoking remote method 'nido:editorConfig': Error: Workspace is no longer running."
                    });
                });
            };
            const error = page
                .getByRole('alert')
                .filter({ hasText: 'Workspace is no longer running.' });
            await showError();
            await expect(error).toHaveText('Workspace is no longer running.');
            await expect(input).toBeFocused();
            await expect(error).toHaveCSS('transition-duration', animations ? '0.3s' : '0s');
            await page.clock.runFor(1500);
            await showError();
            await page.clock.runFor(1500);
            await expect(error).toHaveCSS('opacity', '1');
            await page.clock.runFor(500);
            if (animations) {
                await expect(error).toHaveAttribute('data-fading', 'true');
                await page.clock.runFor(300);
            }
            await expect(error).toHaveCount(0);
            await expect(input).toBeFocused();
            await showError();
            await expect(error).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(error).toHaveCount(0);
            await showError();
            await page.getByRole('button', { name: 'Dismiss error' }).click();
            await expect(error).toHaveCount(0);
            await expect(input).toBeFocused();
        } finally {
            await running.evaluate(({ app }) => app.exit(0));
            await running.close();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}

test('Ctrl star and hash searches show readable matches, counts and controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-word-search-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'words.txt'), 'alpha beta alpha\nalpha\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.keyboard.type(':edit words.txt');
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /alpha beta alpha/
        );
        await page.keyboard.press('Escape');
        await page.keyboard.type('gg0');
        await page.keyboard.press('Control+Shift+*');
        const search = page.getByRole('status', { name: 'Search matches' });
        await expect(search).toContainText('alpha');
        await expect(search).toContainText('2 / 3');
        await page.keyboard.press('Control+Shift+#');
        await expect(search).toContainText('1 / 3');
        await search.getByRole('button', { name: 'Next search match', exact: true }).click();
        await expect(search).toContainText('3 / 3');
        await expect(input).toBeFocused();
        await page.screenshot({ path: 'test-results/word-search.png' });
        await page.keyboard.press('Escape');
        await expect(search).toHaveCount(0);
        await page.keyboard.type('/beta');
        await page.keyboard.press('Enter');
        await expect(search).toContainText('beta');
        await expect(search).toContainText('1 / 1');
        await search.getByRole('button', { name: 'Clear search highlights', exact: true }).click();
        await expect(search).toHaveCount(0);
        expect(await readFile(join(workspace, 'words.txt'), 'utf8')).toBe(
            'alpha beta alpha\nalpha\n'
        );
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('explorer commands create, rename, copy, move and recycle files from the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-explorer-actions-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'original.txt'), 'hello\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        const tree = page.getByRole('tree', { name: 'Project files' });
        const menu = page.getByRole('dialog', { name: 'Explorer commands', exact: true });
        const path = menu.getByRole('textbox', { name: /^(Workspace-relative path|Name)$/ });
        const apply = async (value: string): Promise<void> => {
            await expect(menu).toBeVisible();
            await path.fill(value);
            await page.keyboard.press('Enter');
            await expect(menu).toHaveCount(0);
            await expect(tree).toBeFocused();
        };
        const select = async (name: string): Promise<void> => {
            const item = tree.getByRole('treeitem', { name, exact: true });
            await item.click();
            if ((await item.getAttribute('aria-expanded')) === null) {
                await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
                await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
            }
            await tree.focus();
        };
        await expect(
            tree.getByRole('treeitem', { name: 'original.txt', exact: true })
        ).toBeVisible();
        await select('original.txt');
        await page.keyboard.press('F2');
        await apply('renamed.txt');
        await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Control+l');
        await page.keyboard.type('A!');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(join(workspace, 'renamed.txt'), 'utf8')).toBe('hello!\n');
        await tree.focus();
        await page.keyboard.press('Control+c');
        await page.keyboard.press('Control+v');
        await apply('copy.txt');
        await expect.poll(() => readFile(join(workspace, 'copy.txt'), 'utf8')).toBe('hello!\n');
        await page.keyboard.type(':');
        await expect(menu).toBeVisible();
        await menu.screenshot({ path: 'test-results/explorer-commands.png' });
        await page.keyboard.type('A');
        await apply('nested');
        await page.keyboard.type('a');
        await apply('nested/new.txt');
        await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toBeVisible();
        await select('renamed.txt');
        await page.keyboard.press('Control+x');
        await select('nested');
        await page.keyboard.press('Control+v');
        await apply('nested/renamed.txt');
        await expect
            .poll(() => readFile(join(workspace, 'nested/renamed.txt'), 'utf8'))
            .toBe('hello!\n');
        await expect(
            tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })
        ).toBeVisible();
        await select('copy.txt');
        await page.keyboard.press('Delete');
        await expect(menu).toContainText('Move copy.txt to the recycle bin?');
        await menu.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(tree.getByRole('treeitem', { name: 'copy.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Delete');
        await menu.getByRole('button', { name: 'Move to recycle bin', exact: true }).click();
        await expect(menu).toHaveCount(0);
        await expect(tree.getByRole('treeitem', { name: 'copy.txt', exact: true })).toHaveCount(0);
        await expect(page.getByRole('tab', { name: 'copy.txt', exact: true })).toHaveCount(0);
        await assert.rejects(readFile(join(workspace, 'copy.txt'), 'utf8'), /ENOENT/);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('explorer supports half-page, page and first/last selection with Vim keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-explorer-keys-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await Promise.all(
        Array.from({ length: 80 }, (_, index) =>
            writeFile(join(workspace, `file-${String(index).padStart(2, '0')}.txt`), 'sample\n')
        )
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+h');
        const tree = page.getByRole('tree', { name: 'Project files' });
        await expect(tree).toBeFocused();
        await expect(tree.getByRole('treeitem')).toHaveCount(80);
        const selected = tree.locator('[aria-selected="true"]');
        await page.keyboard.type('gg');
        await expect(selected).toHaveText('file-00.txt');
        const step = await tree.evaluate((node) =>
            Math.max(
                1,
                Math.floor(
                    node.clientHeight /
                        node.querySelector('[role="treeitem"]')!.getBoundingClientRect().height /
                        2
                )
            )
        );
        await page.keyboard.press('Control+d');
        await expect(selected).toHaveText(`file-${String(step).padStart(2, '0')}.txt`);
        await page.keyboard.press('Control+u');
        await expect(selected).toHaveText('file-00.txt');
        await page.keyboard.press('Control+f');
        await expect(selected).not.toHaveText(`file-${String(step).padStart(2, '0')}.txt`);
        await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await page.keyboard.press('Control+b');
        await expect(selected).toHaveText('file-00.txt');
        await page.keyboard.press('Shift+g');
        await expect(selected).toHaveText('file-79.txt');
        await page.keyboard.press('Control+d');
        await expect(selected).toHaveText('file-79.txt');
        await page.keyboard.press('Control+g');
        await expect(selected).toHaveText('file-79.txt');
        await tree.dispatchEvent('keydown', { key: 'g', isComposing: true });
        await expect(selected).toHaveText('file-79.txt');
        await page.keyboard.type('gg');
        await expect(selected).toHaveText('file-00.txt');
        await page.keyboard.press('PageDown');
        await expect(selected).not.toHaveText('file-00.txt');
        await page.keyboard.press('PageUp');
        await expect(selected).toHaveText('file-00.txt');
        await expect(tree).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'file-00.txt', exact: true })).toBeVisible();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('file tabs scroll into view when switching hidden buffers with Shift H and L', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-tab-scroll-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const files = Array.from(
        { length: 15 },
        (_, index) => `file-${String(index).padStart(2, '0')}.txt`
    );
    await Promise.all(files.map((file) => writeFile(join(workspace, file), 'sample\n')));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await page.setViewportSize({ width: 900, height: 650 });
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
        const selected = tabs.locator('[role="tab"][aria-selected="true"]');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        const expectSelectedVisible = async (file: string): Promise<void> => {
            await expect(selected).toHaveText(file);
            await expect
                .poll(() =>
                    selected.evaluate((node) => {
                        const tab = node.parentElement!.getBoundingClientRect();
                        const list = node.closest('[role="tablist"]')!.getBoundingClientRect();
                        return tab.left >= list.left - 1 && tab.right <= list.right + 1;
                    })
                )
                .toBe(true);
            await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        };
        for (const file of files) {
            await page.keyboard.type(`:edit ${file}`);
            await page.keyboard.press('Enter');
            await expect(selected).toHaveText(file);
        }
        await expectSelectedVisible(files.at(-1)!);
        await expect.poll(() => tabs.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await page.keyboard.press('Shift+L');
        await expectSelectedVisible(files[0]);
        await expect.poll(() => tabs.evaluate((node) => node.scrollLeft)).toBe(0);
        await page.keyboard.press('Shift+H');
        await expectSelectedVisible(files.at(-1)!);
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('completion opens on typing and Ctrl Space, accepts with Tab, and files show diagnostic counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-completion-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'tsconfig.json'), '{}');
    await writeFile(
        join(workspace, 'main.ts'),
        'const amount = 1;\nconst getOldUser = 1;\nconst getUserName = 1;\nconst getUser = 1;\n'
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await page.setViewportSize({ width: 1100, height: 720 });
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.evaluate(() => {
            const stop = window.nido.onEvent((event) => {
                if (event.type !== 'redraw') return;
                document.documentElement.dataset.completionSession = event.id;
                stop();
            });
        });
        await page.keyboard.type(':edit main.ts');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /const amount/);
        await page.keyboard.type(
            ":lua assert(vim.wait(20000, function() local c = vim.lsp.get_clients({bufnr=0})[1]; return c and c.initialized end, 50)); print('COMPLETION_READY')"
        );
        await page.keyboard.press('Enter');
        await expect(canvas).toHaveAttribute('aria-description', /COMPLETION_READY/, {
            timeout: 25000
        });
        await page.keyboard.type(
            ":lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=0,col=0,severity=1,message='Error 1'}, {lnum=0,col=0,severity=1,message='Error 2'}, {lnum=0,col=0,severity=2,message='Warning 1'}, {lnum=0,col=0,severity=2,message='Warning 2'}, {lnum=0,col=0,severity=2,message='Warning 3'}})"
        );
        await page.keyboard.press('Enter');
        const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
        const tree = page.getByRole('tree', { name: 'Project files' });
        for (const host of [tabs, tree]) {
            await expect(host.getByLabel('2 errors', { exact: true })).toBeVisible();
            await expect(host.getByLabel('3 warnings', { exact: true })).toBeVisible();
        }
        await page.evaluate(() => {
            const state = window as Window & { completionLatency: Promise<number> };
            state.completionLatency = new Promise((resolve) => {
                let start = 0;
                const onKey = (event: KeyboardEvent): void => {
                    if (event.key === 'm') start = performance.now();
                };
                document.addEventListener('keydown', onKey);
                const observer = new MutationObserver(() => {
                    if (!start || !document.querySelector('[aria-label="Code completion"]')) return;
                    observer.disconnect();
                    document.removeEventListener('keydown', onKey);
                    resolve(performance.now() - start);
                });
                observer.observe(document.body, { childList: true, subtree: true });
            });
        });
        await page.keyboard.type('Goam');
        const menu = page.getByRole('listbox', { name: 'Code completion' });
        await expect(menu).toBeVisible({ timeout: 15000 });
        const completionMs = await page.evaluate(
            () => (window as Window & { completionLatency: Promise<number> }).completionLatency
        );
        console.log(`Automatic completion: ${completionMs.toFixed(1)} ms`);
        await expect(menu.getByRole('option').first()).toContainText('amount');
        const sessionId = await page.evaluate(
            () => document.documentElement.dataset.completionSession!
        );
        const inputTop = await input.evaluate((node) => node.offsetTop);
        const menuTop = await menu.evaluate((node) => node.parentElement!.offsetTop);
        await page.evaluate(({ id, keys }) => window.nido.input(id, keys), {
            id: sessionId,
            keys: "<Cmd>lua vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace('completion-lens-test'), 1, 0, {virt_lines={{{'Run Tests', 'NidoCodeLens'}}}, virt_lines_above=true})<CR>"
        });
        await expect(canvas).toHaveAttribute('aria-description', /Run Tests/);
        await expect.poll(() => input.evaluate((node) => node.offsetTop)).toBeGreaterThan(inputTop);
        const lensHeight = (await input.evaluate((node) => node.offsetTop)) - inputTop;
        await expect
            .poll(() => menu.evaluate((node) => node.parentElement!.offsetTop))
            .toBe(menuTop + lensHeight);
        await page.evaluate(({ id, keys }) => window.nido.input(id, keys), {
            id: sessionId,
            keys: "<Cmd>lua vim.api.nvim_buf_clear_namespace(0, vim.api.nvim_create_namespace('completion-lens-test'), 0, -1)<CR>"
        });
        await expect
            .poll(() => menu.evaluate((node) => node.parentElement!.offsetTop))
            .toBe(menuTop);
        await expect(menu.getByRole('option').first().getByRole('img')).toHaveAttribute(
            'aria-label',
            /Variable|Constant/
        );
        await expect(
            menu.getByRole('option').first().getByRole('img').locator('svg')
        ).toBeVisible();
        await menu.evaluate((element) => element.setAttribute('data-test-continuity', 'kept'));
        await page.keyboard.type('oun', { delay: 180 });
        await expect(menu).toHaveAttribute('data-test-continuity', 'kept');
        await page.keyboard.press('Backspace');
        await expect(canvas).toHaveAttribute('aria-description', /amou\s*\n/);
        await expect(menu).toHaveAttribute('aria-busy', 'false');
        await expect(menu).toHaveAttribute('data-test-continuity', 'kept');
        await page.keyboard.press('Tab');
        await expect(menu).toHaveCount(0);
        await expect(canvas).toHaveAttribute('aria-description', /amount/);
        await page.keyboard.type('.to');
        await expect(menu.getByRole('option').filter({ hasText: 'toFixed' })).toBeVisible();
        await expect(
            menu.getByRole('option').filter({ hasText: 'toFixed' }).getByRole('img')
        ).toHaveAttribute('aria-label', 'Method');
        await expect(menu.getByText('Method', { exact: true })).toHaveCount(0);
        const popupBounds = await menu.boundingBox();
        await page.keyboard.type('F');
        await expect(menu.getByRole('option')).toHaveCount(1);
        expect(await menu.boundingBox()).toEqual(popupBounds);
        await page.keyboard.press('Backspace');
        await expect(menu.getByRole('option')).toHaveCount(6);
        expect(await menu.boundingBox()).toEqual(popupBounds);
        await page.keyboard.press('Control+e');
        await expect(menu).toHaveCount(0);
        await page.keyboard.press('Control+Space');
        await expect(menu).toBeVisible();
        const index = (await menu.getByRole('option').allTextContents()).findIndex((text) =>
            text.includes('toFixed')
        );
        expect(index).toBeGreaterThanOrEqual(0);
        for (let step = 0; step <= index; step++) {
            await page.keyboard.press('ArrowDown');
            await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
        }
        await expect(menu.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Control+n');
        await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
        await page.keyboard.press('Control+p');
        await expect(menu.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
        await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
        await menu.getByRole('option').nth(index).click();
        await expect(menu).toBeVisible();
        await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
        await expect(input).toBeFocused();
        await page.screenshot({ path: 'test-results/nido-completion.png' });
        await page.keyboard.press('Tab');
        await expect(menu).toHaveCount(0);
        await expect(canvas).toHaveAttribute('aria-description', /amount.toFixed/);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(workspace, 'main.ts'), 'utf8'))
            .toContain('amount.toFixed');
        await page.keyboard.type(':');
        await expect(page.getByText('COMMAND', { exact: true })).toBeVisible();
        await page.keyboard.type('edit note.txt');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'note.txt', exact: true })).toBeVisible();
        await page.keyboard.press('i');
        await page.keyboard.press('Tab');
        await page.keyboard.type('plain');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(workspace, 'note.txt'), 'utf8'))
            .toMatch(/^ {2}plain\r?\n$/);
        await page.keyboard.type(':');
        await expect(page.getByText('COMMAND', { exact: true })).toBeVisible();
        await page.keyboard.type('edit main.ts');
        await page.keyboard.press('Enter');
        await expect(canvas).toHaveAttribute('aria-description', /getOldUser/);
        await page.keyboard.press('Escape');
        await page.keyboard.type('GogetU');
        await expect(menu).toBeVisible();
        await expect(
            menu.getByRole('option').first().getByText('getUser', { exact: true })
        ).toBeVisible();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(workspace, 'main.ts'), 'utf8'))
            .toMatch(/\ngetUser\r?\n$/);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('typing hides the pointer and moving or clicking restores it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-pointer-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env
    });
    try {
        const page = await running.firstWindow();
        const settings = page.getByRole('button', { name: 'Settings', exact: true });
        await settings.click();
        const slider = page.getByRole('spinbutton', { name: 'Editor font size' });
        await slider.focus();
        await page.keyboard.press('ArrowRight');
        await expect(slider).toHaveCSS('cursor', 'none');
        await expect(settings).toHaveCSS('cursor', 'none');
        await page.mouse.move(600, 400);
        await expect(slider).not.toHaveCSS('cursor', 'none');
        await page.keyboard.press('ArrowLeft');
        await expect(slider).toHaveCSS('cursor', 'none');
        await page.mouse.down();
        await page.mouse.up();
        await expect(settings).not.toHaveCSS('cursor', 'none');
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Markdown preview renders unsaved edits and supports keyboard scrolling and dismissal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-markdown-preview-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const source =
        '# Preview\n\n**Bold** and *italic*.\n\n| Name | Value |\n| --- | --- |\n| Nido | 42 |\n\n```ts\nconst value = 42;\n```\n\n- [x] Done\n\n[Unsafe](javascript:alert(1))\n<script>window.previewUnsafe = true</script>\n\n' +
        Array.from({ length: 50 }, (_, index) => `Paragraph ${index + 1}.\n\n`).join('');
    await writeFile(join(workspace, 'preview.md'), source);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('preview.md');
        await expect(page.getByRole('button', { name: /preview.md/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /Preview/);
        await page.keyboard.type('Go## Unsaved heading');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Shift+v');
        const popup = page.getByRole('dialog', { name: 'markdown palette' });
        const content = page.getByLabel('Markdown preview content', { exact: true });
        await expect(popup).toBeVisible();
        await expect(content).toBeFocused();
        await expect(content.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
        await expect(content.locator('strong')).toHaveText('Bold');
        await expect(content.getByRole('table')).toContainText('42');
        await expect(content.locator('pre')).toContainText('const value = 42');
        await expect(content.getByRole('heading', { name: 'Unsaved heading' })).toHaveCount(1);
        await expect(content.locator('script')).toHaveCount(0);
        await expect(content.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
        expect(await page.evaluate(() => 'previewUnsafe' in window)).toBe(false);
        expect(await readFile(join(workspace, 'preview.md'), 'utf8')).toBe(source);
        await page.keyboard.press('Control+d');
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await page.keyboard.press('Control+u');
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
        await popup.screenshot({ path: 'test-results/nido-markdown-preview.png' });
        await page.keyboard.press('Control+Shift+v');
        await expect(popup).toBeHidden();
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+Shift+v');
        await expect(popup).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(popup).toBeHidden();
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('relative line numbers update immediately and persist after restarting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-line-numbers-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'lines.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('lines.txt');
        await expect(page.getByRole('button', { name: /lines.txt/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /line 1/);
        await page.keyboard.type('3G');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const setting = page.getByRole('checkbox', { name: 'Relative line numbers' });
        await expect(setting).not.toBeChecked();
        const editorConfig = page.getByRole('checkbox', { name: 'Use EditorConfig' });
        await expect(editorConfig).toBeChecked();
        await editorConfig.uncheck();
        await setting.check();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /^\s*2\s+line 1/
        );
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /\n\s*3\s+line 3/
        );
        await setting.uncheck();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /^\s*1\s+line 1/
        );
        await setting.check();
        await page.keyboard.press('Escape');
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /^\s*2\s+line 1/
        );
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Relative line numbers' })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Use EditorConfig' })).not.toBeChecked();
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('word wrap updates long lines immediately and persists after restarting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-word-wrap-ui-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'long.txt'), `${'x'.repeat(400)}WRAP_END\nnext line\n`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('long.txt');
        await expect(page.getByRole('button', { name: /long.txt/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /WRAP_END/
        );
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const setting = page.getByRole('checkbox', { name: 'Word wrap', exact: true });
        await expect(setting).toBeChecked();
        await setting.uncheck();
        await expect(page.locator('canvas:visible')).not.toHaveAttribute(
            'aria-description',
            /WRAP_END/
        );
        await setting.focus();
        await page.keyboard.press('Enter');
        await expect(setting).toBeChecked();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /WRAP_END/
        );
        await setting.uncheck();
        await page.keyboard.press('Escape');
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /next line/
        );
        await expect(page.locator('canvas:visible')).not.toHaveAttribute(
            'aria-description',
            /WRAP_END/
        );
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(
            page.getByRole('checkbox', { name: 'Word wrap', exact: true })
        ).not.toBeChecked();
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('font family and line height update the canvas and survive restarting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-font-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const options = {
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
        env
    };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        const canvasFont = (): Promise<string> =>
            page
                .locator('canvas:visible')
                .evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.font);
        await page.locator('canvas:visible').evaluate((canvas: HTMLCanvasElement) => {
            const context = canvas.getContext('2d')!;
            const draw = context.drawImage.bind(context);
            const fill = context.fillRect.bind(context);
            let firstY: number | undefined;
            context.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height > 100) {
                    firstY = undefined;
                }
                fill(x, y, width, height);
            };
            context.drawImage = ((...args: Parameters<typeof draw>) => {
                if (args.length === 5) {
                    const y = Number(args[2]);
                    if (firstY === undefined) {
                        firstY = y;
                    } else if (y > firstY) {
                        canvas.dataset.lineHeight = String(y - firstY);
                        firstY = Infinity;
                    }
                }
                draw(...args);
            }) as typeof draw;
        });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const heightInput = page.getByRole('spinbutton', { name: 'Editor line height' });
        await expect(heightInput).toHaveValue('18');
        // Row images snap to physical pixels, so fractional DPI can round their spacing.
        const physicalPixel = await page.evaluate(() => 1 / window.devicePixelRatio);
        const heightError = (height: number): Promise<number> =>
            page
                .locator('canvas:visible')
                .getAttribute('data-line-height')
                .then((value) => Math.abs(Number(value) - height));
        await expect.poll(() => heightError(18)).toBeLessThanOrEqual(physicalPixel + 0.001);
        await heightInput.fill('28');
        await expect.poll(() => heightError(28)).toBeLessThanOrEqual(physicalPixel + 0.001);
        let input = page.getByRole('textbox', { name: 'Font family', exact: true });
        const defaultFamily = await input.inputValue();
        expect(defaultFamily).toContain('Cascadia Code');
        await input.fill('monospace');
        await expect.poll(canvasFont).toBe('15px monospace');
        await input.fill('   ');
        await expect.poll(canvasFont).toContain('Cascadia Code');
        await input.fill('Consolas');
        await expect.poll(canvasFont).toBe('15px Consolas');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(input).toHaveValue('Consolas');
        await expect(page.getByRole('spinbutton', { name: 'Editor line height' })).toHaveValue(
            '28'
        );
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        input = page.getByRole('textbox', { name: 'Font family', exact: true });
        await expect(input).toHaveValue('Consolas');
        await expect(page.getByRole('spinbutton', { name: 'Editor line height' })).toHaveValue(
            '28'
        );
        await expect.poll(canvasFont).toBe('15px Consolas');
        await expect(input).toHaveCSS('background-color', 'rgb(18, 20, 22)');
        await input.focus();
        await page.screenshot({ path: 'test-results/nido-font-settings.png' });
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Japanese editor text stays legible at fractional display scales', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-legibility-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(
        join(workspace, 'sample.ts'),
        [
            '// カーソルから画面末尾まで消去する',
            '// 日本語の描画位置・文字の明るさを確認',
            'export function setCursor(row: number, col: number) {',
            '    const message = "画面の表示を更新します";',
            '    const index = (row - 1) * 80 + col;',
            '    return { index, message };',
            '}',
            ''
        ].join('\n')
    );
    await writeFile(join(workspace, 'tsconfig.json'), '{}');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`, '--force-device-scale-factor=1.25'],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.ts');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /日本語の描画位置/);
        await canvas.evaluate((element: HTMLCanvasElement) => {
            const fillText = CanvasRenderingContext2D.prototype.fillText;
            element.dataset.aligned = 'true';
            CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
                const dpr = window.devicePixelRatio;
                if (
                    Math.abs(x * dpr - Math.round(x * dpr)) > 0.001 ||
                    Math.abs(y * dpr - Math.round(y * dpr)) > 0.001
                ) {
                    element.dataset.aligned = 'false';
                }
                if (text === '語') element.dataset.japaneseInk = String(this.fillStyle);
                if (this.fillStyle === '#ffb300')
                    element.dataset.parameterInk = String(this.fillStyle);
                fillText.call(this, text, x, y);
            };
            const ctx = element.getContext('2d')!;
            const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                if (
                    args.length === 5 &&
                    Math.abs(
                        Number(args[2]) * window.devicePixelRatio -
                            Math.round(Number(args[2]) * window.devicePixelRatio)
                    ) > 0.001
                ) {
                    element.dataset.aligned = 'false';
                }
                draw(...args);
            }) as typeof draw;
        });
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'UI animations' }).uncheck();
        await page.getByRole('button', { name: 'Close palette' }).click();
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
        await expect(canvas).toHaveAttribute('data-japanese-ink', '#6a9955');
        await expect(canvas).toHaveAttribute('data-parameter-ink', '#ffb300');
        await expect(canvas).toHaveAttribute('data-aligned', 'true');
        expect(
            await canvas.evaluate(
                (element: HTMLCanvasElement) =>
                    element.getContext('2d')!.getContextAttributes().alpha
            )
        ).toBe(false);
        const bounds = (await canvas.boundingBox())!;
        await page.screenshot({
            path: 'test-results/nido-reference-colors.png',
            clip: { ...bounds, height: 240 }
        });
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('type information is a selectable Nido card with keyboard scrolling and dismissal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-hover-card-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'tsconfig.json'), '{}');
    await writeFile(
        join(workspace, 'sample.ts'),
        [
            '/**',
            ' * カーソル位置を更新します。',
            ' *',
            ' * Returns the **screen position** from `row` and `column`.',
            ' *',
            ' * ## Usage',
            ' *',
            ' * - **row**: vertical position',
            ' * - *column*: horizontal position',
            ' *',
            ' * > Positions start at zero.',
            ' *',
            ' * | Field | Type |',
            ' * | --- | --- |',
            ' * | row | number |',
            ' *',
            ' * [Documentation](https://example.com/docs)',
            ' * [Unsafe](javascript:alert(1))',
            ' * ![Remote illustration](https://example.com/image.png)',
            ' * <script>window.hoverUnsafe = true</script>',
            ...Array.from(
                { length: 25 },
                (_, index) => ` *\n * Detail ${index + 1}: coordinates are measured in cells.`
            ),
            ' */',
            'export function setCursor(row: number, column: number, coordinateSpaceOptionsForViewportAndDocumentPositionCalculation?: { coordinateSpace: "viewport" | "document" }): number {',
            '  return row * 80 + column;',
            '}',
            'setCursor(1, 2);',
            ''
        ].join('\n')
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
        await expect(editor).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.ts');
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /カーソル位置/
        );
        await page.keyboard.type('G0');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /setCursor/
        );
        const popup = page.getByRole('dialog', { name: 'Type information', exact: true });
        await expect(async () => {
            await editor.focus();
            await page.keyboard.press('Control+k');
            await expect(popup.locator('pre')).toContainText('setCursor', { timeout: 1000 });
        }).toPass({ timeout: 15000 });
        const content = page.getByLabel('Type information content', { exact: true });
        await expect(content).toBeFocused();
        await expect(content).toContainText('カーソル位置を更新します');
        await expect(content.getByRole('heading', { name: 'Usage' })).toBeVisible();
        await expect(content.locator('ul li')).toHaveCount(2);
        await expect(content.locator('blockquote')).toContainText('Positions start at zero');
        await expect(content.getByRole('table')).toContainText('number');
        await expect(content.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
            'href',
            'https://example.com/docs'
        );
        await expect(content.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
        await expect(content.locator('img, script')).toHaveCount(0);
        await running.evaluate(({ shell, app }) => {
            shell.openExternal = async (url) => {
                app.setName(url);
            };
        });
        await content.getByRole('link', { name: 'Documentation' }).focus();
        await page.keyboard.press('Enter');
        await expect
            .poll(() => running.evaluate(({ app }) => app.getName()))
            .toBe('https://example.com/docs');
        expect(
            await page.evaluate(() =>
                window.nido.openDocumentation('file:///C:/Windows').then(
                    () => false,
                    () => true
                )
            )
        ).toBe(true);
        await content.focus();
        await page.keyboard.press('Home');
        await expect(
            popup.locator('pre code span span').filter({ hasText: /^function$/ })
        ).toHaveCSS('color', 'rgb(86, 156, 214)');
        await expect
            .poll(
                async () =>
                    await popup
                        .locator('pre code span span')
                        .evaluateAll(
                            (spans) =>
                                new Set(spans.map((span) => getComputedStyle(span).color)).size
                        )
            )
            .toBeGreaterThan(1);
        expect(await page.evaluate(() => 'hoverUnsafe' in window)).toBe(false);
        const signature = popup.locator('pre').first();
        expect(await signature.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
        await page.keyboard.press('l');
        await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await page.keyboard.press('h');
        await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBe(0);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBe(0);
        await page.keyboard.press('j');
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await page.keyboard.press('Home');
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
        for (const [down, up, fraction] of [
            ['d', 'u', 0.5],
            ['f', 'b', 1]
        ] as const) {
            const height = await content.evaluate((node) => node.clientHeight);
            await page.keyboard.press(`Control+${down}`);
            await expect
                .poll(() => content.evaluate((node) => node.scrollTop))
                .toBeCloseTo(height * fraction, 0);
            await page.keyboard.press(`Control+${up}`);
            await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
        }
        await popup.screenshot({ path: 'test-results/nido-type-information.png' });
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Close type information' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(content.getByRole('link', { name: 'Documentation' })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.getByRole('button', { name: 'Close type information' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(popup).toBeHidden();
        await expect(editor).toBeFocused();
        await page.keyboard.press('K');
        await expect(popup.locator('pre')).toContainText('setCursor');
        await page.keyboard.press('Control+c');
        await expect(popup).toBeHidden();
        await expect(editor).toBeFocused();
        await page.keyboard.press('Control+k');
        await expect(popup.locator('pre')).toContainText('setCursor');
        await page.getByRole('button', { name: 'Close type information' }).click();
        await expect(popup).toBeHidden();
        await expect(editor).toBeFocused();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('clicking editor glyphs moves the cursor, including wide text and detached pixel scrolling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-click-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    lines[1] = 'ab日本語xyz';
    lines[29] = '\tΩtarget';
    await writeFile(join(root, 'click.txt'), lines.join('\n'));
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(
            page.getByRole('textbox', { name: 'Neovim input', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('click.txt');
        await expect(
            page.getByRole('button', { name: 'click.txt click.txt', exact: true })
        ).toBeVisible();
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /ab日本語xyz/);
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const ctx = node.getContext('2d')!;
            let row = 0;
            const fill = ctx.fillRect.bind(ctx);
            ctx.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height > 100) row = 0;
                fill(x, y, width, height);
            };
            const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                draw(...args);
                if (args.length !== 5) return;
                const index = row++;
                const y = Number(args[2]) + Number(args[4]) / 2;
                queueMicrotask(() => {
                    const line = node.getAttribute('aria-description')!.split('\n')[index] || '';
                    const wide = line.indexOf('ab日本語');
                    const tab = line.indexOf('Ω');
                    const column = wide >= 0 ? wide + 4 + 1.25 : tab + 0.5;
                    if (wide < 0 && tab < 0) return;
                    node.setAttribute(
                        wide >= 0 ? 'data-wide-point' : 'data-tab-point',
                        JSON.stringify({ x: column * ctx.measureText('M').width, y })
                    );
                });
            }) as typeof draw;
        });
        await canvas.hover();
        await page.mouse.wheel(0, 3);
        await expect(canvas).toHaveAttribute('data-wide-point', /x/);
        const point = JSON.parse((await canvas.getAttribute('data-wide-point'))!);
        const bounds = (await canvas.boundingBox())!;
        await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
        await page.mouse.down();
        try {
            await expect(page.getByText('Ln 2, Col 6', { exact: true })).toBeVisible({
                timeout: 1000
            });
            await expect
                .poll(async () => JSON.parse((await canvas.getAttribute('data-wide-point'))!).y)
                .toBe(point.y);
        } finally {
            await page.mouse.up();
        }
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).uncheck();
        await page.keyboard.press('Escape');
        await canvas.hover();
        await canvas.evaluate((node) => node.removeAttribute('data-tab-point'));
        await page.mouse.wheel(0, 507);
        await expect(canvas).toHaveAttribute('data-tab-point', /x/);
        await expect(page.getByText('Ln 2, Col 6', { exact: true })).toBeVisible();
        const tabPoint = JSON.parse((await canvas.getAttribute('data-tab-point'))!);
        await canvas.click({ position: tabPoint });
        await expect(page.getByText('Ln 30, Col 2', { exact: true })).toBeVisible();
        await expect
            .poll(async () => JSON.parse((await canvas.getAttribute('data-tab-point'))!).y)
            .toBe(tabPoint.y);
        // Separate the next click from Neovim's double-click selection interval.
        await page.waitForTimeout(600);
        await page.keyboard.press('i');
        await canvas.click({
            position: JSON.parse((await canvas.getAttribute('data-tab-point'))!)
        });
        await page.keyboard.type('X');
        await page.keyboard.press('Escape');
        await page.keyboard.type(':w');
        await page.keyboard.press('Enter');
        await expect.poll(() => readFile(join(root, 'click.txt'), 'utf8')).toContain('\tXΩtarget');
    } catch (error) {
        running.process().kill();
        throw error;
    } finally {
        await running.close().catch(() => {});
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('settings can be navigated and changed entirely with the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-settings-keys-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(
            page.getByRole('textbox', { name: 'Neovim input', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Space');
        await page.keyboard.press(',');
        const size = page.getByRole('spinbutton', { name: 'Editor font size' });
        await expect(size).toBeFocused();
        await size.fill('18');
        await expect(size).toHaveValue('18');
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('nido.fontSize')))
            .toBe('18');
        await size.fill('100');
        await page.keyboard.press('Tab');
        await expect(size).toHaveValue('18');
        await size.focus();
        const initial = Number(await size.inputValue());
        await page.keyboard.press('ArrowUp');
        await expect(size).toHaveValue(String(initial + 1));
        await page.keyboard.press('j');
        const family = page.getByRole('textbox', { name: 'Font family' });
        await expect(family).toBeFocused();
        await page.keyboard.press('Control+a');
        await page.keyboard.type('jk monospace');
        await expect(family).toHaveValue('jk monospace');
        await page.keyboard.press('Control+j');
        const explorer = page.getByRole('checkbox', { name: 'Show file explorer' });
        await expect(explorer).toBeFocused();
        await page.keyboard.press('Space');
        await expect(explorer).not.toBeChecked();
        await page.keyboard.press('Enter');
        await expect(explorer).toBeChecked();
        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('checkbox', { name: 'Format on save' })).toBeFocused();
        await page.keyboard.press('k');
        await expect(explorer).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(family).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(size).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.getByRole('button', { name: 'Close palette' })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.getByRole('checkbox', { name: 'Use EditorConfig' })).toBeFocused();
        await page.screenshot({ path: 'test-results/settings-keyboard.png' });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Settings' })).not.toBeVisible();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('smooth cursor movement and blink animate and persist their settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-cursor-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
    let running = await electron.launch(options);
    try {
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
        await expect(editor).toBeFocused();
        await page.keyboard.type('iabcdefghijklmnopqrstuvwxyz');
        await page.keyboard.press('Escape');
        await page.keyboard.type(':w cursor.txt');
        await page.keyboard.press('Enter');
        await expect
            .poll(() => readFile(join(root, 'cursor.txt'), 'utf8').catch(() => ''))
            .toContain('abcdefghijklmnopqrstuvwxyz');
        await page.keyboard.press('Home');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const setting = page.getByRole('checkbox', { name: 'Smooth cursor movement' });
        const blinkSetting = page.getByRole('checkbox', { name: 'Smooth cursor blink' });
        const clipboardSetting = page.getByRole('checkbox', { name: 'Share system clipboard' });
        await expect(clipboardSetting).not.toBeChecked();
        await clipboardSetting.check();
        await expect(blinkSetting).not.toBeChecked();
        await expect(setting).not.toBeChecked();
        await setting.check();
        await page.getByRole('checkbox', { name: 'UI animations', exact: true }).uncheck();
        await page.getByRole('button', { name: 'Close palette' }).click();
        await expect(editor).toBeFocused();
        const canvas = page.locator('canvas:visible');
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const ctx = node.getContext('2d')!;
            const fill = ctx.fillRect.bind(ctx);
            node.dataset.cursorXs = '[]';
            node.dataset.cursorAlphas = '[]';
            node.dataset.cursorYs = '[]';
            ctx.fillRect = (x, y, w, h) => {
                if (ctx.fillStyle === '#f5f5f5') {
                    const xs = JSON.parse(node.dataset.cursorXs!) as number[];
                    node.dataset.cursorXs = JSON.stringify([...xs.slice(-99), x]);
                    const ys = JSON.parse(node.dataset.cursorYs!) as number[];
                    node.dataset.cursorYs = JSON.stringify([...ys.slice(-99), y]);
                    const alphas = JSON.parse(node.dataset.cursorAlphas!) as number[];
                    node.dataset.cursorAlphas = JSON.stringify([
                        ...alphas.slice(-99),
                        ctx.globalAlpha
                    ]);
                }
                fill(x, y, w, h);
            };
        });
        const move = async (keys: string): Promise<number[]> => {
            const before = await editor.evaluate((node) => node.style.left);
            await canvas.evaluate((node: HTMLCanvasElement) => {
                node.dataset.cursorXs = '[]';
            });
            await page.keyboard.type(keys);
            await expect.poll(() => editor.evaluate((node) => node.style.left)).not.toBe(before);
            await expect
                .poll(async () => {
                    const xs = JSON.parse(
                        (await canvas.getAttribute('data-cursor-xs'))!
                    ) as number[];
                    const target = await editor.evaluate((node) => parseFloat(node.style.left));
                    return Math.abs((xs.at(-1) ?? -1000) - target);
                })
                .toBeLessThan(0.01);
            return JSON.parse((await canvas.getAttribute('data-cursor-xs'))!);
        };
        expect(new Set((await move('10l')).map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
        const previous = await editor.evaluate((node) => parseFloat(node.style.left));
        const clickPoint = await canvas.evaluate((node: HTMLCanvasElement) => {
            node.dataset.cursorXs = '[]';
            const input = document.querySelector<HTMLTextAreaElement>(
                '[aria-label="Neovim input"]'
            )!;
            return {
                x:
                    parseFloat(input.style.left) +
                    node.getContext('2d')!.measureText('M').width * 8.5,
                y: parseFloat(input.style.top) + 8
            };
        });
        const bounds = (await canvas.boundingBox())!;
        await page.mouse.move(bounds.x + clickPoint.x, bounds.y + clickPoint.y);
        await page.mouse.down();
        try {
            await expect
                .poll(() => editor.evaluate((node) => parseFloat(node.style.left)))
                .not.toBe(previous);
            await expect
                .poll(async () => {
                    const xs = JSON.parse(
                        (await canvas.getAttribute('data-cursor-xs'))!
                    ) as number[];
                    const target = await editor.evaluate((node) => parseFloat(node.style.left));
                    return Math.abs((xs.at(-1) ?? -1000) - target);
                })
                .toBeLessThan(0.01);
            const xs = JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[];
            expect(new Set(xs.map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
        } finally {
            await page.mouse.up();
        }
        expect(new Set((await move('10h')).map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
        await canvas.evaluate((node: HTMLCanvasElement) => {
            node.dataset.cursorXs = '[]';
            node.dataset.cursorYs = '[]';
        });
        await page.keyboard.press('Control+s');
        await page.waitForTimeout(200);
        expect(
            new Set(JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[]).size
        ).toBeLessThanOrEqual(1);
        expect(
            new Set(JSON.parse((await canvas.getAttribute('data-cursor-ys'))!) as number[]).size
        ).toBeLessThanOrEqual(1);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(new Set((await move('10h')).map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await setting.uncheck();
        await page.getByRole('button', { name: 'Close palette' }).click();
        expect(new Set((await move('10l')).map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
        await canvas.evaluate((node) => {
            node.dataset.cursorXs = '[]';
        });
        await canvas.click({ position: clickPoint });
        await expect
            .poll(() => editor.evaluate((node) => parseFloat(node.style.left)))
            .not.toBe(previous);
        const clickXs = JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[];
        expect(new Set(clickXs.map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
        const hasFade = async (): Promise<boolean> => {
            const alphas = JSON.parse(
                (await canvas.getAttribute('data-cursor-alphas'))!
            ) as number[];
            return alphas.some((alpha) => alpha > 0.01 && alpha < 0.54);
        };
        await page.waitForTimeout(1200);
        expect(await hasFade()).toBe(false);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await setting.check();
        await blinkSetting.check();
        await page.getByRole('button', { name: 'Close palette' }).click();
        await expect.poll(hasFade).toBe(true);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await canvas.evaluate((node: HTMLCanvasElement) => {
            node.dataset.cursorAlphas = '[]';
        });
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(1200);
        expect(await hasFade()).toBe(false);
        await expect
            .poll(async () => JSON.parse((await canvas.getAttribute('data-cursor-alphas'))!).length)
            .toBeGreaterThan(0);
        await running.close();
        running = await electron.launch(options);
        page = await running.firstWindow();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Smooth cursor movement' })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Smooth cursor blink' })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Share system clipboard' })).toBeChecked();
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('window size and maximized state survive restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-window-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const options = {
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
        env
    };
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        running = await electron.launch(options);
        await running.firstWindow();
        await running.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1040, 680)
        );
        const originalSize = await running.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getSize()
        );
        await running.close();
        running = await electron.launch(options);
        await running.firstWindow();
        await expect
            .poll(() =>
                running!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
            )
            .toEqual(originalSize);
        await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
        await expect
            .poll(() =>
                running!.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].isMaximized()
                )
            )
            .toBe(true);
        await running.close();
        running = await electron.launch(options);
        await running.firstWindow();
        await expect
            .poll(() =>
                running!.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].isMaximized()
                )
            )
            .toBe(true);
        await running.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].unmaximize()
        );
        await expect
            .poll(() =>
                running!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
            )
            .toEqual(originalSize);
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Git changes can be reviewed, staged and committed with the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-git-ui-'));
    const repository = join(root, 'repo');
    await mkdir(repository);
    const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
    git('init');
    git('config', 'user.name', 'Nido Test');
    git('config', 'user.email', 'nido-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(
        join(repository, 'main.rs'),
        'fn main() {}\n' +
            Array.from({ length: 150 }, (_, i) => `// ${i} ${'long diff line '.repeat(20)}\n`).join(
                ''
            )
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const page = await running.firstWindow();
        async function checkDiffKeys(label: string, listLabel: string): Promise<void> {
            const preview = page.getByLabel(label, { exact: true });
            await page.keyboard.press('Control+l');
            await expect(preview).toBeFocused();
            const top = (): Promise<number> => preview.evaluate((node) => node.scrollTop);
            const original = page.getByLabel(`${label} original`, { exact: true });
            await page.keyboard.press('g');
            await page.keyboard.press('j');
            await expect.poll(top).toBeGreaterThan(0);
            await page.keyboard.press('k');
            await expect.poll(top).toBe(0);
            for (const [down, up] of [
                ['Control+d', 'Control+u'],
                ['Control+f', 'Control+b']
            ]) {
                await page.keyboard.press(down);
                await expect.poll(top).toBeGreaterThan(100);
                await page.keyboard.press(up);
                await expect.poll(top).toBeLessThan(1);
            }
            await page.keyboard.press('Shift+g');
            await expect.poll(top).toBeGreaterThan(1000);
            await expect
                .poll(async () =>
                    Math.abs((await top()) - (await original.evaluate((node) => node.scrollTop)))
                )
                .toBeLessThanOrEqual(1);
            await page.keyboard.press('g');
            await expect.poll(top).toBe(0);
            await page.keyboard.press('l');
            await expect.poll(() => preview.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
            await page.keyboard.press('h');
            await expect.poll(() => preview.evaluate((node) => node.scrollLeft)).toBe(0);
            await page.keyboard.press('Control+h');
            await expect(page.getByRole('listbox', { name: listLabel })).toBeFocused();
        }
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, repository);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        const explorer = page.getByRole('complementary', { name: 'File explorer' });
        await expect(explorer.getByLabel('Git: Untracked', { exact: true })).toHaveText('U');
        await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS(
            'color',
            'rgb(159, 198, 142)'
        );
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
        await page.keyboard.press('Enter');
        const fileTabs = page.getByRole('tablist', { name: 'Files', exact: true });
        await expect(fileTabs.getByLabel('Git: Untracked', { exact: true })).toHaveText('U');
        await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS(
            'color',
            'rgb(159, 198, 142)'
        );
        const gitButton = page.getByRole('button', { name: 'Source control', exact: true });
        await gitButton.click();
        const panel = page.getByRole('region', { name: 'Git changes' });
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await gitButton.focus();
        await expect(gitButton).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'git palette' })).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+Shift+g');
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
        await expect(page.getByLabel('Git diff', { exact: true })).toContainText('fn main() {}');
        await expect(panel.getByText('Before', { exact: true })).toBeVisible();
        await expect(panel.getByText('After', { exact: true })).toBeVisible();
        await expect(
            page.getByLabel('Git diff', { exact: true }).locator('code span').first()
        ).toBeVisible();
        const dialog = page.getByRole('dialog', { name: 'git palette' });
        const bounds = await dialog.boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(bounds!.width).toBeGreaterThan(viewport.width * 0.75);
        expect(bounds!.width).toBeLessThan(viewport.width * 0.95);
        expect(bounds!.height).toBeGreaterThan(viewport.height * 0.6);
        expect(bounds!.height).toBeLessThan(viewport.height * 0.85);
        const original = page.getByLabel('Git diff original', { exact: true });
        const updated = page.getByLabel('Git diff', { exact: true });
        expect((await original.boundingBox())!.x).toBeLessThan((await updated.boundingBox())!.x);
        await checkDiffKeys('Git diff', 'Changed files');
        await page.keyboard.press('s');
        await expect(page.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
        await expect(fileTabs.getByLabel('Git: Added (staged)', { exact: true })).toHaveText('A');
        await expect(explorer.getByLabel('Git: Added (staged)', { exact: true })).toHaveText('A');
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('u');
        await expect(page.getByRole('heading', { name: 'Staged changes' })).toHaveCount(0);
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('s');
        await expect(panel.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.screenshot({ path: 'test-results/nido-git.png' });
        await page.keyboard.press('c');
        await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeFocused();
        await page.keyboard.type('First commit');
        await page.keyboard.press('Control+Enter');
        await expect(panel.getByText('Working tree clean.')).toBeVisible();
        await expect(fileTabs.locator('[data-status]')).toHaveCount(0);
        await expect(explorer.locator('[data-status]')).toHaveCount(0);
        expect(git('log', '-1', '--format=%s').trim()).toBe('First commit');
        const originalBranch = git('branch', '--show-current').trim();
        await writeFile(join(repository, 'notes.txt'), 'extra file\n');
        git('add', 'notes.txt');
        git('commit', '--amend', '--no-edit');
        await page.keyboard.press('Tab');
        await page.keyboard.press('2');
        const browser = page.getByRole('region', { name: 'Git browser' });
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByRole('listbox', { name: 'Commit history' })).toBeFocused();
        await expect(page.getByRole('option', { name: /First commit/ })).toBeVisible();
        const details = page.getByRole('region', { name: 'Commit details' });
        await expect(details.getByRole('heading', { name: 'First commit' })).toBeVisible();
        await expect(details.locator('code')).toHaveText(git('rev-parse', 'HEAD').trim());
        await page.keyboard.press('Control+l');
        await expect(details).toBeFocused();
        await page.screenshot({ path: 'test-results/nido-commit-details.png' });
        await page.keyboard.press('Control+h');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('listbox', { name: 'Commit files' })).toBeVisible();
        await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('fn main() {}');
        await expect(
            page.getByLabel('Commit diff', { exact: true }).locator('code span').first()
        ).toBeVisible();
        await checkDiffKeys('Commit diff', 'Commit files');
        await page.keyboard.press('Control+l');
        await page.keyboard.press('n');
        await expect(browser.getByText('Change 1 / 1 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('Shift+n');
        await expect(browser.getByText('Change 1 / 1 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('Control+h');
        await page.keyboard.press('j');
        await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('extra file');
        await page.keyboard.press('k');
        await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('fn main() {}');
        await page.screenshot({ path: 'test-results/nido-git-history.png' });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('listbox', { name: 'Commit history' })).toBeFocused();
        const source = await readFile(join(repository, 'main.rs'), 'utf8');
        await writeFile(
            join(repository, 'main.rs'),
            source
                .replace('fn main() {}', 'fn main() { println!("Nido"); }')
                .replace('// 70 ', '// updated 70 ')
                .replace('// 140 ', '// updated 140 ')
        );
        await page.keyboard.press('1');
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByLabel('Git diff original', { exact: true })).toContainText(
            'fn main() {}'
        );
        await expect(page.getByLabel('Git diff', { exact: true })).toContainText(
            'fn main() { println!("Nido"); }'
        );
        await expect(page.getByLabel('Git diff original', { exact: true })).toContainText('// 149');
        await expect(page.getByLabel('Git diff', { exact: true })).toContainText('// 149');
        for (const label of ['Git diff original', 'Git diff']) {
            const code = page.getByLabel(label, { exact: true }).locator('code').first();
            await expect(code.locator('span').first()).toHaveText('fn');
            await expect
                .poll(() =>
                    code
                        .locator('span')
                        .evaluateAll(
                            (spans) =>
                                new Set(spans.map((span) => getComputedStyle(span).color)).size
                        )
                )
                .toBeGreaterThan(1);
        }
        await checkDiffKeys('Git diff', 'Changed files');
        await page.keyboard.press('Control+l');
        await page.keyboard.press('n');
        await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
        await expect.poll(() => updated.evaluate((node) => node.scrollTop)).toBeLessThan(1);
        await page.keyboard.press('n');
        await expect(panel.getByText('Change 2 / 3 · n / N', { exact: true })).toBeVisible();
        await expect.poll(() => updated.evaluate((node) => node.scrollTop)).toBeGreaterThan(1000);
        await expect
            .poll(() =>
                page
                    .getByLabel('Git diff original', { exact: true })
                    .evaluate((node) => node.scrollTop)
            )
            .toBeGreaterThan(1000);
        await page.keyboard.press('n');
        await expect(panel.getByText('Change 3 / 3 · n / N', { exact: true })).toBeVisible();
        await page.getByLabel('Git diff original', { exact: true }).focus();
        await page.keyboard.press('Shift+n');
        await expect(panel.getByText('Change 2 / 3 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('Shift+n');
        await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('Shift+n');
        await expect(panel.getByText('Change 3 / 3 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('n');
        await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
        await page.keyboard.press('Control+h');
        await page.screenshot({ path: 'test-results/nido-git-side-by-side.png' });
        await page.keyboard.press('3');
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByRole('listbox', { name: 'Branches' })).toBeFocused();
        const branchDetails = page.getByRole('region', { name: 'Branch details' });
        await expect(
            branchDetails.getByRole('heading', { name: originalBranch, exact: true })
        ).toBeVisible();
        await expect(branchDetails.getByText('Currently checked out')).toBeVisible();
        await page.keyboard.press('Control+l');
        await expect(branchDetails).toBeFocused();
        await page.screenshot({ path: 'test-results/nido-branch-details.png' });
        await page.keyboard.press('Control+h');
        await page.keyboard.press('n');
        await expect(page.getByRole('textbox', { name: 'New branch name' })).toBeFocused();
        await page.keyboard.type('feature-123');
        await page.keyboard.press('Enter');
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        await expect(browser.locator('strong').first()).toHaveText('feature-123');
        expect(git('branch', '--show-current').trim()).toBe('feature-123');
        await expect(page.getByRole('listbox', { name: 'Branches' })).toBeFocused();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        expect(git('branch', '--show-current').trim()).toBe(originalBranch);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Space');
        await page.keyboard.press('g');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('c');
        await page.keyboard.type('Draft 123');
        await page.keyboard.press('Tab');
        await page.keyboard.press('2');
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('1');
        await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
            'Draft 123'
        );
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('i');
        await page.keyboard.type('unsaved');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Shift+g');
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('3');
        await expect(browser).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('Home');
        await page.keyboard.press('Enter');
        await expect(browser.getByRole('alert')).toContainText('Save unsaved editor changes');
        expect(git('branch', '--show-current').trim()).toBe(originalBranch);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(join(repository, 'main.rs'), 'utf8')).toContain('unsaved');
        await expect(fileTabs.getByLabel('Git: Modified', { exact: true })).toHaveText('M');
        await expect(explorer.getByLabel('Git: Modified', { exact: true })).toHaveText('M');
        await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS(
            'color',
            'rgb(217, 183, 119)'
        );
        await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS(
            'color',
            'rgb(217, 183, 119)'
        );
        await expect(fileTabs.getByLabel('Unsaved', { exact: true })).toHaveCount(0);
        await page.screenshot({ path: 'test-results/nido-git-tab-status.png' });
        git('add', 'main.rs');
        await expect(fileTabs.getByLabel('Git: Modified (staged)', { exact: true })).toHaveText(
            'M'
        );
        git('commit', '-m', 'External commit');
        await expect(fileTabs.locator('[data-status]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        for (const [severity, label, color] of [
            [1, 'error', 'rgb(229, 155, 150)'],
            [2, 'warning', 'rgb(217, 183, 119)']
        ] as const) {
            await page.keyboard.type(
                `:lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=0,col=0,severity=${severity},message='Test diagnostic'}})`
            );
            await page.keyboard.press('Enter');
            await expect(fileTabs.getByLabel(`1 ${label}`, { exact: true })).toBeVisible();
            await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS('color', color);
            await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS('color', color);
        }
        await page.keyboard.type(
            ":lua vim.diagnostic.reset(vim.api.nvim_create_namespace('nido-test'))"
        );
        await page.keyboard.press('Enter');
        await expect(fileTabs.locator('[data-diagnostic]')).toHaveCount(0);
        await expect(explorer.locator('[data-diagnostic]')).toHaveCount(0);
    } finally {
        await running?.evaluate(({ app }) => app.exit(0));
        await running?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('Problems can be selected, filtered, opened and cleared with the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-problems-'));
    await writeFile(
        join(root, 'sample.txt'),
        'first line\nsecond line\nthird line\nfourth line\nfifth line\n'
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    const running = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + join(root, 'profile')],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('treeitem', { name: 'sample.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.txt');
        await expect(page.getByRole('button', { name: /sample.txt/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.type(
            ":lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=2,col=1,severity=2,message='Sample warning'}, {lnum=4,col=2,severity=1,message='Sample error'}})"
        );
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+Shift+m');
        const problems = page.getByRole('listbox', { name: 'Problems', exact: true });
        await expect(problems).toBeFocused();
        await expect(problems.getByRole('option')).toHaveCount(2);
        await expect(problems.getByRole('option').first()).toContainText('Sample error');
        await page.keyboard.press('j');
        await expect(problems.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Enter');
        await expect(page.getByText('Ln 3, Col 2', { exact: true })).toBeVisible();
        await page.keyboard.press('Control+Shift+m');
        await page.keyboard.press('/');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('Sample error');
        await expect(problems.getByRole('option')).toHaveCount(1);
        await page.keyboard.press('Enter');
        await expect(page.getByText('Ln 5, Col 3', { exact: true })).toBeVisible();
        await page.keyboard.type(
            ":lua vim.diagnostic.reset(vim.api.nvim_create_namespace('nido-test'))"
        );
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+Shift+m');
        await expect(page.getByText('No problems reported.')).toBeVisible();
        await page.keyboard.press('Control+Shift+m');
        await expect(problems).toHaveCount(0);
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

async function chooseWorkspace(page: Page, path: string, navigate = false): Promise<void> {
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.getByRole('textbox', { name: 'Folder path' }).fill(path);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    if (navigate) {
        await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
        await page.keyboard.press('j');
        await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
            'aria-activedescendant',
            'folder-choice-1'
        );
        await page.keyboard.press('k');
        await page.keyboard.press('l');
        await expect(page.getByRole('textbox', { name: 'Folder path' })).not.toHaveValue(path);
        await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
            'aria-busy',
            'false'
        );
        await page.keyboard.press('h');
        await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveValue(path);
        await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
            'aria-busy',
            'false'
        );
        await page.screenshot({ path: 'test-results/nido-folder-picker.png' });
    }
    await page.keyboard.press('Control+Enter');
}

test('terminal toggle, focus, background execution and standalone terminal sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-terminal-ui-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+@');
        const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
        await expect(terminal).toBeVisible();
        const explorerBounds = await page
            .getByRole('complementary', { name: 'File explorer' })
            .boundingBox();
        const terminalBounds = await terminal.boundingBox();
        assert.ok(explorerBounds && terminalBounds);
        assert.ok(terminalBounds.x >= explorerBounds.x + explorerBounds.width);
        assert.ok(
            explorerBounds.y + explorerBounds.height >= terminalBounds.y + terminalBounds.height - 1
        );
        await expect(page.getByRole('contentinfo').locator(':scope > :first-child')).toHaveText(
            'NORMAL'
        );
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await page.keyboard.type(
            "$nidoValue = 'alive'; Start-Sleep -Milliseconds 500; Set-Content background.txt $nidoValue"
        );
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+@');
        await expect(terminal).toBeHidden();
        await expect
            .poll(async () => readFile(join(root, 'background.txt'), 'utf8').catch(() => ''))
            .toContain('alive');
        await page.keyboard.press('Control+j');
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await page.keyboard.press('Control+k');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+j');
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await page.keyboard.type('Set-Content preserved.txt $nidoValue');
        await page.keyboard.press('Enter');
        await expect
            .poll(async () => readFile(join(root, 'preserved.txt'), 'utf8').catch(() => ''))
            .toContain('alive');
        await page.keyboard.press('Control+Shift+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('Open debug panel');
        await page.keyboard.press('Enter');
        const debuggerPanel = page.getByRole('region', { name: 'Debugger', exact: true });
        await expect(debuggerPanel).toBeVisible();
        await expect(debuggerPanel).toContainText('Debug · idle');
        await expect
            .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
            .toBe(true);
        await expect(terminal).toBeHidden();
        await page.keyboard.press('Control+@');
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await page.keyboard.press('Control+@');
        await expect(terminal).toBeHidden();
        await page.keyboard.press('Space');
        await expect(
            page
                .getByRole('dialog', { name: 'Keyboard commands' })
                .getByRole('button', { name: 'Shift+D Open debug panel' })
        ).toBeVisible();
        await page
            .getByRole('dialog', { name: 'Keyboard commands' })
            .screenshot({ path: 'test-results/nido-keyboard-commands.png' });
        await page.keyboard.press('D');
        await expect(debuggerPanel).toBeVisible();
        await expect
            .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
            .toBe(true);
        await page.keyboard.press('Control+@');
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await expect(terminal.getByRole('button', { name: /Restart shell/ })).toHaveCSS(
            'font-size',
            '12px'
        );
        await page.keyboard.press('Control+Shift+r');
        await page.keyboard.type('Set-Content restarted.txt ([string]::IsNullOrEmpty($nidoValue))');
        await page.keyboard.press('Enter');
        await expect
            .poll(async () => readFile(join(root, 'restarted.txt'), 'utf8').catch(() => ''))
            .toContain('True')
            .catch(async (error) => {
                await page.screenshot({ path: 'test-results/restart-failure.png' });
                throw error;
            });
        await page.screenshot({ path: 'test-results/nido-terminal.png' });
        await page.keyboard.press('Control+Shift+n');
        await expect(page.getByRole('combobox', { name: 'Session type' })).toBeVisible();
        await page.getByRole('combobox', { name: 'Session type' }).focus();
        await page.keyboard.press('End');
        await chooseWorkspace(page, root);
        const input = page.getByRole('textbox', { name: 'Terminal input' });
        await expect(input).toHaveCount(1);
        await expect(input).toBeFocused();
        await page.keyboard.type("Set-Content standalone.txt 'separate'");
        await page.keyboard.press('Enter');
        await expect
            .poll(async () => readFile(join(root, 'standalone.txt'), 'utf8').catch(() => ''))
            .toContain('separate');
        await page.keyboard.press('Control+Tab');
        await page.keyboard.press('Control+j');
        await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        const closed = running.waitForEvent('close');
        await page.evaluate(() => {
            void window.nido.windowAction('close');
        });
        await closed;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const restored = await running.firstWindow();
        await expect(restored.getByRole('tab', { name: /^Workspace / })).toHaveCount(2, {
            timeout: 15000
        });
        await restored.keyboard.press('Alt+2');
        await expect(restored.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
        await restored.keyboard.type("Set-Content restored.txt 'restored'");
        await restored.keyboard.press('Enter');
        await expect
            .poll(async () => readFile(join(root, 'restored.txt'), 'utf8').catch(() => ''))
            .toContain('restored');
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('line deletion slides remaining rows upward only when animations are enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-delete-motion-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await writeFile(
        join(root, 'lines.txt'),
        Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
    );
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await expect(page.getByRole('treeitem', { name: 'lines.txt', exact: true })).toBeVisible();
        await page.keyboard.type(':edit lines.txt');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /line 10\s/);
        await page.keyboard.press('Escape');
        await canvas.evaluate((surface) => {
            const context = (surface as HTMLCanvasElement).getContext('2d')!;
            const draw = context.drawImage.bind(context);
            context.drawImage = ((...args: Parameters<typeof draw>) => {
                surface.setAttribute(
                    'data-motion-frames',
                    String(Number(surface.getAttribute('data-motion-frames')) + 1)
                );
                const offsets = JSON.parse(
                    surface.getAttribute('data-motion-offsets') || '[]'
                ) as number[];
                offsets.push(Number(args[6]) - Number(args[2]) / window.devicePixelRatio);
                surface.setAttribute('data-motion-offsets', JSON.stringify(offsets));
                draw(...args);
            }) as typeof draw;
        });
        for (const command of ['10Gdd', 'uggdd']) {
            const before = Number(await canvas.getAttribute('data-motion-frames'));
            await canvas.evaluate((node) => node.removeAttribute('data-motion-offsets'));
            await page.keyboard.type(command);
            await expect(canvas).not.toHaveAttribute(
                'aria-description',
                command === '10Gdd' ? /line 10\s/ : /line 1\s/
            );
            await page.waitForTimeout(150);
            expect(Number(await canvas.getAttribute('data-motion-frames'))).toBeGreaterThan(before);
            const offsets = JSON.parse(
                (await canvas.getAttribute('data-motion-offsets'))!
            ) as number[];
            expect(offsets.every((offset) => offset >= 0)).toBe(true);
            expect(offsets.at(-1)!).toBeLessThan(offsets[0]);
        }
        const beforeUndo = Number(await canvas.getAttribute('data-motion-frames'));
        await page.keyboard.type('u');
        await expect(canvas).toHaveAttribute('aria-description', /line 1\s/);
        await page.waitForTimeout(150);
        expect(Number(await canvas.getAttribute('data-motion-frames'))).toBe(beforeUndo);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'UI animations', exact: true }).uncheck();
        await page.keyboard.press('Escape');
        await page.keyboard.type('dd');
        await expect(canvas).not.toHaveAttribute('aria-description', /line 1\s/);
        await page.waitForTimeout(150);
        expect(Number(await canvas.getAttribute('data-motion-frames'))).toBe(beforeUndo);
        await page.keyboard.type('u');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'UI animations', exact: true }).check();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+d');
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-motion-frames')))
            .toBeGreaterThan(0);
        await page.waitForTimeout(150);
        const frames = Number(await canvas.getAttribute('data-motion-frames'));
        await page.keyboard.type('G');
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-motion-frames')))
            .toBeGreaterThan(frames);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('viewport movement uses pixel wheel deltas and animates keyboard scrolling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-motion-'));
    const content = Array.from(
        { length: 200 },
        (_, index) => `line ${index + 1} ${'text '.repeat(60)}`
    ).join('\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        await writeFile(join(root, 'scroll.txt'), content);
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const page = await running.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('treeitem', { name: 'scroll.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('scroll.txt');
        await expect(page.getByRole('button', { name: /scroll.txt/ })).toBeVisible();
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /line 1 /);
        await expect(page.getByLabel('File position 0%', { exact: true })).toBeVisible();
        await page.keyboard.type(':set nowrap');
        await page.keyboard.press('Enter');
        await expect(canvas).toHaveAttribute('aria-description', /line 20/);
        await canvas.evaluate((surface) => {
            const context = (surface as HTMLCanvasElement).getContext('2d')!;
            let row = 0;
            const fill = context.fillRect.bind(context);
            context.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height > 100) row = 0;
                fill(x, y, width, height);
            };
            const draw = context.drawImage.bind(context);
            context.drawImage = ((...args: Parameters<typeof draw>) => {
                if (args.length === 5 && row++ === 0) {
                    const fontSize = Number(context.font.match(/([\d.]+)px/)![1]);
                    surface.setAttribute(
                        'data-first-line-y',
                        String(Number(args[2]) + (Number(args[4]) + fontSize) / 2 - 3)
                    );
                }
                if (args.length === 9)
                    surface.setAttribute(
                        'data-animation-frames',
                        String(Number(surface.getAttribute('data-animation-frames') || 0) + 1)
                    );
                draw(...args);
            }) as typeof draw;
        });
        await canvas.hover();
        await page.mouse.wheel(0, 3);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-line-y')))
            .toBeGreaterThan(0);
        const firstY = Number(await canvas.getAttribute('data-first-line-y'));
        await page.waitForTimeout(300);
        await page.mouse.wheel(0, 2);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-line-y')))
            .toBeCloseTo(firstY - 2, 1);
        await page.screenshot({ path: 'test-results/pixel-scroll.png' });
        await page.mouse.wheel(0, -2);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-line-y')))
            .toBeCloseTo(firstY, 1);
        await page.mouse.wheel(0, -100);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-line-y')))
            .toBeCloseTo(firstY + 3, 1);
        await page.mouse.wheel(0, 100);
        await expect(canvas).not.toHaveAttribute('aria-description', /^.*line 1 /);
        await page.waitForTimeout(250);
        let frames = await canvas.getAttribute('data-animation-frames');
        await page.waitForTimeout(150);
        expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Smooth cursor movement' }).check();
        await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).uncheck();
        await page.keyboard.press('Escape');
        await page.keyboard.type('20Gzz');
        await page.waitForTimeout(200);
        await expect(page.locator('[aria-label^="File position "]')).toHaveAttribute(
            'aria-label',
            /File position [1-9]\d*%/
        );
        expect(await canvas.getAttribute('aria-description')).not.toContain(
            join(root, 'scroll.txt')
        );
        const center = await canvas.evaluate((node) => {
            const input = document.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="Neovim input"]'
            )!;
            const rows = node.getAttribute('aria-description')!.split('\n').length;
            return { actual: parseFloat(input.style.top) + 12.5, expected: ((rows - 2) * 25) / 2 };
        });
        expect(center.actual).toBeCloseTo(center.expected, 1);
        await page.keyboard.type('gg');
        await expect
            .poll(() =>
                page
                    .locator('textarea[aria-label="Neovim input"]')
                    .evaluate((input) => parseFloat(input.style.top))
            )
            .toBe(0);
        await page.keyboard.type('20Gzz');
        await page.waitForTimeout(200);
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const ctx = node.getContext('2d')!;
            const fill = ctx.fillRect.bind(ctx);
            let expected: number | undefined;
            let anchorRow: number | undefined;
            let firstRow = true;
            const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                if (firstRow && args.length === 5) {
                    expected =
                        anchorRow === undefined ? undefined : anchorRow * 25 + 1 + Number(args[2]);
                    firstRow = false;
                }
                draw(...args);
            }) as typeof draw;
            node.dataset.cursorErrors = '[]';
            window.nido.onEvent((event) => {
                if (event.type !== 'redraw') return;
                for (const [name, ...calls] of event.events) {
                    if (name !== 'nido_pixel_scroll') continue;
                    for (const [, direct, cursor] of calls) {
                        const anchor = cursor as { row: number } | undefined;
                        anchorRow = direct && anchor ? anchor.row : undefined;
                    }
                }
            });
            ctx.fillRect = (x, y, w, h) => {
                if (x === 0 && y === 0 && h > 100) firstRow = true;
                if (ctx.fillStyle === '#f5f5f5' && expected !== undefined && expected > 0) {
                    const actual = y + ctx.getTransform().f / window.devicePixelRatio;
                    const errors = JSON.parse(node.dataset.cursorErrors!) as number[];
                    if (Math.abs(actual - expected) > 0.01) errors.push(actual - expected);
                    node.dataset.cursorErrors = JSON.stringify(errors);
                    node.dataset.checkedCursor = 'true';
                }
                fill(x, y, w, h);
            };
        });
        await canvas.hover();
        for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 3.1);
        await expect(canvas).toHaveAttribute('data-checked-cursor', 'true');
        await page.waitForTimeout(150);
        expect(await canvas.getAttribute('data-cursor-errors')).toBe('[]');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).check();
        await page.keyboard.press('Escape');
        frames = await canvas.getAttribute('data-animation-frames');
        for (const key of [
            'Control+d',
            'Control+u',
            'Control+e',
            'Control+y',
            'Control+f',
            'Control+b'
        ]) {
            await page.keyboard.press(key);
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-animation-frames')), {
                    message: key
                })
                .toBeGreaterThan(Number(frames));
            await page.waitForTimeout(150);
            frames = await canvas.getAttribute('data-animation-frames');
        }
        for (const command of ['G', 'gg', '100G', 'zt', 'zb', 'zz', '/line 150\n', 'zL', 'zH']) {
            if (command.endsWith('\n')) {
                await page.keyboard.type(command.slice(0, -1), { delay: 20 });
                await page.keyboard.press('Enter');
                await expect(canvas).toHaveAttribute('aria-description', /line 150 /);
            } else {
                await page.keyboard.type(command);
            }
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-animation-frames')), {
                    message: command
                })
                .toBeGreaterThan(Number(frames));
            await page.waitForTimeout(150);
            frames = await canvas.getAttribute('data-animation-frames');
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const before = await canvas.getAttribute('aria-description');
        await page.mouse.wheel(0, 100);
        await expect(canvas).not.toHaveAttribute('aria-description', before!);
        expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
        expect(await readFile(join(root, 'scroll.txt'), 'utf8')).toBe(content);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const toggle = page.getByRole('checkbox', { name: 'UI animations' });
        await expect(toggle).toBeChecked();
        await toggle.uncheck();
        await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS(
            'animation-name',
            'none'
        );
        await page.keyboard.press('Escape');
        const beforeDisabledScroll = await canvas.getAttribute('aria-description');
        await canvas.hover();
        await page.mouse.wheel(0, 100);
        await expect(canvas).not.toHaveAttribute('aria-description', beforeDisabledScroll!);
        expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
        for (const key of ['Control+d', 'Control+u', 'Control+f', 'Control+b']) {
            const beforeKey = await canvas.getAttribute('aria-description');
            await page.keyboard.press(key);
            await expect(canvas).not.toHaveAttribute('aria-description', beforeKey!);
            expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
        }
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await toggle.check();
        await page.keyboard.press('Escape');
        await canvas.hover();
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(200);
        expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await toggle.uncheck();
        const cursorFollow = page.getByRole('checkbox', { name: 'Cursor follows scrolling' });
        await expect(cursorFollow).toBeChecked();
        await cursorFollow.uncheck();
        await page.keyboard.press('Escape');
        await page.keyboard.type('20G0');
        await expect(page.getByText('Ln 20, Col 1', { exact: true })).toBeVisible();
        const anchoredView = await canvas.getAttribute('aria-description');
        await canvas.hover();
        await page.mouse.wheel(0, 1500);
        await expect(canvas).not.toHaveAttribute('aria-description', anchoredView!);
        await expect(page.getByText('Ln 20, Col 1', { exact: true })).toBeVisible();
        await page.keyboard.press('ArrowRight');
        await expect(page.getByText('Ln 20, Col 2', { exact: true })).toBeVisible();
        await expect(canvas).toHaveAttribute('aria-description', /line 20 /);
        await running.close();
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const restoredPage = await running.firstWindow();
        await restoredPage.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(
            restoredPage.getByRole('checkbox', { name: 'UI animations' })
        ).not.toBeChecked();
        await expect(
            restoredPage.getByRole('checkbox', { name: 'Cursor follows scrolling' })
        ).not.toBeChecked();
        expect(errors).toEqual([]);
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('references stay accessible after jumping and can be closed with the keyboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-references-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        await mkdir(join(root, 'src'));
        await writeFile(
            join(root, 'Cargo.toml'),
            '[package]\nname="nido_references"\nversion="0.1.0"\nedition="2021"\n'
        );
        await writeFile(
            join(root, 'src/main.rs'),
            'fn greet() -> u32 { 42 }\nfn main() {\n    let answer = greet();\n    println!("{answer}");\n}\n'
        );
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
        await expect(page.getByRole('button', { name: /main.rs/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(async () => {
            await page.keyboard.press('Control+k');
            await page.keyboard.type('gg0wgr');
            await expect(
                page.getByRole('listbox', { name: 'Reference results' }).getByRole('option')
            ).toHaveCount(2, {
                timeout: 1000
            });
        }).toPass({ timeout: 30000 });
        const list = page.getByRole('listbox', { name: 'Reference results' });
        await expect(list).toBeFocused();
        const preview = page.getByRole('region', { name: 'Reference preview', exact: true });
        await expect(preview).toContainText('fn main()');
        await expect(preview.locator('[data-current="true"]')).toContainText('fn greet()');
        await page.keyboard.press('j');
        await expect(preview.locator('[data-current="true"]')).toContainText('let answer');
        await expect(
            page
                .getByRole('listbox', { name: 'Reference results' })
                .getByRole('option', { selected: true })
        ).toContainText('let answer');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await expect(preview).toBeHidden();
        await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
        await page.keyboard.press('Control+j');
        await expect(list).toBeFocused();
        await expect(preview).toContainText('println!');
        await expect(
            page
                .getByRole('listbox', { name: 'Reference results' })
                .getByRole('option', { selected: true })
        ).toContainText('let answer');
        await page.screenshot({ path: 'test-results/nido-references.png' });
        await page.keyboard.press('k');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+j');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
        await page.keyboard.press('Control+j');
        await expect(list).toBeFocused();
        await page.keyboard.press('Space');
        await page.keyboard.press('d');
        await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
        await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: '[Untitled]', exact: true })).toHaveCount(0);
        await page.keyboard.press('Shift+F12');
        await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
    } finally {
        await running?.evaluate(({ app }) => app.exit(0));
        await running?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('Rust debugger keyboard controls stop, inspect and step in the packaged app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-debug-ui-'));
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        await mkdir(join(root, 'src'));
        await mkdir(join(root, 'src/bin'));
        await writeFile(join(root, 'src/bin/other.rs'), 'fn main() {}');
        await writeFile(
            join(root, 'Cargo.toml'),
            '[package]\nname="nido_debug_ui"\nversion="0.1.0"\nedition="2021"\n'
        );
        await writeFile(
            join(root, 'src/main.rs'),
            'fn main() {\n    let mut number = 21; let mut pair = [number; 20];\n    let answer = number * 2;\n    println!("answer={answer}");\n    number += 1;\n    pair[0] = number;\n    println!("{pair:?} {number}");\n}\n'
        );
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        await running.evaluate(({ dialog }) => {
            dialog.showOpenDialog = async () => {
                throw new Error('Native folder picker must not be used');
            };
        });
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
            'aria-busy',
            'false'
        );
        await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
        await page.keyboard.press('Control+l');
        await expect(page.getByRole('textbox', { name: 'Folder path' })).toBeFocused();
        await page.keyboard.type('relative-path');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toContainText('absolute folder path');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root, true);
        await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
        await expect(page.getByRole('button', { name: /main.rs.*src/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
        await page.keyboard.type('3G');
        await page.keyboard.press('F9');
        await expect(page.getByRole('region', { name: 'Debugger' })).toBeVisible();
        await page.keyboard.press('F5');
        await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
            'Choose an executable:',
            { timeout: 30000 }
        );
        await page.keyboard.press('Control+j');
        await expect(page.locator('[data-debug-target]:focus')).toHaveCount(1);
        for (
            let i = 0;
            i < 10 &&
            !(await page
                .getByRole('button', { name: 'nido_debug_ui', exact: true })
                .evaluate((element) => element === document.activeElement));
            i++
        )
            await page.keyboard.press('l');
        await expect(
            page.getByRole('button', { name: 'nido_debug_ui', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
            'Debug · paused',
            { timeout: 30000 }
        );
        await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeVisible();
        await page.keyboard.press('Control+k');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+h');
        await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
        await page.keyboard.press('Control+l');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+j');
        await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeFocused();
        await page.keyboard.press('Space');
        await page.keyboard.press('d');
        await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
        await page.keyboard.press('F10');
        await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
        await page.keyboard.press('Control+j');
        await expect(page.getByRole('treeitem', { name: /^answer = 42/ })).toBeVisible();
        await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeFocused();
        await page.keyboard.press('j');
        const pair = page.getByRole('treeitem', { name: /^pair = / });
        await expect(pair).toBeFocused();
        await page.keyboard.press('l');
        await expect(pair).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-debug-variable][aria-level="2"]')).toHaveCount(20);
        await page.keyboard.press('l');
        await expect(page.locator('[aria-level="2"]').first()).toBeFocused();
        await page.keyboard.press('Control+d');
        const jumpedId = await page
            .locator('[data-debug-variable]:focus')
            .getAttribute('data-debug-variable');
        expect(jumpedId).not.toBe(
            await page.locator('[aria-level="2"]').first().getAttribute('data-debug-variable')
        );
        await page.keyboard.press('Control+k');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('Control+j');
        await expect(page.locator(`[data-debug-variable="${jumpedId}"]`)).toBeFocused();
        await page.keyboard.press('Control+u');
        await expect(page.locator('[aria-level="2"]').first()).toBeFocused();
        await page.keyboard.press('Tab');
        const output = page.getByLabel('Debug output');
        await expect(output).toBeFocused();
        await page.keyboard.press('Home');
        const beforeScroll = await output.evaluate((element) => element.scrollTop);
        await page.keyboard.press('Control+d');
        await expect
            .poll(() => output.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(beforeScroll);
        await page.keyboard.press('Control+u');
        await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
        await page.keyboard.press('Control+j');
        await expect(page.locator('[aria-level="2"]').first()).toBeFocused();
        await page.keyboard.press('h');
        await expect(pair).toBeFocused();
        await page.keyboard.press('h');
        await expect(pair).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-debug-variable][aria-level="2"]')).toHaveCount(0);
        await page.keyboard.press('Enter');
        await expect(pair).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('F10');
        await expect(page.getByRole('region', { name: 'Debugger' })).toContainText('main.rs:5');
        await page.keyboard.press('F10');
        await expect(page.getByRole('treeitem', { name: /^number = 22.*changed/ })).toHaveAttribute(
            'data-changed',
            'true'
        );
        await page.keyboard.press('F10');
        await expect(
            page.locator('[data-debug-variable][aria-level="2"][data-changed]')
        ).toHaveCount(1);
        await expect(pair).toHaveAttribute('aria-expanded', 'true');
        const variablesBox = await page.getByLabel('Debug variables').boundingBox();
        const consoleBox = await page.getByLabel('Debug output').boundingBox();
        expect(consoleBox!.y).toBeGreaterThan(variablesBox!.y + variablesBox!.height);
        await page.screenshot({ path: 'test-results/nido-debugger.png' });
        await page.keyboard.press('Shift+F5');
        await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
            'Debug · finished'
        );
    } finally {
        await running?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('normal shutdown restores workspace order, active file and cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-restart-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    if (executablePath) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
        env.VIMINIT = 'lua error("Personal configuration must not run")';
    }
    const args = [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`];
    let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        await mkdir(join(root, 'One'));
        await mkdir(join(root, 'Two'));
        await writeFile(join(root, 'One', 'a.txt'), 'first line\nsecond line\nthird line\n');
        await writeFile(join(root, 'One', 'b.txt'), 'another line\n');
        await writeFile(join(root, 'One', 'mixed.txt'), 'first\r\nsecond\n');
        await writeFile(
            join(root, 'One', 'highlight.rs'),
            'fn main() { let greeting = "hello"; }\n'
        );
        await writeFile(
            join(root, 'One', 'Cargo.toml'),
            '[package]\nname = "nido_highlight_fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "highlight.rs"\n'
        );
        running = await electron.launch({ executablePath, args, env });
        let page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, join(root, 'One'));
        await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toBeVisible();
        await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('mixed.txt');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('Mixed');
        await expect(page.getByRole('alert')).toContainText('Mixed line endings detected');
        await page.getByRole('button', { name: 'Dismiss error' }).click();
        await page.getByRole('combobox', { name: 'Line endings' }).selectOption('LF');
        await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('LF');
        assert.equal(await readFile(join(root, 'One', 'mixed.txt'), 'utf8'), 'first\r\nsecond\n');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(root, 'One', 'mixed.txt'), 'utf8'))
            .toBe('first\nsecond\n');
        await page.keyboard.press('Control+Shift+p');
        await page
            .getByRole('textbox', { name: 'Filter items' })
            .fill('Convert line endings to CRLF');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('CRLF');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(root, 'One', 'mixed.txt'), 'utf8'))
            .toBe('first\r\nsecond\r\n');
        await page.keyboard.press('Space');
        await page.keyboard.press('d');
        await expect(page.getByRole('tab', { name: 'mixed.txt', exact: true })).toHaveCount(0);
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('highlight.rs');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: /^highlight\.rs/ })).toBeVisible();
        await expect
            .poll(() =>
                page.locator('canvas:visible').evaluate((element) => {
                    const canvas = element as HTMLCanvasElement;
                    const pixels = canvas
                        .getContext('2d')!
                        .getImageData(0, 0, canvas.width, canvas.height).data;
                    let keyword = false,
                        string = false;
                    for (let i = 0; i < pixels.length; i += 4) {
                        if (pixels[i] === 86 && pixels[i + 1] === 156 && pixels[i + 2] === 214)
                            keyword = true;
                        if (pixels[i] === 206 && pixels[i + 1] === 145 && pixels[i + 2] === 120)
                            string = true;
                    }
                    return keyword && string;
                })
            )
            .toBe(true);
        await page.screenshot({ path: 'test-results/nido-rust-highlights.png' });
        const cursorIsVisible = (): Promise<boolean> =>
            page.locator('canvas:visible').evaluate((element) => {
                const canvas = element as HTMLCanvasElement;
                const input = document.querySelector<HTMLTextAreaElement>(
                    'textarea[aria-label="Neovim input"]'
                )!;
                const scale = window.devicePixelRatio || 1;
                const pixel = canvas
                    .getContext('2d')!
                    .getImageData(
                        Math.floor((parseFloat(input.style.left) + 1) * scale),
                        Math.floor((parseFloat(input.style.top) + 3) * scale),
                        1,
                        1
                    ).data;
                return pixel[0] > 80;
            });
        await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
        await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
        await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
        await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(cursorIsVisible, { intervals: [20], timeout: 400 }).toBe(true);
        await expect
            .poll(() =>
                page.locator('canvas:visible').evaluate((element) => {
                    const canvas = element as HTMLCanvasElement;
                    const scale = window.devicePixelRatio || 1;
                    const ctx = canvas.getContext('2d')!;
                    const sample = (y: number): string =>
                        Array.from(
                            ctx.getImageData(canvas.width - 2, Math.floor((y + 0.5) * scale), 1, 1)
                                .data
                        )
                            .slice(0, 3)
                            .join(',');
                    return [sample(0), sample(24), sample(12)];
                })
            )
            .toEqual(['70,81,92', '70,81,92', '18,18,18']);
        await expect(page.getByTitle('Rust language server connection')).toHaveText(
            'rust_analyzer'
        );
        await page.keyboard.type(
            ":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='begin',title='Indexing',message='example_crate',percentage=42}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
        );
        await page.keyboard.press('Enter');
        await expect(page.getByRole('status')).toContainText('Indexing — example_crate (42%)');
        await page.screenshot({ path: 'test-results/nido-lsp-progress.png' });
        await page.keyboard.type(
            ":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='end'}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
        );
        await page.keyboard.press('Enter');
        await expect(page.getByRole('status').filter({ hasText: 'example_crate' })).toHaveCount(0);
        await page.keyboard.type(
            ":lua vim.lsp.handlers['window/showMessage'](nil, {type=2,message='Failed to run build scripts of some packages.'}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
        );
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toContainText(
            'LSP[rust_analyzer][Warning] Failed to run build scripts'
        );
        await expect(page.locator('canvas:visible')).not.toHaveAttribute(
            'aria-description',
            /Press ENTER/
        );
        await page.screenshot({ path: 'test-results/nido-lsp-warning.png' });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('alert', { name: 'Language server' })).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.type(
            ":lua vim.lsp.util.open_floating_preview({'# Nido documentation', '', '**Markdown preview**'}, 'markdown', {})"
        );
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /Markdown preview/
        );
        await expect(page.locator('canvas:visible')).not.toHaveAttribute(
            'aria-description',
            /Parser could not be created|Error executing/
        );
        await page.screenshot({ path: 'test-results/nido-documentation.png' });
        await page.keyboard.press('j');
        await page.keyboard.type('gg0w');
        await expect(async () => {
            await page.keyboard.press('K');
            await expect(page.getByRole('dialog', { name: 'Type information' })).toBeVisible({
                timeout: 1000
            });
        }).toPass({ timeout: 20000 });
        await page.screenshot({ path: 'test-results/nido-hover.png' });
        await page.keyboard.press('Escape');
        for (const [file, keys] of [
            ['a.txt', '3G4l'],
            ['b.txt', 'gg6l']
        ]) {
            await page.keyboard.press('Control+p');
            await page.getByRole('textbox', { name: 'Filter items' }).fill(file);
            await expect(
                page.getByRole('button', { name: `${file} ${file}`, exact: true })
            ).toBeVisible();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('tab', { name: file, exact: true })).toBeVisible();
            await page.keyboard.type(keys);
        }
        await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
        await page.keyboard.press('Shift+H');
        await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
        await page.keyboard.press('Shift+L');
        await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await page.keyboard.press('Shift+L');
        await expect(page.getByRole('tab', { name: /^highlight\.rs/ })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await page.keyboard.press('Shift+H');
        await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await page.keyboard.press('Control+h');
        await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
        const explorer = page.getByRole('complementary', { name: 'File explorer' });
        await page.keyboard.press('Shift+L');
        await expect(explorer).toHaveCSS('width', '263px');
        await page.keyboard.press('Shift+H');
        await expect(explorer).toHaveCSS('width', '243px');
        const edge = await page.getByRole('separator', { name: 'Explorer width' }).boundingBox();
        assert.ok(edge);
        await page.mouse.move(edge.x + edge.width / 2, edge.y + 100);
        await page.mouse.down();
        await page.mouse.move(edge.x + edge.width / 2 + 40, edge.y + 100);
        await page.mouse.up();
        await expect(explorer).toHaveCSS('width', '283px');
        await page.keyboard.press('Control+l');
        await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
        await page.keyboard.press('i');
        await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
        await expect(page.getByText('INSERT', { exact: true })).toHaveCSS(
            'background-color',
            'rgb(134, 189, 221)'
        );
        await page.keyboard.press('Shift+H');
        await page.keyboard.press('Shift+L');
        await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /HL/);
        await expect(page.getByRole('tab', { name: 'b.txt Unsaved', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await page.keyboard.press('Escape');
        await page.keyboard.press('u');
        await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, join(root, 'Two'));
        await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toBeVisible();
        await page.keyboard.press('Space');
        await page.keyboard.press('h');
        const closed = running.waitForEvent('close');
        await page.evaluate(() => {
            void window.nido.windowAction('close');
        });
        await closed;
        running = await electron.launch({ executablePath, args, env });
        page = await running.firstWindow();
        await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCSS(
            'width',
            '283px'
        );
        await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await page.keyboard.press('Alt+2');
        await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
        await page.getByRole('tab', { name: 'a.txt', exact: true }).click();
        await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
    } finally {
        if (running) {
            await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
            await running.close();
        }
        await rm(root, { recursive: true, force: true });
    }
});

test('keyboard-only workspace switching, editing, saving and dirty-close guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-e2e-'));
    await mkdir(join(root, 'Nido'));
    await mkdir(join(root, 'Portfolio'));
    await writeFile(
        join(root, 'Nido', 'WorkspaceTabs.tsx'),
        `import { useState } from 'react'\n\ninterface Workspace {\n  id: string\n  name: string\n}\n\nexport function WorkspaceTabs() {\n  const [active, setActive] = useState('nido')\n  const workspaces: Workspace[] = [\n    { id: 'nido', name: 'Nido' },\n    { id: 'portfolio', name: 'Portfolio' }\n  ]\n\n  return (\n    <nav aria-label="Workspaces">\n      {workspaces.map((workspace) => (\n        <button\n          key={workspace.id}\n          onClick={() => setActive(workspace.id)}\n          aria-selected={active === workspace.id}\n        >\n          {workspace.name}\n        </button>\n      ))}\n    </nav>\n  )\n}\n`
    );
    await writeFile(
        join(root, 'Nido', 'App.tsx'),
        'export default function App() { return null }\n'
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.NIDO_PACKAGED_EXE;
    if (executablePath) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
        env.VIMINIT = 'lua error("Personal configuration must not run")';
    }
    const app = await electron.launch({
        executablePath,
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await app.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        });
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, join(root, 'Nido'));
        await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toBeVisible();
        const welcome = page.getByRole('region', { name: 'Workspace welcome' });
        await expect(welcome).toBeVisible();
        await expect(page.locator('canvas:visible')).not.toHaveAttribute(
            'aria-description',
            /NVIM v/
        );
        await page.screenshot({ path: 'test-results/nido-workspace-welcome.png' });
        await page.keyboard.press('i');
        await expect(welcome).toBeHidden();
        await page.keyboard.type('draft');
        await page.keyboard.press('Escape');
        await expect(welcome).toBeHidden();
        await page.keyboard.press('u');
        await expect(welcome).toBeVisible();
        await page.keyboard.type(':');
        await expect(welcome).toBeHidden();
        await page.keyboard.press('Escape');
        await expect(welcome).toBeVisible();
        await page.getByRole('button', { name: 'Open a file' }).click();
        await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'WorkspaceTabs.tsx' })).toBeVisible();
        await expect(welcome).toBeHidden();
        await page.keyboard.type('gg0i// smoke test');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(() => readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8'))
            .toContain('// smoke test');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /smoke test/
        );
        await page.keyboard.press('Control+v');
        await expect(page.getByText('VISUAL', { exact: true })).toBeVisible();
        await expect(page.getByText('VISUAL', { exact: true })).toHaveCSS(
            'background-color',
            'rgb(201, 166, 230)'
        );
        await page.keyboard.press('Escape');
        await page.keyboard.type('Go');
        await page.locator('textarea:visible').evaluate((element) => {
            const input = element as HTMLTextAreaElement;
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.value = '日本語入力';
            input.dispatchEvent(
                new InputEvent('input', { bubbles: true, data: '日本語入力', isComposing: true })
            );
            input.dispatchEvent(
                new CompositionEvent('compositionend', { bubbles: true, data: '日本語入力' })
            );
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本語入力' }));
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+s');
        await expect
            .poll(
                async () =>
                    (await readFile(join(root, 'Nido', 'WorkspaceTabs.tsx'), 'utf8')).match(
                        /日本語入力/g
                    )?.length
            )
            .toBe(1);
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /日本語入力/
        );
        await page.keyboard.type('gg');
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, join(root, 'Portfolio'));
        await expect(
            page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
        ).toBeVisible();
        await page.keyboard.type('iindependent buffer');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Tab');
        await expect(
            page.getByRole('tab', { name: 'Workspace Nido', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Space');
        await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Space');
        await page.keyboard.press('e');
        await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
        await page.keyboard.press('Home');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('tab', { name: 'App.tsx', exact: true })).toBeVisible();
        await page.keyboard.press('Space');
        await page.keyboard.press('b');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
        await page.keyboard.press('Enter');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /smoke test/
        );
        await page.keyboard.press('Space');
        await page.screenshot({ path: 'test-results/nido-editor.png' });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Alt+2');
        await page.keyboard.press('Space');
        await page.keyboard.press('x');
        await expect(
            page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
        ).toBeVisible();
        await expect(
            page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('canvas:visible')).toHaveAttribute(
            'aria-description',
            /independent buffer/
        );
        await app.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
        });
        await page.keyboard.press('Space');
        await page.keyboard.press('x');
        await expect(
            page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
        ).toHaveCount(0);
        expect(errors).toEqual([]);
    } finally {
        await app.evaluate(({ app }) => app.exit(0));
        await app.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('settings navigation crosses the shell selector with Ctrl D and Ctrl U', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-settings-navigation-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
        const extension = page.getByRole('checkbox', { name: 'Use EditorConfig' });
        await shell.focus();
        await page.keyboard.press('Control+d');
        await expect(extension).toBeFocused();
        await page.keyboard.press('Control+u');
        await expect(shell).toBeFocused();
        await page.keyboard.press('Control+j');
        await expect(extension).toBeFocused();
        await page.keyboard.press('Control+k');
        await expect(shell).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(shell).toBeFocused();
        await expect(shell).toHaveValue('pwsh');
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('explorer zz centers selection without opening or changing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-explorer-center-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
            writeFile(join(workspace, `file${String(i).padStart(3, '0')}.txt`), '')
        )
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const tree = page.getByRole('tree', { name: 'Project files' });
        await expect(tree.getByRole('treeitem')).toHaveCount(100);
        await tree.focus();
        await page.keyboard.press('Home');
        await page.keyboard.type('j'.repeat(50));
        const selected = tree.locator('[aria-selected="true"]');
        const name = await selected.textContent();
        const before = await tree.evaluate((node) => node.scrollTop);
        await page.keyboard.press('z');
        expect(await tree.evaluate((node) => node.scrollTop)).toBe(before);
        await page.keyboard.press('z');
        await expect
            .poll(() =>
                tree.evaluate((node) => {
                    const row = node
                        .querySelector('[aria-selected="true"]')!
                        .getBoundingClientRect();
                    const viewport = node.getBoundingClientRect();
                    return Math.abs(
                        row.top + row.height / 2 - viewport.top - node.clientHeight / 2
                    );
                })
            )
            .toBeLessThan(2);
        await expect(selected).toHaveText(name!);
        await expect(tree).toBeFocused();
        const centered = await tree.evaluate((node) => node.scrollTop);
        await page.keyboard.type('zxz');
        expect(await tree.evaluate((node) => node.scrollTop)).toBe(centered);
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('half-page direction changes animate once per press', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-page-direction-'));
    await writeFile(
        join(root, 'scroll.txt'),
        Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, root);
        await expect(page.getByRole('treeitem', { name: 'scroll.txt', exact: true })).toBeVisible();
        await page.keyboard.press('Control+p');
        await page.getByRole('textbox', { name: 'Filter items' }).fill('scroll.txt');
        await expect(page.getByRole('button', { name: /scroll\.txt/ })).toBeVisible();
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /line 1/);
        await page.keyboard.type('80Gzz');
        await page.waitForTimeout(300);
        await canvas.evaluate((node) => {
            node.dataset.frames = '0';
            node.dataset.scrolls = '[]';
            const context = (node as HTMLCanvasElement).getContext('2d')!;
            const draw = context.drawImage.bind(context);
            context.drawImage = ((...args: Parameters<typeof draw>) => {
                node.dataset.frames = String(Number(node.dataset.frames) + 1);
                draw(...args);
            }) as typeof draw;
            window.nido.onEvent((event) => {
                if (event.type !== 'redraw') return;
                for (const [name, ...calls] of event.events) {
                    if (name === 'nido_scroll') {
                        node.dataset.scrolls = JSON.stringify([
                            ...JSON.parse(node.dataset.scrolls!),
                            ...calls.map((args) => Number(args[5]))
                        ]);
                    }
                }
            });
        });
        for (const key of ['Control+d', 'Control+u', 'Control+d', 'Control+u']) {
            const frames = Number(await canvas.getAttribute('data-frames'));
            await canvas.evaluate((node) => {
                node.dataset.scrolls = '[]';
            });
            await page.keyboard.press(key);
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-frames')))
                .toBeGreaterThan(frames);
            await page.waitForTimeout(200);
            const scrolls = JSON.parse((await canvas.getAttribute('data-scrolls'))!) as number[];
            expect(scrolls).toHaveLength(1);
            expect(Math.sign(scrolls[0])).toBe(key === 'Control+d' ? 1 : -1);
        }
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('stage all keeps HEAD gutter marks until commit and preserves unsaved edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-stage-all-ui-'));
    const workspace = join(root, 'repo');
    await mkdir(workspace);
    const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    git('config', 'user.name', 'Nido Test');
    git('config', 'user.email', 'nido@example.test');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(workspace, 'main.txt'), 'before\n');
    await writeFile(join(workspace, 'deleted.txt'), 'deleted\n');
    git('add', '.');
    git('commit', '-qm', 'Initial');
    await writeFile(join(workspace, 'main.txt'), 'changed\n');
    await writeFile(join(workspace, 'new.txt'), 'new\n');
    await rm(join(workspace, 'deleted.txt'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({
        args: ['.', `--user-data-dir=${join(root, 'profile')}`],
        env
    });
    try {
        const page = await running.firstWindow();
        await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
        await page.keyboard.press('Control+Shift+n');
        await chooseWorkspace(page, workspace);
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await page.keyboard.type(':edit main.txt');
        await page.keyboard.press('Enter');
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /▎.*changed/);
        await page.keyboard.type('A unsaved');
        await page.keyboard.press('Escape');
        await expect(canvas).toHaveAttribute('aria-description', /changed unsaved/);
        await page.keyboard.press('Control+Shift+g');
        const panel = page.getByRole('region', { name: 'Git changes' });
        await expect(
            panel.getByRole('button', { name: 'Stage all (S)', exact: true })
        ).toBeEnabled();
        await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
        await page.keyboard.press('Shift+s');
        await expect(
            panel.getByRole('heading', { name: 'Staged changes', exact: true })
        ).toBeVisible();
        await expect(
            panel.getByRole('button', { name: 'Stage all (S)', exact: true })
        ).toBeDisabled();
        expect(git('diff', '--cached', '--name-only').trim().split('\n')).toEqual([
            'deleted.txt',
            'main.txt',
            'new.txt'
        ]);
        await page.keyboard.press('Escape');
        await expect(canvas).toHaveAttribute('aria-description', /▎.*changed unsaved/);
        await page.keyboard.press('Control+Shift+g');
        await expect(panel).toHaveAttribute('aria-busy', 'false');
        await page.getByRole('textbox', { name: 'Commit message' }).fill('Stage all commit');
        await page.keyboard.press('Control+Enter');
        await expect(panel.getByText('Working tree clean.', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(canvas).toHaveAttribute('aria-description', /▎.*changed unsaved/);
        expect(git('show', 'HEAD:main.txt')).toBe('changed\n');
        await page.keyboard.type('u');
        await expect(canvas).toHaveAttribute('aria-description', /changed/);
        await expect(canvas).not.toHaveAttribute('aria-description', /▎|▸/);
        expect(git('log', '--format=%s', '-1').trim()).toBe('Stage all commit');
    } finally {
        await running.evaluate(({ app }) => app.exit(0));
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
