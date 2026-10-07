import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;
const diagnosticItems = [
    {
        path: '/alpha/src/main.rs',
        line: 42,
        column: 18,
        severity: 1,
        source: 'rustc',
        code: 'E0277',
        message:
            'The trait bound `String: From<u8>` is not satisfied\n`String` implements `From<&str>`.\n\nConsider converting the byte to a character first.'
    },
    {
        path: '/alpha/src/main.rs',
        line: 42,
        column: 7,
        severity: 2,
        source: 'rustc',
        code: 'unused_parens',
        message:
            'Unnecessary parentheses around function argument\n`#[warn(unused_parens)]` is enabled by default.'
    }
];
async function showDiagnosticCard(page: Page): Promise<void> {
    await page.evaluate(
        (items) =>
            window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: true }),
        diagnosticItems
    );
}
async function pauseRendererClock(page: Page): Promise<void> {
    // Installing the clock alone still lets CI wall time advance timers. Pause before mounting.
    await page.clock.install({ time: new Date(0) });
    await page.clock.pauseAt(new Date(1000));
}

test.beforeAll(async () => {
    server = await createServer({
        configFile: false,
        root: resolve('tests/renderer'),
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd()] } }
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
});
test.afterAll(async () => {
    await server?.close();
});

test('native diagnostic cards show severity, source, codes and safe selectable text with keyboard navigation', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(editor).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'diagnostics',
            focus: true,
            id: 'other',
            items: [
                {
                    path: '',
                    line: 1,
                    column: 1,
                    severity: 1,
                    source: '',
                    code: '',
                    message: 'Wrong workspace'
                }
            ]
        })
    );
    const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
    await expect(popup).toHaveCount(0);
    await page.evaluate(
        (items) =>
            window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
        diagnosticItems
    );
    await expect(popup).toBeVisible();
    await expect(editor).toBeFocused();
    await showDiagnosticCard(page);
    const content = page.getByLabel('Diagnostic content', { exact: true });
    await expect(content).toBeFocused();
    await expect(popup).toContainText('main.rs');
    await expect(popup).toContainText('Ln 42, Col 18');
    await expect(popup).toContainText('2 on this line');
    await expect(content.locator('article[data-severity="error"]')).toContainText('E0277');
    await expect(content.locator('article[data-severity="warning"]')).toContainText(
        'unused_parens'
    );
    await expect(content.locator('h3 code').first()).toHaveText('String: From<u8>');
    await content
        .locator('h3')
        .first()
        .evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
        });
    await page.keyboard.press('Control+c');
    await expect(popup).toBeVisible();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.keyboard.type(']d');
    await page.keyboard.type('2[d');
    await page.keyboard.type(']');
    await page.evaluate(
        (items) =>
            window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
        diagnosticItems
    );
    await page.keyboard.type('d');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'input')
                    .map((call) => call.args[1])
            )
        )
        .toEqual([']d', '2[d', ']d']);
    await page.keyboard.press('Tab');
    await expect(
        popup.getByRole('button', { name: 'Previous diagnostic', exact: true })
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)
                        ?.args[1]
            )
        )
        .toBe('[d');
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'diagnostics',
            focus: true,
            id: 'alpha',
            items: [
                {
                    path: '',
                    line: 1,
                    column: 1,
                    severity: 4,
                    source: '',
                    code: '',
                    message:
                        '<script>window.diagnosticUnsafe = true</script>\n![Remote](https://example.com/image.png)'
                }
            ]
        })
    );
    await expect(popup).toContainText('<script>');
    await expect(popup.locator('script, img, a')).toHaveCount(0);
    expect(await page.evaluate(() => 'diagnosticUnsafe' in window)).toBe(false);
    await page.keyboard.press('Control+c');
    await expect(popup).toHaveCount(0);
    await expect(editor).toBeFocused();
});

test('diagnostic cards scroll long messages, stay inside the editor and clear on replacement or invalidation', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(editor).toBeFocused();
    await page.evaluate(
        (items) =>
            window.rendererTest.emit({
                type: 'diagnostics',
                focus: true,
                id: 'alpha',
                items: [
                    {
                        ...items[0],
                        message:
                            items[0].message + '\n' + 'Detailed compiler explanation.\n'.repeat(60)
                    }
                ]
            }),
        diagnosticItems
    );
    const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
    const content = page.getByLabel('Diagnostic content', { exact: true });
    await expect(content).toBeFocused();
    await page.keyboard.press('Control+d');
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect
        .poll(() =>
            content.evaluate((node) =>
                Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)
            )
        )
        .toBeLessThan(2);
    await page.keyboard.press('Home');
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
    await page.setViewportSize({ width: 680, height: 460 });
    await expect
        .poll(() =>
            popup.evaluate((node) => {
                const host = node.parentElement!.getBoundingClientRect();
                const rect = node.getBoundingClientRect();
                return (
                    rect.left >= host.left &&
                    rect.top >= host.top &&
                    rect.right <= host.right &&
                    rect.bottom <= host.bottom
                );
            })
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'hover',
            id: 'alpha',
            markdown: 'Replacement type information',
            filetype: 'rust',
            codeBlocks: []
        })
    );
    await expect(popup).toHaveCount(0);
    await expect(page.getByLabel('Type information content', { exact: true })).toBeFocused();
    await showDiagnosticCard(page);
    await expect(page.getByRole('dialog', { name: 'Type information', exact: true })).toHaveCount(
        0
    );
    await expect(content).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items: [], focus: false })
    );
    await expect(popup).toHaveCount(0);
    await expect(editor).toBeFocused();
    await showDiagnosticCard(page);
    await page.locator('canvas:visible').click({ position: { x: 2, y: 2 } });
    await expect(popup).toHaveCount(0);
    await expect(editor).toBeFocused();
});

