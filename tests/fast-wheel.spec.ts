import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRowImageProbe } from './helpers/row-image-probe';

const scenarios = [
    { delta: 120, history: 0, title: 'fast wheel down moves during input with a cold viewport' },
    { delta: -120, history: 0, title: 'fast wheel up moves during input with a cold viewport' },
    {
        delta: -120,
        history: 2,
        title: 'fast wheel up moves when cached history is shorter than a wheel step'
    },
    {
        delta: -120,
        history: 128,
        title: 'fast wheel up keeps moving while input exhausts cached history'
    },
    {
        delta: 5,
        history: 2,
        prefetchFirst: true,
        title: 'touchpad down keeps moving while an upward refill is pending'
    },
    {
        delta: -5,
        history: 2,
        prefetchFirst: true,
        title: 'touchpad up keeps moving while a refill is pending'
    }
];

for (const { delta, history, prefetchFirst, title } of scenarios) {
    test(title, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-fast-wheel-'));
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
                workspaces: [
                    { root, current: file, files: [{ path: file, line: 1000, column: 0 }] }
                ]
            })
        );
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
        }
        const executablePath = process.env.NIDO_PACKAGED_EXE;
        const running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
            env
        });
        try {
            const page = await running.firstWindow();
            await page.addInitScript(installRowImageProbe);
            await page.reload();
            const canvas = page.locator('canvas:visible');
            await expect(canvas).toHaveAttribute('aria-description', /ROW_1000 /);
            // Hold the refill while wheel input is active, modeling a costly source/LSP redraw.
            await running.evaluate(({ ipcMain }) => {
                const handlers = (
                    ipcMain as unknown as {
                        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
                    }
                )._invokeHandlers;
                const prefetch = handlers.get('nido:prefetchScroll')!;
                let release!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const probe = { calls: 0, release };
                Object.assign(globalThis, { wheelPrefetch: probe });
                handlers.set('nido:prefetchScroll', async (...args) => {
                    probe.calls++;
                    await gate;
                    return prefetch(...args);
                });
            });
            if (history) {
                await page.evaluate(async (lines) => {
                    const restored = await window.nido.restoreWorkspaces();
                    // Small moves retain the outgoing rows; a page-sized jump would discard them.
                    for (let remaining = lines; remaining > 0; remaining -= 2) {
                        await window.nido.scroll(
                            restored.workspaces[0].id,
                            Math.min(2, remaining),
                            true,
                            true
                        );
                    }
                }, history);
                await expect(canvas).toHaveAttribute(
                    'aria-description',
                    new RegExp(`ROW_${1000 + history} `)
                );
            }
            await canvas.evaluate((node: HTMLCanvasElement) => {
                const samples: { top: number; at: number }[] = [];
                const wheels: number[] = [];
                Object.assign(window, { fastWheelPositions: samples, fastWheelEvents: wheels });
                node.addEventListener('wheel', () => wheels.push(performance.now()));
                const ctx = node.getContext('2d')!;
                const fill = ctx.fillRect.bind(ctx);
                const draw = ctx.drawImage.bind(ctx);
                let first = true;
                ctx.fillRect = (x, y, width, height) => {
                    if (x === 0 && y === 0 && height > 100) first = true;
                    fill(x, y, width, height);
                };
                ctx.drawImage = ((...args: unknown[]) => {
                    if (first && args.length === 5 && Number(args[2]) + Number(args[4]) > 0) {
                        first = false;
                        const source = args[0] as HTMLCanvasElement;
                        const row = source.dataset.rowText?.match(/ROW_(\d+)/);
                        if (row) {
                            const height = Number(localStorage.getItem('nido.lineHeight'));
                            const baseline = Number(source.dataset.rowBaseline);
                            const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
                            samples.push({
                                top: (Number(row[1]) - 1) * height - Number(args[2]) - phase,
                                at: performance.now()
                            });
                        }
                    }
                    Reflect.apply(draw, ctx, args);
                }) as typeof draw;
            });
            const box = (await canvas.boundingBox())!;
            await page.mouse.move(box.x + 200, box.y + 200);
            await canvas.evaluate(async () => {
                window.dispatchEvent(new Event('focus'));
                for (let i = 0; i < 2; i++) {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                }
            });
            const documentTop = (): Promise<number> =>
                page.evaluate(
                    () =>
                        (
                            window as unknown as {
                                fastWheelPositions: { top: number }[];
                            }
                        ).fastWheelPositions.at(-1)!.top
                );
            const start = await documentTop();
            if (prefetchFirst) {
                // A small upward gesture starts a refill before the sustained touchpad input.
                await canvas.evaluate((node) =>
                    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }))
                );
                await expect
                    .poll(() =>
                        running.evaluate(
                            () =>
                                (globalThis as unknown as { wheelPrefetch: { calls: number } })
                                    .wheelPrefetch.calls
                        )
                    )
                    .toBe(1);
            }
            // Native wheel events exercise Chromium's coalescing and React's input path.
            const pending: Promise<void>[] = [];
            for (let i = 0; i < 60; i++) {
                pending.push(page.mouse.wheel(0, delta));
                await new Promise((resolve) => setTimeout(resolve, 4));
            }
            await Promise.all(pending);
            const positions = await page.evaluate(() => {
                const { fastWheelPositions: samples, fastWheelEvents: wheels } =
                    window as unknown as {
                        fastWheelPositions: { top: number; at: number }[];
                        fastWheelEvents: number[];
                    };
                const halfway = (wheels[0] + wheels.at(-1)!) / 2;
                return samples.filter(({ at }) => at >= halfway && at <= wheels.at(-1)!);
            });
            expect(new Set(positions.map(({ top }) => Math.round(top))).size).toBeGreaterThan(3);
            expect((positions.at(-1)!.top - positions[0].top) * Math.sign(delta)).toBeGreaterThan(
                100
            );
            await running.evaluate(() => {
                (
                    globalThis as unknown as { wheelPrefetch: { release: () => void } }
                ).wheelPrefetch.release();
            });
            // Finishing a late refill must preserve the full gesture, including its initial step.
            const target = start + delta * 60 - (prefetchFirst ? 1 : 0);
            const pixel = await page.evaluate(() => 1 / devicePixelRatio);
            await expect
                .poll(async () => Math.abs((await documentTop()) - target))
                .toBeLessThanOrEqual(pixel + 0.01);
        } finally {
            await running.evaluate(() => {
                (
                    globalThis as unknown as { wheelPrefetch?: { release: () => void } }
                ).wheelPrefetch?.release();
            });
            await running.close();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
