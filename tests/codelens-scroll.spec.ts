import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { installRowImageProbe } from './helpers/row-image-probe';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const scale of [1, 1.25, 1.5]) {
    test(`CodeLens rows keep touchpad positions continuous at ${scale * 100}% scale`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-codelens-cadence-'));
        const profile = join(root, 'profile');
        const file = join(root, 'rows.txt');
        await mkdir(profile);
        await writeFile(
            file,
            Array.from({ length: 500 }, (_, i) => `ROW_${i + 1} example(argument)`).join('\n')
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
        const env = Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined
            )
        );
        delete env.ELECTRON_RUN_AS_NODE;
        const running = await electron.launch({
            args: ['.', `--user-data-dir=${profile}`, `--force-device-scale-factor=${scale}`],
            env
        });
        try {
            const page = await running.firstWindow();
            await page.addInitScript(installRowImageProbe);
            await page.reload();
            const canvas = page.locator('canvas:visible');
            await expect(canvas).toHaveAttribute('aria-description', /ROW_1 /);
            const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
            const id = restored.workspaces[0].id;
            await page.evaluate(
                (id) =>
                    window.nido.input(
                        id,
                        ":lua local ns=vim.api.nvim_create_namespace('scroll-lens-test'); for row=0,499,4 do vim.api.nvim_buf_set_extmark(0,ns,row,0,{virt_lines={{{'  Run Tests','NidoCodeLens'},{' (gR) | Debug (gD)','NidoCodeLensHint'}}},virt_lines_above=true}) end; vim.cmd.redraw()<CR>"
                    ),
                id
            );
            await canvas.evaluate((node: HTMLCanvasElement) => {
                const context = node.getContext('2d')!;
                const draw = context.drawImage.bind(context);
                const probe = { input: 0, samples: [] as { y: number; input: number }[] };
                Object.assign(window, { lensScrollProbe: probe });
                node.addEventListener('wheel', (event) => (probe.input += event.deltaY));
                context.drawImage = ((...args: unknown[]) => {
                    const source = args[0];
                    if (
                        args.length === 5 &&
                        source instanceof HTMLCanvasElement &&
                        /ROW_110(?:\D|$)/.test(source.dataset.rowText ?? '')
                    ) {
                        probe.samples.push({ y: Number(args[2]), input: probe.input });
                    }
                    Reflect.apply(draw, context, args);
                }) as typeof draw;
            });
            for (const mode of ['normal', 'insert']) {
                await page.evaluate((id) => window.nido.input(id, '<Esc>100Gzt'), id);
                if (mode === 'insert') await page.evaluate((id) => window.nido.input(id, 'i'), id);
                await page.waitForTimeout(250);
                for (const delta of [2, -2]) {
                    const samples = await canvas.evaluate(async (node, delta) => {
                        const probe = (
                            window as unknown as {
                                lensScrollProbe: {
                                    input: number;
                                    samples: { y: number; input: number }[];
                                };
                            }
                        ).lensScrollProbe;
                        const last = probe.samples.at(-1)!;
                        probe.samples = [{ y: last.y, input: 0 }];
                        probe.input = 0;
                        for (let frame = 0; frame < 90; frame++) {
                            await new Promise(requestAnimationFrame);
                            node.dispatchEvent(
                                new WheelEvent('wheel', { bubbles: true, deltaY: delta })
                            );
                        }
                        await new Promise((resolve) => setTimeout(resolve, 300));
                        return probe.samples;
                    }, delta);
                    const steps = samples.slice(1).map((sample, index) => ({
                        movement: Math.sign(delta) * (samples[index].y - sample.y),
                        input: Math.sign(delta) * (sample.input - samples[index].input) * 0.5
                    }));
                    const distance = Math.sign(delta) * (samples[0].y - samples.at(-1)!.y);
                    console.log('codelens-scroll', {
                        scale,
                        mode,
                        delta,
                        distance,
                        paints: samples.length,
                        minStep: Math.min(...steps.map((step) => step.movement)),
                        maxExcess: Math.max(...steps.map((step) => step.movement - step.input))
                    });
                    expect(samples.length).toBeGreaterThan(30);
                    expect(
                        distance,
                        'the gesture must move the viewport through a CodeLens row'
                    ).toBeGreaterThan(60);
                    expect(steps.every((step) => step.movement >= -0.01)).toBe(true);
                    expect(
                        Math.max(...steps.map((step) => step.movement - step.input)),
                        'crossing a CodeLens row or settling must not add an unrequested jump'
                    ).toBeLessThanOrEqual(1 / scale + 0.01);
                }
            }
        } finally {
            await running.close();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
