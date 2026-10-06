import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const scale of [1, 1.25, 1.5]) {
    test(`cached editor text preserves its pixels at ${scale * 100}% scale`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-sharpness-'));
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        await writeFile(
            join(root, 'sample.txt'),
            Array.from(
                { length: 150 },
                (_, index) =>
                    `line_${index + 1}: changed: false, cursor_row: 1, cursor_col: 1, ScreenCells::new(rows, cols)`
            ).join('\n')
        );
        const running = await electron.launch({
            args: ['.', `--user-data-dir=${join(root, 'profile')}`],
            env
        });
        try {
            const page = await running.firstWindow();
            await expect(
                page.getByRole('heading', { name: 'Make yourself at home.' })
            ).toBeVisible();
            const initialDpr = await page.evaluate(() => devicePixelRatio);
            await running.evaluate(({ BrowserWindow }, zoom) => {
                BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
            }, scale / initialDpr);
            await page.keyboard.press('Control+Shift+n');
            await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
                'aria-busy',
                'false'
            );
            await page.getByRole('textbox', { name: 'Folder path' }).fill(root);
            await page.keyboard.press('Enter');
            await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
                'aria-busy',
                'false'
            );
            await page.keyboard.press('Control+Enter');
            await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
            await page.keyboard.type(':edit sample.txt');
            await page.keyboard.press('Enter');
            const canvas = page.locator('canvas:visible');
            await expect(canvas).toHaveAttribute('aria-description', /ScreenCells/);
            await page.getByRole('button', { name: 'Settings', exact: true }).click();
            await page.getByRole('checkbox', { name: 'UI animations' }).uncheck();
            await canvas.evaluate((node: HTMLCanvasElement) => {
                // Force fractional layout edges, as sidebars and Windows scaling can produce.
                node.parentElement!.style.marginLeft = '12.3px';
                node.parentElement!.style.marginTop = '0.3px';
                const ctx = node.getContext('2d')!;
                const draw = ctx.drawImage.bind(ctx);
                const fill = ctx.fillRect.bind(ctx);
                ctx.fillRect = (x, y, width, height) => {
                    if (x === 0 && y === 0 && height > 100) node.dataset.filteredRows = '0';
                    fill(x, y, width, height);
                };
                node.dataset.copied = '0';
                node.dataset.mismatches = '0';
                node.dataset.fractional = '0';
                ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                    draw(...args);
                    if (args.length !== 5 || !(args[0] instanceof HTMLCanvasElement)) return;
                    const source = args[0];
                    const dpr = window.devicePixelRatio;
                    if (source.height > Math.ceil(19 * dpr)) {
                        node.dataset.filteredRows = String(Number(node.dataset.filteredRows) + 1);
                    }
                    const y = Number(args[2]) * dpr;
                    const top = Math.round(y);
                    // Bottom buffer rows are intentionally clipped above the command line.
                    if (top < 0 || top + 3 * source.height >= node.height) return;
                    const width = Math.min(360, source.width - 180);
                    const height = source.height - 2;
                    const expected = source
                        .getContext('2d')!
                        .getImageData(180, 1, width, height).data;
                    const actual = ctx.getImageData(180, top + 1, width, height).data;
                    let mismatches = 0;
                    for (let i = 0; i < actual.length; i++) {
                        if (actual[i] !== expected[i]) mismatches++;
                    }
                    node.dataset.copied = String(Number(node.dataset.copied) + 1);
                    node.dataset.mismatches = String(Number(node.dataset.mismatches) + mismatches);
                    if (Math.abs(y - top) > 0.001) {
                        node.dataset.fractional = String(Number(node.dataset.fractional) + 1);
                    }
                }) as typeof draw;
            });
            await page.getByRole('spinbutton', { name: 'Editor line height' }).fill('19');
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-copied')))
                .toBeGreaterThan(10);
            const metrics = await canvas.evaluate((node: HTMLCanvasElement) => ({
                dpr: devicePixelRatio,
                copied: node.dataset.copied,
                fractional: node.dataset.fractional,
                mismatches: node.dataset.mismatches
            }));
            await page.keyboard.press('Escape');
            await page.screenshot({
                path: `test-results/text-sharpness-${scale}-${metrics.mismatches === '0' ? 'after' : 'before'}.png`
            });
            expect(metrics.dpr).toBeCloseTo(scale, 4);
            expect(metrics.fractional).toBe('0');
            expect(metrics.mismatches).toBe('0');
            const alignment = await canvas.evaluate((node: HTMLCanvasElement) => {
                const bounds = node.getBoundingClientRect();
                return [
                    bounds.left * devicePixelRatio,
                    bounds.top * devicePixelRatio,
                    bounds.width * devicePixelRatio - node.width,
                    bounds.height * devicePixelRatio - node.height
                ];
            });
            expect(Math.abs(alignment[0] - Math.round(alignment[0]))).toBeLessThan(0.025);
            expect(Math.abs(alignment[1] - Math.round(alignment[1]))).toBeLessThan(0.025);
            expect(Math.abs(alignment[2])).toBeLessThan(0.025);
            expect(Math.abs(alignment[3])).toBeLessThan(0.025);
            const copied = Number(await canvas.getAttribute('data-copied'));
            await canvas.hover();
            await page.mouse.wheel(0, 2.4);
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-copied')))
                .toBeGreaterThan(copied);
            await expect(canvas).toHaveAttribute('data-fractional', '0');
            await expect(canvas).toHaveAttribute('data-mismatches', '0');
            await expect(canvas).toHaveAttribute('data-filtered-rows', '0');
            // Changing zoom must rebuild backing pixels even without another editor command.
            const nextScale = scale + 0.25;
            await running.evaluate(({ BrowserWindow }, zoom) => {
                BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
            }, nextScale / initialDpr);
            await expect
                .poll(() =>
                    canvas.evaluate((node: HTMLCanvasElement) => {
                        const bounds = node.getBoundingClientRect();
                        return Math.max(
                            Math.abs(bounds.width * devicePixelRatio - node.width),
                            Math.abs(bounds.height * devicePixelRatio - node.height),
                            Math.abs(
                                bounds.left * devicePixelRatio -
                                    Math.round(bounds.left * devicePixelRatio)
                            ),
                            Math.abs(
                                bounds.top * devicePixelRatio -
                                    Math.round(bounds.top * devicePixelRatio)
                            )
                        );
                    })
                )
                .toBeLessThan(0.025);
            // The settling repaint must still happen while the editor input is unfocused.
            const beforeUnfocused = Number(await canvas.getAttribute('data-copied'));
            await canvas.evaluate((node) => {
                (document.activeElement as HTMLElement)?.blur();
                node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 0.35 }));
            });
            await expect
                .poll(async () => Number(await canvas.getAttribute('data-copied')))
                .toBeGreaterThan(beforeUnfocused);
            await expect(canvas).toHaveAttribute('data-filtered-rows', '0');
        } finally {
            await running.close();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
