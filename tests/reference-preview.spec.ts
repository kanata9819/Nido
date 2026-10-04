import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReferencePreview } from '../src/shared/types';

type PendingPreview = {
    index: number;
    resolve: (value: ReferencePreview) => void;
};

for (const animations of [true, false]) {
    test(`reference previews preserve their frame and respect animations=${animations}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-reference-preview-'));
        const profile = join(root, 'profile');
        const file = join(root, 'example.txt');
        await mkdir(profile);
        await writeFile(file, 'reference preview fixture\n');
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
        const running = await electron.launch({
            executablePath,
            args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
            env
        });
        try {
            const page = await running.firstWindow();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            if (!animations) {
                await page.getByRole('button', { name: 'Settings', exact: true }).click();
                await page.getByRole('checkbox', { name: 'UI animations' }).uncheck();
                await page.keyboard.press('Escape');
            }
            await running.evaluate(({ ipcMain }) => {
                const requests: PendingPreview[] = [];
                Object.assign(globalThis, { referencePreviewRequests: requests });
                ipcMain.removeHandler('nido:previewReference');
                ipcMain.handle(
                    'nido:previewReference',
                    (_event, _id, index: number) =>
                        new Promise<ReferencePreview>((resolve) =>
                            requests.push({ index, resolve })
                        )
                );
            });
            const pending = async (index: number): Promise<void> => {
                await expect
                    .poll(() =>
                        running.evaluate((_electron, requested) => {
                            const requests = (
                                globalThis as unknown as {
                                    referencePreviewRequests: PendingPreview[];
                                }
                            ).referencePreviewRequests;
                            return requests.some((request) => request.index === requested);
                        }, index)
                    )
                    .toBe(true);
            };
            const resolvePreview = async (index: number): Promise<void> => {
                await pending(index);
                await running.evaluate((_electron, requested) => {
                    const requests = (
                        globalThis as unknown as { referencePreviewRequests: PendingPreview[] }
                    ).referencePreviewRequests;
                    const request = requests.splice(
                        requests.findIndex((request) => request.index === requested),
                        1
                    )[0];
                    const count = requested === 2 ? 3 : 17;
                    request.resolve({
                        first: requested * 20,
                        line: requested * 20 + 1,
                        lines: Array.from({ length: count }, (_, line) => [
                            { text: `RESULT_${requested}_LINE_${line}`, color: '#a8cf9e' }
                        ])
                    });
                }, index);
            };
            const restored = await page.evaluate(() => window.nido.restoreWorkspaces());
            const references = JSON.stringify({
                version: 1,
                loading: false,
                error: '',
                items: [1, 2, 3].map((index) => ({
                    path: join(root, `reference-${index}.txt`),
                    line: index * 20 + 1,
                    column: 1,
                    text: `Reference ${index}`
                }))
            });
            await page.evaluate(
                ({ id, references }) =>
                    window.nido.input(
                        id,
                        `:lua vim.rpcnotify(vim.g.nido_channel, 'nido:references', vim.fn.json_decode([[${references}]]))<CR>`
                    ),
                { id: restored.active, references }
            );
            const list = page.getByRole('listbox', { name: 'Reference results' });
            const preview = page.getByRole('region', { name: 'Reference preview', exact: true });
            await expect(list).toBeFocused();
            await resolvePreview(1);
            await expect(preview.locator('[data-current="true"]')).toHaveText('21RESULT_1_LINE_1');
            const bounds = await preview.boundingBox();
            // Inspect the actual animated content halfway through its transition.
            await preview.evaluate((node) => {
                node.setAttribute('data-persistent-frame', 'true');
                const content = node.firstElementChild!;
                content.setAttribute('data-persistent-content', 'true');
                const measurement = { removed: false, animations: 0, pause: true };
                Object.assign(window, { referenceMeasurement: measurement });
                new MutationObserver((mutations) => {
                    if (
                        mutations.some((mutation) =>
                            [...mutation.removedNodes].some(
                                (removed) => removed === node || removed === content
                            )
                        )
                    ) {
                        measurement.removed = true;
                    }
                }).observe(node.parentElement!, { childList: true, subtree: true });
                const animate = Element.prototype.animate;
                Element.prototype.animate = function (...args) {
                    const animation = animate.apply(this, args);
                    if (node.contains(this)) {
                        measurement.animations++;
                        if (measurement.pause) {
                            animation.pause();
                            animation.currentTime =
                                Number(animation.effect!.getTiming().duration) / 2;
                        }
                    }
                    return animation;
                };
            });
            await page.keyboard.press('j');
            await pending(2);
            await expect(preview).toHaveAttribute('aria-busy', 'true');
            await expect(preview.locator('header')).toContainText('reference-1.txt');
            await expect(preview.locator('[data-current="true"]')).toContainText('RESULT_1');
            await expect(preview).not.toContainText('Loading preview');
            expect(await preview.boundingBox()).toEqual(bounds);
            await resolvePreview(2);
            await expect(preview.locator('[data-current="true"]')).toContainText('RESULT_2');
            await expect(preview).toHaveAttribute('data-persistent-frame', 'true');
            await expect(preview.locator(':scope > div')).toHaveCount(1);
            await expect(preview.locator(':scope > div')).toHaveAttribute(
                'data-persistent-content',
                'true'
            );
            expect(await preview.boundingBox()).toEqual(bounds);
            const motion = await preview.evaluate((node) => ({
                frame: node.getAnimations().length,
                layers: node.getAnimations({ subtree: true }).map((animation) => {
                    const target = (animation.effect as KeyframeEffect).target as HTMLElement;
                    return Number(getComputedStyle(target).opacity);
                }),
                measurement: (
                    window as unknown as {
                        referenceMeasurement: { removed: boolean; animations: number };
                    }
                ).referenceMeasurement
            }));
            expect(motion.frame).toBe(0);
            expect(motion.measurement.removed).toBe(false);
            // Old text must not show through the new result during the transition.
            await expect(preview).not.toContainText('RESULT_1');
            expect(motion.measurement.animations).toBe(animations ? 1 : 0);
            expect(motion.layers).toHaveLength(animations ? 1 : 0);
            for (const opacity of motion.layers) {
                expect(opacity).toBeGreaterThan(0);
                expect(opacity).toBeLessThan(1);
            }
            await page.screenshot({ path: `test-results/reference-transition-${animations}.png` });
            if (animations) {
                for (const [key, index] of [
                    ['j', 3],
                    ['k', 2]
                ] as const) {
                    await page.keyboard.press(key);
                    await resolvePreview(index);
                    await expect(preview.locator('[data-current="true"]')).toContainText(
                        `RESULT_${index}`
                    );
                    expect(await preview.boundingBox()).toEqual(bounds);
                    expect(
                        await preview.evaluate(
                            (node) => node.getAnimations({ subtree: true }).length
                        )
                    ).toBe(1);
                    await expect(preview.locator('header')).toHaveCount(1);
                    await expect(preview).not.toContainText(`RESULT_${index === 2 ? 3 : 2}`);
                }
                // Changing the OS motion preference also stops an in-flight transition.
                await page.emulateMedia({ reducedMotion: 'reduce' });
                await expect(preview.locator('header')).toHaveCount(1);
                expect(
                    await preview.evaluate((node) => node.getAnimations({ subtree: true }).length)
                ).toBe(0);
                await page.emulateMedia({ reducedMotion: 'no-preference' });
            }
            await preview.evaluate((node) => {
                (
                    window as unknown as { referenceMeasurement: { pause: boolean } }
                ).referenceMeasurement.pause = false;
                node.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
            });
            await expect(preview.locator('header')).toHaveCount(1);

            // A slow response for a skipped result must not replace the latest selection.
            await page.keyboard.press('j');
            await pending(3);
            await page.keyboard.press('k');
            await pending(2);
            await resolvePreview(2);
            await resolvePreview(3);
            await expect(preview).toHaveAttribute('aria-busy', 'false');
            await expect(preview.locator('[data-current="true"]')).toContainText('RESULT_2');
            await expect(preview.locator('header')).toContainText('reference-2.txt');
            expect(await preview.boundingBox()).toEqual(bounds);

            await page.emulateMedia({ reducedMotion: 'reduce' });
            const animatedBefore = await preview.evaluate(
                () =>
                    (
                        window as unknown as {
                            referenceMeasurement: { animations: number };
                        }
                    ).referenceMeasurement.animations
            );
            await page.keyboard.press('k');
            await resolvePreview(1);
            await expect(preview.locator('[data-current="true"]')).toContainText('RESULT_1');
            expect(
                await preview.evaluate(
                    () =>
                        (
                            window as unknown as {
                                referenceMeasurement: { animations: number };
                            }
                        ).referenceMeasurement.animations
                )
            ).toBe(animatedBefore);
            expect(await preview.boundingBox()).toEqual(bounds);
            await page.keyboard.press('j');
            await pending(2);
            await page.keyboard.press('Escape');
            await resolvePreview(2);
            await expect(preview).toBeHidden();
            expect(errors).toEqual([]);
        } finally {
            await running.evaluate(({ app }) => app.exit(0));
            await running.close();
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}
