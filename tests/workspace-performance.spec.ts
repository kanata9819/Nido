import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('restored workspaces start and switch without losing their editor or explorer state', async () => {
    test.setTimeout(120000);
    const root = await mkdtemp(join(tmpdir(), 'nido-workspace-performance-'));
    const workspaces = [] as {
        root: string;
        files: { path: string; line: number; column: number }[];
        current: string;
    }[];
    const measurements: { startup: number; firstSwitch: number; warmSwitch: number }[] = [];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        for (let index = 0; index < 4; index++) {
            const folder = join(root, `Project${index + 1}`);
            await mkdir(folder);
            await Promise.all(
                Array.from({ length: 150 }, (_, file) =>
                    writeFile(join(folder, `file${file}.txt`), `Project${index + 1} file${file}\n`)
                )
            );
            const current = join(folder, 'file0.txt');
            workspaces.push({
                root: folder,
                files: [{ path: current, line: 1, column: 0 }],
                current
            });
        }
        for (let sample = 0; sample < 3; sample++) {
            const profile = join(root, `profile${sample}`);
            await mkdir(profile);
            await writeFile(
                join(profile, 'workspaces.json'),
                JSON.stringify({
                    version: 1,
                    workspaces,
                    active: 3,
                    window: { width: 1200, height: 850, maximized: false }
                })
            );
            const started = performance.now();
            const running = await electron.launch({
                args: ['.', `--user-data-dir=${profile}`],
                env
            });
            try {
                const page = await running.firstWindow();
                await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(4);
                expect(
                    await page
                        .getByRole('tab', { name: /^Workspace / })
                        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label')))
                ).toEqual([1, 2, 3, 4].map((index) => `Workspace Project${index}`));
                await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
                await expect(page.locator('canvas:visible')).toHaveAttribute(
                    'aria-description',
                    /Project4 file0/
                );
                const startup = performance.now() - started;
                await page.evaluate(() => {
                    const timings: number[] = [];
                    Object.assign(window, { workspaceSwitchTimings: timings });
                    let started = 0;
                    let target = '';
                    document.addEventListener(
                        'keydown',
                        (event) => {
                            if (event.altKey && /^[1-4]$/.test(event.key)) {
                                started = performance.now();
                                target = `Project${event.key} file0`;
                            }
                        },
                        true
                    );
                    const fill = CanvasRenderingContext2D.prototype.fillRect;
                    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
                        fill.call(this, x, y, width, height);
                        // Cached workspaces do not rewrite their accessibility description.
                        // Measure the completed visible paint, including warm switches.
                        if (
                            target &&
                            x === 0 &&
                            y === 0 &&
                            width > 100 &&
                            height > 100 &&
                            this.canvas instanceof HTMLCanvasElement &&
                            this.canvas.clientHeight
                        ) {
                            const canvas = this.canvas;
                            queueMicrotask(() => {
                                if (
                                    target &&
                                    canvas.clientHeight &&
                                    canvas.getAttribute('aria-description')?.includes(target)
                                ) {
                                    timings.push(performance.now() - started);
                                    target = '';
                                }
                            });
                        }
                    };
                });
                const switching = async (indices: number[]): Promise<number> => {
                    await page.evaluate(() => {
                        (
                            window as unknown as { workspaceSwitchTimings: number[] }
                        ).workspaceSwitchTimings.length = 0;
                    });
                    for (const [step, index] of indices.entries()) {
                        await page.keyboard.press(`Alt+${index}`);
                        await expect(page.locator('canvas:visible')).toHaveAttribute(
                            'aria-description',
                            new RegExp(`Project${index} file0`)
                        );
                        await expect(
                            page.getByRole('textbox', { name: 'Neovim input' })
                        ).toBeFocused();
                        await expect
                            .poll(() =>
                                page.evaluate(
                                    () =>
                                        (window as unknown as { workspaceSwitchTimings: number[] })
                                            .workspaceSwitchTimings.length
                                )
                            )
                            .toBe(step + 1);
                    }
                    const times = await page.evaluate(
                        () =>
                            (window as unknown as { workspaceSwitchTimings: number[] })
                                .workspaceSwitchTimings
                    );
                    expect(times).toHaveLength(indices.length);
                    return times.reduce((sum, time) => sum + time, 0) / times.length;
                };
                const firstSwitch = await switching([1, 2, 3, 4]);
                await expect(page.getByRole('treeitem')).toHaveCount(150);
                const warmSwitch = await switching([1, 2, 3, 4, 1, 2, 3, 4]);
                measurements.push({ startup, firstSwitch, warmSwitch });
                await page.getByRole('treeitem', { name: 'file10.txt', exact: true }).click();
                await expect(page.locator('canvas:visible')).toHaveAttribute(
                    'aria-description',
                    /Project4 file10/
                );
                await page.keyboard.press('Alt+1');
                await page.evaluate(async () => {
                    const restored = await window.nido.restoreWorkspaces();
                    await window.nido.fileAction(
                        restored.workspaces[3].id,
                        'createFile',
                        'new.txt'
                    );
                });
                await page.keyboard.press('Alt+4');
                await expect(page.locator('canvas:visible')).toHaveAttribute(
                    'aria-description',
                    /Project4 file10/
                );
                await expect(
                    page.getByRole('treeitem', { name: 'new.txt', exact: true })
                ).toBeVisible();
                // Keep every timing sample's fixture identical.
                await rm(join(workspaces[3].root, 'new.txt'));
            } finally {
                await running.evaluate(({ app }) => app.exit(0));
                await running.close();
            }
        }
        const median = (values: number[]): number => values.sort((a, b) => a - b)[1];
        const result = {
            fixture: '4 workspaces, 150 files each, 3 samples',
            startupMs: median(measurements.map((m) => m.startup)),
            firstSwitchMs: median(measurements.map((m) => m.firstSwitch)),
            warmSwitchMs: median(measurements.map((m) => m.warmSwitch)),
            measurements
        };
        console.log(JSON.stringify(result));
        await mkdir('test-results', { recursive: true });
        await writeFile('test-results/workspace-performance.json', JSON.stringify(result, null, 2));
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
