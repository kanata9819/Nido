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
