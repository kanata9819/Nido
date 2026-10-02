import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scroll rendering reuses text and reports GPU and frame timings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-performance-'));
    const profile = join(root, 'profile');
    const file = join(root, 'dense.txt');
    await mkdir(profile);
    await writeFile(
        file,
        Array.from(
            { length: 2000 },
            (_, i) => `${i} ${'const value = example(argument); '.repeat(5)}`
        ).join('\n')
    );
    await writeFile(
        join(profile, 'workspaces.json'),
        JSON.stringify({
            version: 1,
            active: 0,
            window: { width: 1400, height: 900, maximized: false },
            workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
        })
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
    try {
        const page = await running.firstWindow();
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /const value/);
        const gpu = await running.evaluate(({ app }) => app.getGPUFeatureStatus());
        await page.evaluate(() => {
            const state = { glyphs: 0, paints: 0, cpuMs: 0, frames: [] as number[], last: 0 };
            Object.assign(window, { scrollMeasurement: state });
            const fillText = CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText = function (...args) {
                state.glyphs++;
                return fillText.apply(this, args);
            };
            const raf = window.requestAnimationFrame;
            window.requestAnimationFrame = (callback) =>
                raf((time) => {
                    const start = performance.now();
                    callback(time);
                    state.cpuMs += performance.now() - start;
                    state.paints++;
                    if (state.last) state.frames.push(time - state.last);
                    state.last = time;
                });
        });
        await page.keyboard.press('Control+d');
        await page.waitForTimeout(350);
        const animation = await page.evaluate(
            () =>
                (
                    window as unknown as {
                        scrollMeasurement: {
                            glyphs: number;
                            paints: number;
                            cpuMs: number;
                            frames: number[];
                            last: number;
                        };
                    }
                ).scrollMeasurement
        );
        console.log(
            JSON.stringify({ gpu, animation, meanPaintMs: animation.cpuMs / animation.paints })
        );
        expect(animation.paints).toBeGreaterThan(3);
        // An animation must reuse text instead of rasterizing the visible grid every frame.
        expect(animation.glyphs / animation.paints).toBeLessThan(500);
        await canvas.screenshot({ path: 'test-results/scroll-rendering.png' });
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('touchpad deltas preview before RPC, coalesce and settle without double movement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-touchpad-'));
    const profile = join(root, 'profile');
    const file = join(root, 'sample.txt');
    await mkdir(profile);
    await writeFile(file, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
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
        const canvas = page.locator('canvas:visible');
        await expect(canvas).toHaveAttribute('aria-description', /line 1/);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.waitForTimeout(300);
        await running.evaluate(({ ipcMain }) => {
            const handlers = (
                ipcMain as unknown as {
                    _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
                }
            )._invokeHandlers;
            const original = handlers.get('nido:scroll')!;
            const probe = { calls: 0, completed: 0, outstanding: 0, maxOutstanding: 0, lines: 0 };
            Object.assign(globalThis, { touchpadProbe: probe });
            handlers.set('nido:scroll', async (...args) => {
                probe.calls++;
                probe.outstanding++;
                probe.lines += Number(args[2]);
                probe.maxOutstanding = Math.max(probe.maxOutstanding, probe.outstanding);
                try {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    return await original(...args);
                } finally {
                    probe.completed++;
                    probe.outstanding--;
                }
            });
        });
        await canvas.evaluate((node: HTMLCanvasElement) => {
            const work = { trims: 0, descriptions: 0, paints: 0, cpuMs: 0 };
            Object.assign(window, { scrollWork: work });
            const trim = String.prototype.trim;
            String.prototype.trim = function () {
                work.trims++;
                return trim.call(this);
            };
            const attribute = node.setAttribute.bind(node);
            node.setAttribute = (name, value) => {
                if (name === 'aria-description') work.descriptions++;
                attribute(name, value);
            };
            const raf = window.requestAnimationFrame;
            window.requestAnimationFrame = (callback) =>
                raf((time) => {
                    const start = performance.now();
                    callback(time);
                    work.cpuMs += performance.now() - start;
                    work.paints++;
                });
            node.dataset.offsets = '0';
            node.dataset.states = '0';
            window.nido.onEvent((event) => {
                if (event.type === 'state')
                    node.dataset.states = String(Number(node.dataset.states) + 1);
                if (event.type === 'redraw')
                    for (const [name, ...calls] of event.events)
                        if (name === 'nido_pixel_scroll' && calls.some((args) => args[1] === true))
                            node.dataset.offsets = String(Number(node.dataset.offsets) + 1);
            });
            const context = node.getContext('2d')!;
            let first = true;
            const fill = context.fillRect.bind(context);
            context.fillRect = (x, y, width, height) => {
                if (x === 0 && y === 0 && height > 100) first = true;
                fill(x, y, width, height);
            };
            const draw = context.drawImage.bind(context);
            context.drawImage = ((...args: Parameters<typeof draw>) => {
                if (first && args.length === 5) {
                    node.dataset.firstY = String(args[2]);
                    first = false;
                }
                draw(...args);
            }) as typeof draw;
        });
        const burst = (count: number, delta: number) =>
            canvas.evaluate(
                (node, { count, delta }) => {
                    for (let i = 0; i < count; i++)
                        node.dispatchEvent(
                            new WheelEvent('wheel', {
                                bubbles: true,
                                deltaMode: 0,
                                deltaY: delta
                            })
                        );
                },
                { count, delta }
            );
        await burst(40, 0.01);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-y')))
            .toBeCloseTo(-0.4, 5);
        expect(await canvas.getAttribute('data-offsets')).toBe('0');
        await burst(15, -0.01);
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-y')))
            .toBeCloseTo(-0.25, 5);
        await expect
            .poll(() =>
                running.evaluate(
                    () =>
                        (globalThis as unknown as { touchpadProbe: { completed: number } })
                            .touchpadProbe.completed
                )
            )
            .toBe(2);
        await expect(canvas).toHaveAttribute('data-offsets', '2');
        await expect
            .poll(async () => Number(await canvas.getAttribute('data-first-y')))
            .toBeCloseTo(-0.25, 5);
        expect(await canvas.getAttribute('data-states')).toBe('0');
        const work = await page.evaluate(
            () =>
                (
                    window as unknown as {
                        scrollWork: {
                            trims: number;
                            descriptions: number;
                            paints: number;
                            cpuMs: number;
                        };
                    }
                ).scrollWork
        );
        console.log('fractional-scroll-work', work);
        expect(work.trims).toBe(0);
        expect(work.descriptions).toBe(0);
        const probe = await running.evaluate(
            () =>
                (
                    globalThis as unknown as {
                        touchpadProbe: { calls: number; maxOutstanding: number; lines: number };
                    }
                ).touchpadProbe
        );
        expect(probe.calls).toBe(2);
        expect(probe.maxOutstanding).toBe(1);
        const rowHeight = await canvas.evaluate((node) =>
            Math.ceil(
                Number((node as HTMLCanvasElement).getContext('2d')!.font.match(/([\d.]+)px/)![1]) *
                    1.65
            )
        );
        expect(probe.lines * rowHeight).toBeCloseTo(0.25, 6);
        await canvas.screenshot({ path: 'test-results/touchpad-fractional-scroll.png' });
        // A combined burst can exceed the IPC limit; send bounded chunks without losing distance.
        await burst(2, 20000);
        await expect
            .poll(() =>
                running.evaluate(
                    () =>
                        (globalThis as unknown as { touchpadProbe: { completed: number } })
                            .touchpadProbe.completed
                )
            )
            .toBe(4);
        expect(
            (await running.evaluate(
                () =>
                    (globalThis as unknown as { touchpadProbe: { lines: number } }).touchpadProbe
                        .lines
            )) * rowHeight
        ).toBeCloseTo(40000.25, 5);
        expect(errors).toEqual([]);
    } finally {
        await running.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