test('Japanese diagnostics use translated labels and leave compiler text intact', async ({
    page
}) => {
    await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
    await showDiagnosticCard(page);
    const popup = page.getByRole('dialog', { name: '診断の詳細', exact: true });
    await expect(popup).toContainText('エラー');
    await expect(popup).toContainText('警告');
    await expect(popup).toContainText('42 行、18 列');
    await expect(popup).toContainText('The trait bound');
    await expect(popup.getByRole('button', { name: '次の診断', exact: true })).toBeVisible();
});

test('slow startup shows loading through restoration until the first completed editor paint', async ({
    page
}) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces,attach`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    // A slow test runner must not advance the renderer's controlled startup clock.
    await delay(300);
    const loading = page.getByRole('status', { name: 'Loading workspaces…' });
    await page.clock.runFor(100);
    await expect(loading).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toHaveCount(0);
    await page.clock.runFor(150);
    await expect(loading).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.settle('restoreWorkspaces', 0, {
            workspaces: [{ id: 'alpha', root: '/alpha', name: 'Alpha' }],
            active: 'alpha',
            errors: []
        })
    );
    await page.clock.runFor(50);
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'attach')
            )
        )
        .toBe(true);
    await expect(loading).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                ['grid_resize', [1, 40, 10]],
                ['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 0])]]
            ]
        })
    );
    await page.clock.runFor(50);
    await expect(loading).toBeVisible();
    await page.screenshot({ path: 'test-results/workspace-loading.png' });
    await page.evaluate(() => {
        window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['flush']] });
        window.rendererTest.settle('attach', 0, undefined);
    });
    await page.clock.runFor(50);
    await expect(loading).toHaveCount(0);
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
});

test('fast startup never flashes a loading indicator', async ({ page }) => {
    await pauseRendererClock(page);
    await page.addInitScript(() => {
        Object.assign(window, { loadingScreens: 0 });
        new MutationObserver((records) => {
            const selector = '[role="status"][aria-label="Loading workspaces…"]';
            for (const record of records)
                for (const node of record.addedNodes) {
                    if (
                        node instanceof Element &&
                        (node.matches(selector) || node.querySelector(selector))
                    ) {
                        (window as unknown as { loadingScreens: number }).loadingScreens++;
                    }
                }
        }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.clock.runFor(100);
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
    await page.clock.runFor(500);
    expect(
        await page.evaluate(() => (window as unknown as { loadingScreens: number }).loadingScreens)
    ).toBe(0);
});

test('failed restoration dismisses Japanese loading and returns to the welcome screen', async ({
    page
}) => {
    await pauseRendererClock(page);
    await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.clock.runFor(250);
    const loading = page.getByRole('status', { name: 'ワークスペースを読み込み中…' });
    await expect(loading).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.settle('restoreWorkspaces', 0, 'Restore failed', true)
    );
    await page.clock.runFor(50);
    await expect(loading).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'ここから、あなたのコードを。' })).toBeVisible();
    await expect(page.getByText('Restore failed', { exact: true })).toBeVisible();
});

test('failed editor attachment dismisses loading and displays the error', async ({ page }) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=app&defer=attach`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.clock.runFor(250);
    const loading = page.getByRole('status', { name: 'Loading workspaces…' });
    await expect(loading).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.settle('attach', 0, 'Editor startup failed', true)
    );
    await page.clock.runFor(50);
    await expect(loading).toHaveCount(0);
    await expect(page.getByText('Editor startup failed', { exact: true })).toBeVisible();
});

