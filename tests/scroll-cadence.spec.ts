import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRowImageProbe } from './helpers/row-image-probe';

test('continuous wheel scrolling keeps painted positions monotonic in both directions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-cadence-'));
    const profile = join(root, 'profile');
    const file = join(root, 'rows.txt');
    await mkdir(profile);
    await writeFile(
        file,
        Array.from({ length: 4000 }, (_, i) => `ROW_${i + 1} text text text`).join('\n')
    );
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1100, height: 850, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        await page.addInitScript(installRowImageProbe);
        await page.reload();
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /ROW_1 /);
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const ctx = node.getContext('2d')!;
            const fill = ctx.fillRect.bind(ctx);
            const draw = ctx.drawImage.bind(ctx);
            let first = true;
            Object.assign(window, { cadence: { samples: [] as { top: number; at: number }[] } });
            Object.assign(window, { cadenceEvents: [] as unknown[] });
            window.nido.onEvent((event) => {
                if (event.type === 'redraw')
                    (window as unknown as { cadenceEvents: unknown[] }).cadenceEvents.push({
                        at: performance.now(),
                        events: event.events.filter(([name]) =>
                            [
                                'nido_edit',
                                'nido_pixel_scroll',
                                'nido_scroll',
                                'mode_change'
                            ].includes(name)
                        )
                    });
            });
            ctx.fillRect = (x, y, w, h) => {
                if (x === 0 && y === 0 && h > 100) first = true;
                fill(x, y, w, h);
            };
            ctx.drawImage = ((...args: Parameters<typeof draw>) => {
                if (first && args.length === 5 && Number(args[2]) + Number(args[4]) > 0) {
                    first = false;
                    const source = args[0] as HTMLCanvasElement;
                    const row = source.dataset?.rowText?.match(/ROW_(\d+)/);
                    if (row) {
                        const rowHeight = Number(localStorage.getItem('nido.lineHeight'));
                        const baseline = Number(source.dataset.rowBaseline);
                        const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
                        const top = (Number(row[1]) - 1) * rowHeight - Number(args[2]) - phase;
                        (
                            window as unknown as {
                                cadence: { samples: { top: number; at: number }[] };
                            }
                        ).cadence.samples.push({ top, at: performance.now() });
                        node.dataset.documentTop = String(top);
                    }
                }
                draw(...args);
            }) as typeof draw;
        });
        const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
        // Make cache refills span several frames, as they can under editor/LSP load.
        await running.evaluate(({ ipcMain }) => {
            const handlers = (
                ipcMain as unknown as {
                    _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
                }
            )._invokeHandlers;
            const prefetch = handlers.get('nido:prefetchScroll')!;
            handlers.set('nido:prefetchScroll', async (...args) => {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return prefetch(...args);
            });
        });
        const reports: object[] = [];
        for (const mode of ['normal', 'insert']) {
            for (const delta of [5, -5, 40, -40, 120, -120]) {
                await page.evaluate(async (id) => {
                    await window.nido.input(id, '<Esc>1000Gzt');
                }, restored.workspaces[0].id);
                await page.waitForTimeout(250);
                if (mode === 'insert') {
                    await page.evaluate(
                        (id) => window.nido.input(id, 'i_'),
                        restored.workspaces[0].id
                    );
                    await page.waitForTimeout(150);
                }
                // Warm the initial viewport so this checks sustained scrolling, not cold startup.
                await canvas.evaluate(async (node) => {
                    // Visit fractional coverage positions as well as the whole-pixel raster.
                    for (const pixels of [0.2, 0.2, 0.2, 0.2, 0.2, -1.01]) {
                        await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => resolve())
                        );
                        node.dispatchEvent(
                            new WheelEvent('wheel', {
                                bubbles: true,
                                deltaY: pixels / devicePixelRatio
                            })
                        );
                    }
                });
                await page.waitForTimeout(250);
                const start = Number(await canvas.getAttribute('data-document-top'));
                await canvas.evaluate(async (node, delta) => {
                    (window as unknown as { cadence: { samples: unknown[] } }).cadence.samples = [];
                    (window as unknown as { cadenceEvents: unknown[] }).cadenceEvents = [];
                    for (let i = 0; i < 100; i++) {
                        await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => resolve())
                        );
                        node.dispatchEvent(
                            new WheelEvent('wheel', { bubbles: true, deltaY: delta })
                        );
                    }
                }, delta);
                await page.waitForTimeout(150);
                const samples = await page.evaluate(
                    () =>
                        (
                            window as unknown as {
                                cadence: { samples: { top: number; at: number }[] };
                            }
                        ).cadence.samples
                );
                const steps = samples
                    .slice(1)
                    .map((sample, i) => Math.sign(delta) * (sample.top - samples[i].top));
                const pixel = await page.evaluate(() => 1 / window.devicePixelRatio);
                const gaps = samples
                    .slice(1)
                    .map((sample, i) => sample.at - samples[i].at)
                    .sort((a, b) => a - b);
                const reversals = steps.filter((step, index) => {
                    // After input stops, sharpening snaps glyphs by at most one physical pixel.
                    // Keep the continuous-motion assertion strict while the wheel is active.
                    const idleSnap =
                        samples[index + 1].at - samples[index].at > 100 &&
                        Math.abs(step) <= pixel + 0.01;
                    return step < -0.1 && !idleSnap;
                });
                reports.push({
                    direction: delta > 0 ? 'down' : 'up',
                    delta,
                    mode,
                    paints: samples.length,
                    reversals,
                    minStep: Math.min(...steps),
                    maxStep: Math.max(...steps),
                    gapP95: gaps[Math.floor(gaps.length * 0.95)],
                    maxGap: gaps.at(-1),
                    distance: samples.at(-1)!.top - start
                });
                if (reversals.length)
                    Object.assign(reports.at(-1)!, {
                        samples,
                        events: await page.evaluate(
                            () => (window as unknown as { cadenceEvents: unknown[] }).cadenceEvents
                        )
                    });
                if (reversals.length)
                    await writeFile(
                        join(
                            process.cwd(),
                            `test-results/scroll-cadence-failure-${test.info().repeatEachIndex}.json`
                        ),
                        JSON.stringify(reports.at(-1), null, 2)
                    );
                await writeFile(
                    join(process.cwd(), 'test-results/scroll-cadence.json'),
                    JSON.stringify(reports, null, 2)
                );
                expect(samples.length).toBeGreaterThan(20);
                // Rasterized row positions can differ by one physical pixel at fractional DPI.
                expect(Math.abs(samples.at(-1)!.top - start - delta * 100)).toBeLessThanOrEqual(
                    pixel + 0.01
                );
                expect(reversals).toEqual([]);
                expect(
                    Math.max(...steps),
                    'cache refills must not stall then jump'
                ).toBeLessThanOrEqual(Math.abs(delta) * (Math.abs(delta) > 5 ? 3 : 2) + pixel);
            }
        }
    } finally {
        await running.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) window.destroy();
        });
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
