import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';

test('acrylic switches live without losing edits and persists across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-theme-'));
    const profile = join(root, 'profile');
    const file = join(root, 'welcome.ts');
    const source = [
        '// A small place for your next idea.',
        '',
        'interface Workspace {',
        '    name: string;',
        '    files: string[];',
        '}',
        '',
        'export function welcome(workspace: Workspace): string {',
        '    const count = workspace.files.length;',
        '    return `Welcome to ${workspace.name} · ${count} files`;',
        '}',
        ''
    ]
        .concat(
            Array.from({ length: 200 }, () => ''),
            ['// End of workspace']
        )
        .join('\n');
    await mkdir(profile);
    await writeFile(file, source);
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
    const launch = (): ReturnType<typeof electron.launch> =>
        electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
            env
        });
    let running = await launch();
    try {
        const page = await running.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
        const input = page.getByRole('textbox', { name: 'Neovim input' });
        await expect(input).toBeFocused();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        const inputHandle = await input.elementHandle();
        expect(
            await canvas.evaluate(
                (node: HTMLCanvasElement) => node.getContext('2d')!.getContextAttributes().alpha
            )
        ).toBe(false);
        await page.keyboard.press('i');
        await page.keyboard.type('// unsaved idea\n');
        await page.keyboard.press('Escape');
        await expect(canvas).toHaveAttribute('aria-description', /unsaved idea/);
        await running.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            const original = window.setBackgroundMaterial.bind(window);
            const calls: string[] = [];
            window.setBackgroundMaterial = (material) => {
                calls.push(material);
                original(material);
            };
            Object.assign(globalThis, { themeMaterialCalls: calls });
        });
        await expect(
            page.evaluate(() => window.nido.setTheme('invalid' as 'dark'))
        ).rejects.toThrow('Invalid theme');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
        await expect(page.getByRole('spinbutton', { name: 'Editor font size' })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(theme).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(theme).toHaveValue('acrylic');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'acrylic');
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('nido.theme')))
            .toBe('acrylic');
        const supported = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
        await expect
            .poll(() =>
                running.evaluate(
                    () =>
                        (globalThis as unknown as { themeMaterialCalls: string[] })
                            .themeMaterialCalls
                )
            )
            .toEqual(supported ? ['acrylic'] : []);
        await expect
            .poll(() =>
                running.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].getBackgroundColor()
                )
            )
            .toBe(supported ? '#000000' : '#141414');
        await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS(
            'backdrop-filter',
            'blur(24px)'
        );
        await page.keyboard.press('Control+j');
        await expect(page.getByRole('spinbutton', { name: 'Editor font size' })).toBeFocused();
        if (process.env.NIDO_THEME_SCREENSHOT) {
            await page.getByRole('dialog', { name: 'Settings' }).evaluate(async (node) => {
                await Promise.all(node.getAnimations().map((animation) => animation.finished));
            });
            await page.screenshot({
                path: process.env.NIDO_THEME_SCREENSHOT.replace('.png', '-settings.png')
            });
        }
        await page.keyboard.press('Escape');
        await expect(input).toBeFocused();
        await expect(canvas).toHaveAttribute('aria-description', /unsaved idea/);
        expect(await input.evaluate((node, original) => node === original, inputHandle)).toBe(true);
        expect(
            await canvas.evaluate(
                (node: HTMLCanvasElement) => node.getContext('2d')!.getContextAttributes().alpha
            )
        ).toBe(true);
        const backgroundAlpha = (): Promise<number> =>
            canvas.evaluate(
                (node: HTMLCanvasElement) =>
                    node
                        .getContext('2d')!
                        .getImageData(node.width - 2, Math.floor(node.height / 2), 1, 1).data[3]
            );
        await expect.poll(backgroundAlpha).toBe(128);
        // Repaints must replace the translucent background, preserving both alpha and glyphs.
        await page.evaluate(
            async (id) => {
                for (let index = 0; index < 8; index++) {
                    await window.nido.input(id, 'j');
                    await window.nido.input(id, 'k');
                }
            },
            (await page.evaluate(() => window.nido.restoreWorkspaces())).active
        );
        await expect.poll(backgroundAlpha).toBe(128);
        const glyphAlpha = await canvas.evaluate((node: HTMLCanvasElement) => {
            const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, 30).data;
            let maximum = 0;
            for (let index = 3; index < pixels.length; index += 4)
                maximum = Math.max(maximum, pixels[index]);
            return maximum;
        });
        expect(glyphAlpha).toBe(255);
        const workspaceId = (await page.evaluate(() => window.nido.restoreWorkspaces())).active;
        const scrollAlpha = await page.evaluate(async (id) => {
            const node = document.querySelector<HTMLCanvasElement>('canvas')!;
            const context = node.getContext('2d')!;
            const scrolling = window.nido.input(id, '<C-d>');
            const samples: number[] = [];
            for (let frame = 0; frame < 24; frame++) {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                const pixels = context.getImageData(
                    node.width - 10,
                    Math.floor(node.height / 2),
                    8,
                    8
                ).data;
                const alpha: number[] = [];
                for (let index = 3; index < pixels.length; index += 4) alpha.push(pixels[index]);
                alpha.sort((a, b) => a - b);
                samples.push(alpha[Math.floor(alpha.length / 2)]);
            }
            await scrolling;
            return samples;
        }, workspaceId);
        expect(scrollAlpha).toEqual(Array.from({ length: 24 }, () => 128));
        await page.evaluate((id) => window.nido.input(id, 'gg'), workspaceId);
        await expect(canvas).toHaveAttribute('aria-description', /unsaved idea/);
        expect(
            await running.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].getOpacity()
            )
        ).toBe(1);
        expect(await readFile(file, 'utf8')).toBe(source);
        if (process.env.NIDO_THEME_SCREENSHOT) {
            await page.screenshot({ path: process.env.NIDO_THEME_SCREENSHOT });
        }
        await page.keyboard.press('Control+s');
        await expect.poll(() => readFile(file, 'utf8')).toContain('// unsaved idea');
        expect(errors).toEqual([]);
        await running.close();
        running = await launch();
        const restored = await running.firstWindow();
        await expect(restored.locator('html')).toHaveAttribute('data-theme', 'acrylic');
        await restored.getByRole('button', { name: 'Settings', exact: true }).click();
        const restoredTheme = restored.getByRole('combobox', { name: 'Theme', exact: true });
        await expect(restoredTheme).toHaveValue('acrylic');
        await restoredTheme.selectOption('dark');
        await expect(restored.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect
            .poll(() =>
                restored
                    .locator('canvas:visible')
                    .evaluate(
                        (node: HTMLCanvasElement) =>
                            node.getContext('2d')!.getContextAttributes().alpha
                    )
            )
            .toBe(false);
        await expect(restored.getByRole('dialog', { name: 'Settings' })).toHaveCSS(
            'backdrop-filter',
            'none'
        );
        await expect
            .poll(() =>
                running.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0].getBackgroundColor()
                )
            )
            .toBe('#141414');
        await expect
            .poll(() => restored.evaluate(() => localStorage.getItem('nido.theme')))
            .toBe('dark');
        await restored.evaluate(() => localStorage.setItem('nido.theme', 'retired-theme'));
        await running.close();
        running = await launch();
        const fallback = await running.firstWindow();
        await expect(fallback.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect
            .poll(() => fallback.evaluate(() => localStorage.getItem('nido.theme')))
            .toBe('dark');
    } finally {
        await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await running.close().catch(() => {});
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