for (const scale of [1, 1.25, 1.5]) {
    test(`editor canvas fits physical pixels at ${scale * 100}% scale`, async ({ browser }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/canvas-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}canvas-probe`);
            const samples = await page.evaluate(
                async (moduleUrl) => {
                    const { alignCanvasSurface } = await import(moduleUrl);
                    const host = document.createElement('div');
                    host.style.cssText =
                        'position:absolute;left:31.3px;top:27.7px;width:413.3px;height:171.7px';
                    const canvas = document.createElement('canvas');
                    canvas.style.position = 'absolute';
                    host.append(canvas);
                    document.body.append(host);
                    return [31.3, 42.7].map((left) => {
                        host.style.left = `${left}px`;
                        const surface = alignCanvasSurface(canvas, host, devicePixelRatio);
                        canvas.width = Math.round(surface.width * devicePixelRatio);
                        canvas.height = Math.round(surface.height * devicePixelRatio);
                        const observer = new MutationObserver(() => {});
                        observer.observe(canvas, { attributes: true, attributeFilter: ['style'] });
                        alignCanvasSurface(canvas, host, devicePixelRatio);
                        const repeatedWrites = observer.takeRecords().length;
                        observer.disconnect();
                        const bounds = canvas.getBoundingClientRect();
                        const parent = host.getBoundingClientRect();
                        return {
                            edges: [bounds.left, bounds.top, bounds.right, bounds.bottom].map(
                                (value) => value * devicePixelRatio
                            ),
                            width: bounds.width * devicePixelRatio - canvas.width,
                            height: bounds.height * devicePixelRatio - canvas.height,
                            repeatedWrites,
                            inside:
                                bounds.left >= parent.left &&
                                bounds.top >= parent.top &&
                                bounds.right <= parent.right &&
                                bounds.bottom <= parent.bottom
                        };
                    });
                },
                `/@fs/${resolve('src/renderer/src/canvasSurface.ts').replaceAll('\\', '/')}`
            );
            for (const sample of samples) {
                for (const edge of sample.edges)
                    expect(Math.abs(edge - Math.round(edge))).toBeLessThan(0.025);
                expect(Math.abs(sample.width)).toBeLessThan(0.025);
                expect(Math.abs(sample.height)).toBeLessThan(0.025);
                expect(sample.inside).toBe(true);
                expect(sample.repeatedWrites).toBe(0);
            }
        } finally {
            await context.close();
        }
    });

    test(`resting editor text has no color fringes or resampling at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/canvas-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}canvas-probe`);
            const samples = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const grid = new Grid();
                    grid.background = '#111111';
                    grid.foreground = '#ffffff';
                    grid.busy = true;
                    grid.pixelScrollEnabled = true;
                    grid.apply([
                        ['grid_resize', [1, 40, 6]],
                        [
                            'hl_attr_define',
                            [1, { bold: true }, {}, []],
                            [2, { italic: true }, {}, []]
                        ],
                        ...[0, 1, 2, 3].map((row) => [
                            'grid_line',
                            [
                                1,
                                row,
                                0,
                                Array.from('alacritty(options)?,', (text) => [text, row % 3])
                            ]
                        ]),
                        ['flush']
                    ]);
                    const canvas = document.createElement('canvas');
                    let originalRows: HTMLCanvasElement[] = [];
                    let paintedRows: HTMLCanvasElement[] = [];
                    let copies = 0;
                    let resampled = 0;
                    let colored = 0;
                    let mismatches = 0;
                    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
                    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
                        Reflect.apply(drawImage, this, args);
                        const source = args[0];
                        if (!(source instanceof HTMLCanvasElement)) return;
                        if (this.canvas !== canvas) {
                            resampled++;
                            return;
                        }
                        copies++;
                        paintedRows.push(source);
                        const top = Math.round(Number(args[2]) * devicePixelRatio);
                        // The command row can extend one physical pixel beyond the canvas.
                        const height = Math.min(source.height, canvas.height - top);
                        const expected = source
                            .getContext('2d')!
                            .getImageData(0, 0, 220, height).data;
                        const actual = this.getImageData(0, top, 220, height).data;
                        for (let i = 0; i < expected.length; i++) {
                            if (expected[i] !== actual[i]) mismatches++;
                        }
                        for (let i = 0; i < actual.length; i += 4) {
                            if (
                                Math.max(actual[i], actual[i + 1], actual[i + 2]) -
                                    Math.min(actual[i], actual[i + 1], actual[i + 2]) >
                                1
                            )
                                colored++;
                        }
                    };
                    try {
                        grid.draw(
                            canvas,
                            400,
                            114,
                            15,
                            '"Cascadia Code", Consolas, monospace',
                            false,
                            undefined,
                            19
                        );
                        originalRows = paintedRows;
                        paintedRows = [];
                        // A completed gesture may retain a fraction in Neovim's viewport.
                        grid.scrollFraction = 0.3 / (19 * devicePixelRatio);
                        grid.draw(
                            canvas,
                            400,
                            114,
                            15,
                            '"Cascadia Code", Consolas, monospace',
                            false,
                            undefined,
                            19
                        );
                    } finally {
                        CanvasRenderingContext2D.prototype.drawImage = drawImage;
                    }
                    return {
                        copies,
                        colored,
                        resampled,
                        mismatches,
                        nativeRows: paintedRows.every((row, index) => row === originalRows[index])
                    };
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            expect(samples.copies).toBe(12);
            expect(
                samples.nativeRows,
                'settled fractional scrolling must reuse the unfiltered glyphs'
            ).toBe(true);
            expect(samples.colored, 'white text on gray must not gain red or blue edges').toBe(0);
            expect(samples.resampled, 'stationary rows must not interpolate a cached bitmap').toBe(
                0
            );
            expect(
                samples.mismatches,
                'cached glyphs must reach the screen without changed pixels'
            ).toBe(0);
        } finally {
            await context.close();
        }
    });

    test(`slow pixel scrolling moves glyphs without whole-pixel jumps at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/canvas-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}canvas-probe`);
            const samples = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const grid = new Grid();
                    grid.apply([
                        ['grid_resize', [1, 40, 6]],
                        [
                            'hl_attr_define',
                            [1, { foreground: 0xffffff, background: 0x191e23 }, {}, []]
                        ],
                        ['grid_line', [1, 2, 0, Array.from('MMMMMMMMMMMM', (text) => [text, 1])]],
                        ['flush']
                    ]);
                    grid.pixelScrollEnabled = true;
                    grid.scrolling = true;
                    const canvas = document.createElement('canvas');
                    const positions: number[] = [];
                    let glyphs = 0;
                    const fillText = CanvasRenderingContext2D.prototype.fillText;
                    CanvasRenderingContext2D.prototype.fillText = function (...args) {
                        glyphs++;
                        fillText.apply(this, args);
                    };
                    let initialGlyphs = 0;
                    let nativeMismatches = 0;
                    try {
                        for (let step = 0; step <= 16; step++) {
                            const dpr = devicePixelRatio;
                            grid.scrollFraction = step / 8 / (28 * dpr);
                            grid.draw(canvas, 400, 168, 16, 'monospace', false, undefined, 28);
                            const ctx = canvas.getContext('2d')!;
                            if (step === 0) {
                                initialGlyphs = glyphs;
                                // Resting text must retain the native font raster, rather than
                                // inheriting blur from a scaled intermediate image.
                                const reference = document.createElement('canvas');
                                reference.width = Math.floor(120 * dpr);
                                reference.height = 28 * dpr;
                                const native = reference.getContext('2d', { alpha: true })!;
                                native.setTransform(dpr, 0, 0, dpr, 0, 0);
                                native.fillStyle = '#191e23';
                                native.fillRect(0, 0, 400, 28);
                                native.fillStyle = '#ffffff';
                                native.font = '16px monospace';
                                for (let column = 0; column < 12; column++) {
                                    fillText.call(
                                        native,
                                        'M',
                                        Math.round(column * grid.cellWidth * dpr) / dpr,
                                        Math.round(19 * dpr) / dpr
                                    );
                                }
                                const expected = native.getImageData(
                                    0,
                                    0,
                                    reference.width,
                                    reference.height
                                ).data;
                                const actual = ctx.getImageData(
                                    0,
                                    56 * dpr,
                                    reference.width,
                                    reference.height
                                ).data;
                                nativeMismatches = actual.reduce(
                                    (count, value, index) =>
                                        count + Number(value !== expected[index]),
                                    0
                                );
                            }
                            const top = Math.floor(40 * dpr);
                            const width = Math.floor(120 * dpr);
                            const pixels = ctx.getImageData(
                                0,
                                top,
                                width,
                                Math.ceil(48 * dpr)
                            ).data;
                            const background = pixels[0];
                            let mass = 0;
                            let moment = 0;
                            for (let offset = 0; offset < pixels.length; offset += 4) {
                                const coverage = Math.max(0, pixels[offset] - background);
                                mass += coverage;
                                moment += coverage * (top + Math.floor(offset / 4 / width));
                            }
                            positions.push(moment / mass);
                        }
                        grid.apply([
                            [
                                'grid_line',
                                [1, 2, 0, Array.from('MMMMMMMMMMMM', (text) => [text, 1])]
                            ],
                            ['flush']
                        ]);
                        grid.draw(canvas, 400, 168, 16, 'monospace', false, undefined, 28);
                    } finally {
                        CanvasRenderingContext2D.prototype.fillText = fillText;
                    }
                    return { positions, glyphs, initialGlyphs, nativeMismatches };
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            const steps = samples.positions
                .slice(1)
                .map((y, index) => samples.positions[index] - y);
            expect(steps.every((step) => step >= -0.02)).toBe(true);
            expect(
                Math.max(...steps),
                'slow gestures must not jump a whole physical pixel'
            ).toBeLessThan(0.6);
            expect(samples.positions[0] - samples.positions.at(-1)!).toBeCloseTo(2, 1);
            expect(samples.nativeMismatches, 'resting text must preserve its native pixels').toBe(
                0
            );
            expect(samples.glyphs, 'fractional positions must reuse the native glyph raster').toBe(
                samples.initialGlyphs
            );
        } finally {
            await context.close();
        }
    });
}

// The Features page is temporarily disabled; retain these tests for its return.
test.skip('Features opens without a workspace, searches built-ins and restores navigation focus', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('restoreWorkspaces', 0, {
            workspaces: [],
            active: '',
            errors: []
        })
    );
    const trigger = page.getByRole('button', { name: 'Features', exact: true });
    await trigger.click();
    const features = page.getByRole('region', { name: 'Features', exact: true });
    await expect(features.getByRole('textbox', { name: 'Search languages' })).toBeFocused();
    await features.getByRole('tab', { name: 'Built-in features', exact: true }).click();
    const search = features.getByRole('textbox', { name: 'Search features' });
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await expect(features.locator('[data-feature]')).toHaveCount(16);
    await search.fill('sticky');
    await expect(features.locator('[data-feature]')).toHaveCount(1);
    await expect(
        features.getByRole('heading', { name: 'Sticky Scroll', exact: true })
    ).toBeVisible();
    await search.fill('does-not-exist');
    await expect(features.getByText('No features match your search.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(features).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Control+Shift+x');
    await expect(features).toBeVisible();
    await page.keyboard.press('Control+Shift+x');
    await expect(features).toHaveCount(0);
});

test.skip('Features shortcut preserves the editor and supports Japanese and command palette access', async ({
    page
}) => {
    await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
    await page.goto(`${origin}?view=app`);
    const editor = page.getByRole('textbox', { name: 'Neovim入力' });
    await expect(
        page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+Shift+x');
    const features = page.getByRole('region', { name: '機能一覧', exact: true });
    const languageSearch = features.getByRole('textbox', { name: '対応言語を検索' });
    await expect(languageSearch).toBeFocused();
    await languageSearch.fill('診断');
    await expect(features.locator('[data-language]')).toHaveCount(3);
    await expect(features.getByText('Rustの導入が必要', { exact: true })).toBeVisible();
    await features.getByRole('tab', { name: 'ビルトイン機能', exact: true }).click();
    const search = features.getByRole('textbox', { name: '機能を検索' });
    await search.fill('スクロール');
    await expect(features.locator('[data-feature="sticky-scroll"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(
        page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+Shift+p');
    const palette = page.getByRole('dialog', { name: 'すべてのコマンド' });
    await palette.getByRole('textbox').fill('機能一覧');
    await palette.getByRole('button', { name: /機能一覧/ }).click();
    await expect(features).toBeVisible();
    await features.getByRole('button', { name: '機能一覧を閉じる' }).click();
    await expect(editor).toBeFocused();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) =>
                        ['input', 'closeWorkspace', 'openFile'].includes(call.method)
                    ).length
            )
        )
        .toBe(0);
});

test.skip('Languages distinguishes code tools from highlighting, shows setup and supports keyboard tabs', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    await page.keyboard.press('Control+Shift+x');
    const features = page.getByRole('region', { name: 'Features', exact: true });
    const languagesTab = features.getByRole('tab', { name: 'Languages', exact: true });
    await expect(languagesTab).toHaveAttribute('aria-selected', 'true');
    await expect(features.locator('[data-language]')).toHaveCount(11);
    await expect(
        features
            .getByRole('region', { name: 'Code intelligence', exact: true })
            .locator('[data-language]')
    ).toHaveCount(3);
    await expect(
        features
            .getByRole('region', { name: 'Syntax highlighting', exact: true })
            .locator('[data-language]')
    ).toHaveCount(7);
    await expect(features.locator('[data-language="rust"]')).toContainText(
        'rustup component add rust-analyzer rust-src rustfmt'
    );
    await expect(features.locator('[data-language="typescript"]')).toContainText(
        'Language server included.'
    );
    const search = features.getByRole('textbox', { name: 'Search languages' });
    await search.fill('React');
    await expect(features.locator('[data-language]')).toHaveCount(2);
    await search.fill('.py');
    await expect(features.locator('[data-language]')).toHaveCount(1);
    await expect(features.locator('[data-language="python"]')).toContainText(
        'Built-in syntax highlighting only.'
    );
    await search.fill('does-not-exist');
    await expect(features.getByText('No languages match your search.')).toBeVisible();
    await languagesTab.focus();
    await page.keyboard.press('ArrowRight');
    const builtinsTab = features.getByRole('tab', { name: 'Built-in features', exact: true });
    await expect(builtinsTab).toBeFocused();
    await expect(features.locator('[data-feature]')).toHaveCount(16);
    await expect(features.getByRole('textbox', { name: 'Search features' })).toHaveValue('');
    await page.keyboard.press('Home');
    await expect(languagesTab).toBeFocused();
    await expect(features.getByRole('tabpanel', { name: 'Languages', exact: true })).toBeVisible();
    await expect(features.locator('[data-language]')).toHaveCount(11);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
});

test('settings switch the UI language immediately, persist it and switch back to English', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('checkbox', { name: 'Word wrap', exact: true }).uncheck();
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    const japaneseSettings = page.getByRole('dialog', { name: '設定', exact: true });
    await expect(
        japaneseSettings.getByRole('checkbox', { name: '行の折り返し', exact: true })
    ).not.toBeChecked();
    await expect(japaneseSettings.getByRole('combobox', { name: '言語', exact: true })).toHaveValue(
        'ja'
    );
    await expect(
        page.getByRole('button', { name: 'エクスプローラー', exact: true })
    ).toHaveAttribute('title', 'エクスプローラー（Space e）');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('ja');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'setLanguage').at(-1)
                        ?.args[0]
            )
        )
        .toBe('ja');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'restoreWorkspaces')
                        .length
            )
        )
        .toBe(1);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('combobox', { name: '言語', exact: true }).selectOption('en');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('en');
});

test('Japanese command search and keyboard navigation keep working after a language change', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
    await page.getByRole('button', { name: 'パレットを閉じる', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(
        page.getByRole('dialog', { name: 'キーボードコマンド', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('textbox', { name: '項目を絞り込む', exact: true }).fill('設定');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
    await page.keyboard.press('Control+Shift+g');
    await expect(page.getByRole('dialog', { name: 'ソース管理', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Gitの変更', exact: true })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await expect(
        page.getByRole('listbox', { name: '変更されたファイル', exact: true })
    ).toBeFocused();
    await expect(page.getByRole('button', { name: '3 ブランチ', exact: true })).toBeEnabled();
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: '3 ブランチ', exact: true })).toHaveAttribute(
        'aria-current',
        'page'
    );
});

test('Git shortcuts use the enabled state as soon as loading finishes', async ({ page }) => {
    await page.goto(`${origin}?view=git&defer=gitStatus`);
    const branches = page.getByRole('button', { name: '3 Branches', exact: true });
    const list = page.getByRole('listbox', { name: 'Changed files' });
    await expect(branches).toBeDisabled();
    await expect(list).toBeFocused();
    await page.evaluate(() => {
        document.getElementById('root')!.dataset.panel = 'git';
        const changes = document.querySelector('[aria-label="Git changes"]')!;
        const list = document.querySelector('[role="listbox"]')!;
        const observer = new MutationObserver(() => {
            if (changes.getAttribute('aria-busy') === 'false') {
                observer.disconnect();
                list.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: '3',
                        bubbles: true,
                        cancelable: true
                    })
                );
            }
        });
        observer.observe(changes, { attributes: true, attributeFilter: ['aria-busy'] });
        window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] });
    });
    await expect(branches).toHaveAttribute('aria-current', 'page');
});

test('an invalid saved language safely opens the English interface', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nido.language', 'unsupported'));
    await page.goto(`${origin}?view=app`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});

test('Rapid insert text keeps spaces and following keys while a mode check is pending', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['mode_change', ['normal', 0]]]
        })
    );
    await page.keyboard.type('Go## Unsaved heading');
    await input.evaluate((node) =>
        node.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: '@',
                code: 'KeyQ',
                ctrlKey: true,
                altKey: true,
                modifierAltGraph: true,
                bubbles: true,
                cancelable: true
            })
        )
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'input')
                    .map((call) => call.args[1])
                    .join('')
            )
        )
        .toBe('Go## Unsaved heading@');
    await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('Rapid Normal-mode menu keys open the debugger and keep its focus', async ({ page }) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.keyboard.type(' D');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'n'));
    const debuggerPanel = page.getByRole('region', { name: 'Debugger', exact: true });
    await expect(debuggerPanel).toBeVisible();
    await expect
        .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await expect(debuggerPanel).toHaveCount(0);
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('textbox', { name: 'Filter items' }).fill('Open debug panel');
    await page.keyboard.press('Enter');
    await expect(debuggerPanel).toBeVisible();
    await expect
        .poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
});

test('Debugger focuses arriving variables, restores focus after stepping and respects focus outside its panel', async ({
    page
}) => {
    await page.goto(`${origin}?view=debug`);
    await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
    const renderVariables = async (id: number): Promise<void> => {
        await page.evaluate(
            (id) =>
                window.rendererTest.render({
                    debugState: {
                        status: 'paused',
                        output: '',
                        targets: [],
                        variables: [
                            {
                                id,
                                name: 'number',
                                value: '21',
                                type: 'int',
                                scope: 'Locals',
                                depth: 0,
                                expandable: false,
                                expanded: false,
                                loading: false,
                                changed: false
                            }
                        ]
                    }
                }),
            id
        );
    };
    await renderVariables(1);
    const variable = page.getByRole('treeitem', { name: 'number = 21 (int)' });
    await expect(variable).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.render({
            debugState: { status: 'running', output: '', targets: [], variables: [] }
        })
    );
    await expect(variable).toHaveCount(0);
    await renderVariables(2);
    await expect(variable).toBeFocused();
    const outside = page.getByRole('button', { name: 'Outside debugger' });
    await outside.focus();
    await renderVariables(3);
    await expect(outside).toBeFocused();
    await page.reload();
    await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
    await outside.focus();
    await renderVariables(4);
    await expect(outside).toBeFocused();
});

test('Git diff ignores an older response after selecting another file', async ({ page }) => {
    await page.goto(`${origin}?view=git&defer=gitDiff`);
    const list = page.getByRole('listbox', { name: 'Changed files' });
    await expect(list).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await list.press('j');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('gitDiff', 1, '@@ -1 +1 @@\n-old\n+SECOND_CONTENT')
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
    await page.evaluate(() =>
        window.rendererTest.settle('gitDiff', 0, '@@ -1 +1 @@\n-old\n+STALE_CONTENT')
    );
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
    await expect(page.locator('[data-git-scroll="after"]')).not.toContainText('STALE_CONTENT');
});

test('Git history pagination does not reload the first page', async ({ page }) => {
    await page.goto(`${origin}?view=git&defer=gitHistory`);
    await page.getByRole('button', { name: '2 History', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle(
            'gitHistory',
            0,
            Array.from({ length: 100 }, (_, index) => ({
                hash: index.toString(16).padStart(40, '0'),
                subject: `Commit ${index}`,
                author: 'Ada',
                date: '2026-01-01'
            }))
        )
    );
    await page.getByRole('button', { name: 'Load older commits' }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[1])).toBe(100);
    await page.evaluate(() =>
        window.rendererTest.settle('gitHistory', 0, [
            { hash: 'f'.repeat(40), subject: 'Older commit', author: 'Ada', date: '2025-01-01' }
        ])
    );
    await expect(
        page.getByRole('listbox', { name: 'Commit history' }).getByRole('option')
    ).toHaveCount(101);
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'gitHistory').length
        )
    ).toBe(2);
    await page.getByRole('button', { name: '1 Changes', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeVisible();
    await page.getByRole('button', { name: '2 History', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[1])).toBe(0);
    await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeDisabled();
    await page.evaluate(() => window.rendererTest.settle('gitHistory', 0, []));
    await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeEnabled();
});

test('A new diff clears the previous highlighting failure', async ({ page }) => {
    await page.goto(`${origin}?view=highlight&defer=highlightSources`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('highlightSources', 0, 'unavailable', true)
    );
    await expect(page.getByRole('status')).toHaveText('Syntax highlighting unavailable');
    await page.evaluate(() => window.rendererTest.render({ path: 'second.ts' }));
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('highlightSources', 0, [[], []]));
    await expect(page.locator('[data-git-scroll="after"]')).toContainText('after');
});

test('Folder browsing cancels old results and clamps selection after favorites change', async ({
    page
}) => {
    await page.goto(`${origin}?view=folders&defer=browseFolders`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    const path = page.getByRole('textbox', { name: 'Folder path' });
    await path.fill('/beta');
    await path.press('Enter');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 1, {
            path: '/beta',
            parent: '/',
            folders: []
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, {
            path: '/alpha',
            parent: '/',
            folders: [{ name: 'STALE_FOLDER', path: '/alpha/stale', directory: true }]
        })
    );
    await expect(path).toHaveValue('/beta');
    await expect(page.getByText('STALE_FOLDER')).toHaveCount(0);
    await page.evaluate(() =>
        window.rendererTest.render({
            favorites: [
                { root: '/first', name: 'First', kind: 'editor' },
                { root: '/second', name: 'Second', kind: 'editor' }
            ]
        })
    );
    const list = page.getByRole('listbox', { name: 'Folders' });
    await list.press('j');
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-1');
    await page.evaluate(() =>
        window.rendererTest.render({
            favorites: [{ root: '/first', name: 'First', kind: 'editor' }]
        })
    );
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-0');
});

test('Notification replacement resets fading and cancels the previous dismissal', async ({
    page
}) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=notification`);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'notification',
            id: 'alpha',
            severity: 'info',
            title: 'First',
            message: 'first notice'
        })
    );
    await expect(page.getByRole('status')).toHaveText(/first notice/);
    await page.clock.runFor(2000);
    await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'true');
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'notification',
            id: 'alpha',
            severity: 'info',
            title: 'Second',
            message: 'second notice'
        })
    );
    await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'false');
    await page.clock.runFor(300);
    await expect(page.getByRole('status')).toHaveText(/second notice/);
    await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
    await expect(page.getByRole('status')).toHaveCount(0);
});

test('Favorite toggling permits only one pending request', async ({ page }) => {
    await page.goto(`${origin}?view=favorites&defer=setWorkspaceFavorite`);
    const toggle = page.getByRole('button', { name: 'Toggle favorite' });
    await toggle.click();
    await expect(page.getByRole('status')).toHaveText('busy');
    expect(await page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('setWorkspaceFavorite', 0, [
            { root: '/alpha', name: 'Alpha', kind: 'editor' }
        ])
    );
    await toggle.click();
    expect(await page.evaluate(() => window.rendererTest.pending[0].args)).toEqual([
        '/alpha',
        'editor',
        false
    ]);
});

test('Git badges clear immediately when switching workspaces', async ({ page }) => {
    await page.goto(`${origin}?view=badges&defer=gitStatus`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, {
            root: '/alpha',
            branch: 'main',
            changes: [{ path: 'first.ts', status: 'M', staged: false }]
        })
    );
    await expect(page.getByRole('status')).toContainText('Modified');
    await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
    await expect(page.getByRole('status')).toHaveText('{}');
    await expect
        .poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[0]))
        .toBe('beta');
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, 'Not a Git repository', true)
    );
    await expect(page.getByRole('status')).toHaveText('{}');
});

test('Completion keeps pending navigation blocked and closes on punctuation', async ({ page }) => {
    await page.goto(`${origin}?view=completion`);
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await input.focus();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['popupmenu_show', [[['word', 'Text', '', '']], 0, 1, 1]]]
        })
    );
    const menu = page.getByRole('listbox', { name: 'Code completion' });
    await expect(menu).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                ['nido_completion_refresh', [true]],
                ['popupmenu_hide', []]
            ]
        })
    );
    await expect(menu).toHaveAttribute('aria-busy', 'true');
    await input.press('Tab');
    await expect(input).toBeFocused();
    await expect(menu).toBeVisible();
    await input.press('.');
    await expect(menu).toHaveCount(0);
});

test('Explorer requests reset their field and clear the previous validation error', async ({
    page
}) => {
    await page.goto(`${origin}?view=explorer`);
    await expect(page.getByRole('dialog', { name: 'Explorer commands' })).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.render({
            request: {
                action: 'rename',
                path: 'first.ts',
                title: 'Rename',
                value: 'first.ts'
            }
        })
    );
    const field = page.getByRole('textbox');
    await expect(field).toHaveValue('first.ts');
    await field.fill('folder/new.ts');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Use Move to');
    await page.evaluate(() =>
        window.rendererTest.render({
            request: {
                action: 'createFile',
                path: '',
                title: 'New file',
                value: 'src/new.ts'
            }
        })
    );
    await expect(field).toHaveValue('src/new.ts');
    await expect(field).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Reference selection resets with a new result and old previews cannot replace it', async ({
    page
}) => {
    await page.goto(`${origin}?view=references&defer=previewReference`);
    const list = page.getByRole('listbox', { name: 'Reference results' });
    await expect(list).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await list.press('j');
    await expect(list).toHaveAttribute('aria-activedescendant', 'reference-1');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 1, {
            first: 1,
            line: 1,
            lines: [[{ text: 'LATEST_PREVIEW', color: '#fff' }]]
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('previewReference', 0, {
            first: 1,
            line: 1,
            lines: [[{ text: 'STALE_PREVIEW', color: '#fff' }]]
        })
    );
    await expect(page.getByRole('region', { name: 'Reference preview' })).toContainText(
        'LATEST_PREVIEW'
    );
    await expect(page.getByText('STALE_PREVIEW')).toHaveCount(0);
    await page.evaluate(() =>
        window.rendererTest.render({
            references: {
                version: 2,
                loading: false,
                error: '',
                items: [{ path: '/alpha/new.ts', line: 1, column: 1, text: 'new reference' }]
            }
        })
    );
    await expect(list).toHaveAttribute('aria-activedescendant', 'reference-0');
    await expect
        .poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args.slice(1)))
        .toEqual([1, 2]);
});

test('App opens references and debugger on new events while respecting a closed panel', async ({
    page
}) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 1,
                column: 1,
                filetype: '',
                references: { version: 1, loading: false, error: '', items: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'References', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Hide references' }).click();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 2,
                column: 1,
                filetype: '',
                references: { version: 1, loading: false, error: '', items: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'References', exact: true })).toBeHidden();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [],
                current: 0,
                mode: 'n',
                line: 2,
                column: 1,
                filetype: '',
                debug: { status: 'running', output: '', variables: [], targets: [] }
            }
        })
    );
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
    const debugStatus = async (status: 'paused' | 'running' | 'building'): Promise<void> => {
        await page.evaluate(
            (nextStatus) =>
                window.rendererTest.emit({
                    type: 'state',
                    id: 'alpha',
                    state: {
                        buffers: [],
                        current: 0,
                        mode: 'n',
                        line: 2,
                        column: 1,
                        filetype: '',
                        debug: { status: nextStatus, output: '', variables: [], targets: [] }
                    }
                }),
            status
        );
    };
    await debugStatus('paused');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
        'Debug · paused'
    );
    await page.getByRole('button', { name: 'Hide debugger' }).click();
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await expect(input).toBeFocused();
    await debugStatus('running');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
    await debugStatus('paused');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
    await expect(input).toBeFocused();
    await debugStatus('building');
    await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});
