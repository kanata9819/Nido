import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Grid as EditorGrid } from '../src/renderer/src/grid';
import type { FrameMotion } from '../src/renderer/src/editorMotion';
import type {} from './renderer/harness';
import { requireWebGLCorrection } from './helpers/row-image-probe';

let server: ViteDevServer;
let origin: string;

for (const scale of [1, 1.25, 1.5]) {
    test(`code paints and accepts clicks to the viewport bottom at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/bottom-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<body></body>' })
            );
            await page.goto(`${origin}bottom-probe`);
            const results = await page.evaluate(
                async (url) => {
                    const { Grid } = await import(url);
                    const results: {
                        height: number;
                        compact: boolean;
                        fraction: number;
                        bottom: number[];
                        row: number;
                    }[] = [];
                    for (const availableHeight of [180, 187.2]) {
                        const height =
                            Math.floor(availableHeight * devicePixelRatio) / devicePixelRatio;
                        for (const compact of [false, true]) {
                            const grid = new Grid();
                            grid.pixelScrollEnabled = true;
                            grid.cursorVisible = false;
                            const rows = Math.ceil(height / 18) + 2 + (compact ? 1 : 0);
                            grid.apply([
                                ['grid_resize', [1, 20, rows]],
                                ['hl_attr_define', [1, { background: 0x204060 }, {}, []]],
                                [
                                    'hl_attr_define',
                                    [2, { background: 0x204060 }, {}, [{ hi_name: 'NidoCodeLens' }]]
                                ],
                                ...Array.from({ length: rows - 1 }, (_, row) => [
                                    'grid_line',
                                    [1, row, 0, [[' ', 1, 20]]]
                                ]),
                                ...(compact ? [['grid_line', [1, 3, 0, [['Run', 2]]]]] : []),
                                ['flush']
                            ]);
                            const canvas = document.createElement('canvas');
                            for (const fraction of [0, 0.5, 0.9]) {
                                grid.scrollFraction = fraction;
                                grid.draw(
                                    canvas,
                                    160,
                                    height,
                                    14,
                                    'monospace',
                                    false,
                                    undefined,
                                    18
                                );
                                results.push({
                                    height,
                                    compact,
                                    fraction,
                                    bottom: Array.from(
                                        canvas
                                            .getContext('2d')!
                                            .getImageData(100, canvas.height - 1, 1, 1).data
                                    ),
                                    row: grid.rowAt(height - 0.01)
                                });
                            }
                        }
                    }
                    return results;
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            for (const result of results) {
                // Windows CI rounds RGB readback by up to two levels; an unpainted row differs far more.
                for (const [channel, expected] of [32, 64, 96].entries()) {
                    expect(
                        Math.abs(result.bottom[channel] - expected),
                        JSON.stringify(result)
                    ).toBeLessThanOrEqual(2);
                }
                expect(result.bottom[3], JSON.stringify(result)).toBe(255);
                expect(result.row, JSON.stringify(result)).toBeGreaterThanOrEqual(0);
            }
        } finally {
            await context.close();
        }
    });
}

test('editor allocates full-height document rows plus command and scroll overscan rows', async ({
    page
}) => {
    await page.addInitScript(() => {
        localStorage.setItem('nido.lineHeight', '18');
        localStorage.setItem('nido.animations', 'false');
    });
    await page.goto(`${origin}?view=app`);
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    await expect
        .poll(() =>
            canvas.evaluate((element) => {
                const height = element.height / devicePixelRatio;
                const call = window.rendererTest.calls
                    .filter(({ method }) => method === 'attach' || method === 'resize')
                    .at(-1);
                return call?.args[2] === Math.max(4, Math.ceil(height / 18)) + 2;
            })
        )
        .toBe(true);
});

for (const scale of [1, 1.25, 1.5, 2]) {
    for (const opacity of [1, 0.5]) {
        test(`cached viewport animations preserve pixels at ${scale * 100}% scale and ${opacity} opacity`, async ({
            browser
        }) => {
            const context = await browser.newContext({ deviceScaleFactor: scale });
            try {
                const page = await context.newPage();
                await page.route('**/motion-probe', (route) =>
                    route.fulfill({ contentType: 'text/html', body: '<body></body>' })
                );
                await page.goto(`${origin}motion-probe`);
                const result = await page.evaluate(
                    async ({ gridUrl, motionUrl, opacity }) => {
                        const { Grid } = await import(gridUrl);
                        const { paintEditorMotion } = await import(motionUrl);
                        const originalNow = performance.now.bind(performance);
                        let now = 0;
                        performance.now = () => now;
                        let mismatches = 0;
                        let cachedPaints = 0;
                        let referencePaints = 0;
                        try {
                            for (const kind of ['down', 'up', 'horizontal', 'edit']) {
                                const pair = [false, true].map((cached) => {
                                    const grid = new Grid();
                                    grid.backgroundOpacity = opacity;
                                    grid.cursor = { row: 2, column: 5 };
                                    grid.apply([
                                        ['grid_resize', [1, 32, 8]],
                                        ...Array.from({ length: 7 }, (_, row) => [
                                            'grid_line',
                                            [
                                                1,
                                                row,
                                                0,
                                                Array.from(`row ${row} 日本語 text`, (text) => [
                                                    text,
                                                    0
                                                ])
                                            ]
                                        ]),
                                        ['flush']
                                    ]);
                                    const surface = document.createElement('canvas');
                                    const previousFrame = document.createElement('canvas');
                                    const targetFrame = document.createElement('canvas');
                                    const draw = (): void => {
                                        grid.draw(
                                            surface,
                                            320,
                                            160,
                                            15,
                                            'monospace',
                                            true,
                                            undefined,
                                            20
                                        );
                                        if (cached) cachedPaints++;
                                        else referencePaints++;
                                    };
                                    draw();
                                    previousFrame.width = surface.width;
                                    previousFrame.height = surface.height;
                                    previousFrame.getContext('2d')!.drawImage(surface, 0, 0);
                                    grid.apply([
                                        [
                                            'grid_line',
                                            [
                                                1,
                                                3,
                                                0,
                                                Array.from('new target 日本語', (text) => [text, 0])
                                            ]
                                        ],
                                        ['flush']
                                    ]);
                                    return {
                                        grid,
                                        surface,
                                        previousFrame,
                                        targetFrame,
                                        draw,
                                        cached,
                                        motion: {
                                            top: 0,
                                            bottom: 7,
                                            left: 0,
                                            right: 32,
                                            distance:
                                                kind === 'horizontal'
                                                    ? 0
                                                    : kind === 'up'
                                                      ? -20
                                                      : 20,
                                            distanceX: kind === 'horizontal' ? 15 : 0,
                                            incomingRows: 0,
                                            start: 0,
                                            duration: kind === 'edit' ? 90 : 33,
                                            edit: kind === 'edit'
                                        } as FrameMotion | undefined
                                    };
                                });
                                for (now = 0; now <= 120; now += 6) {
                                    for (const state of pair) {
                                        // Backend redraws and cursor blinking must refresh the cached target.
                                        if (now === 12 || now === 24) {
                                            state.grid.cursorOpacity = now === 12 ? 0.4 : 1;
                                            state.grid.apply([
                                                [
                                                    'grid_line',
                                                    [1, 4, 0, [[now === 12 ? 'X' : 'Y', 0]]]
                                                ],
                                                ['flush']
                                            ]);
                                            if (state.motion) state.motion.targetReady = false;
                                        }
                                        const reuseTarget = !!(
                                            state.cached && state.motion?.targetReady
                                        );
                                        if (!reuseTarget) state.draw();
                                        state.motion = paintEditorMotion({
                                            ...state,
                                            reuseTarget,
                                            cellWidth: 9,
                                            dpr: devicePixelRatio,
                                            animate: kind !== 'horizontal' || now < 18,
                                            backgroundOpacity: opacity
                                        }).motion;
                                    }
                                    const pixels = pair.map(
                                        ({ surface }) =>
                                            surface
                                                .getContext('2d')!
                                                .getImageData(0, 0, surface.width, surface.height)
                                                .data
                                    );
                                    for (let i = 0; i < pixels[0].length; i++) {
                                        if (pixels[0][i] !== pixels[1][i]) mismatches++;
                                    }
                                }
                            }
                        } finally {
                            performance.now = originalNow;
                        }
                        return { mismatches, cachedPaints, referencePaints };
                    },
                    {
                        gridUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
                        motionUrl: `/@fs/${resolve('src/renderer/src/editorMotion.ts').replaceAll('\\', '/')}`,
                        opacity
                    }
                );
                expect(result.mismatches).toBe(0);
                expect(result.cachedPaints).toBeLessThan(result.referencePaints);
            } finally {
                await context.close();
            }
        });
    }
}

test('held j/k viewport scrolling reuses frames until a redraw, while editing interrupts it', async ({
    page
}) => {
    await page.clock.install({ time: new Date(0) });
    await page.clock.pauseAt(new Date(1000));
    await page.addInitScript(() => localStorage.setItem('nido.animations', 'true'));
    await page.goto(`${origin}?view=app`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    await page.clock.runFor(32);
    await page.evaluate(
        async (url) => {
            const { Grid } = await import(url);
            const original = Grid.prototype.draw;
            const probe = { draws: 0, grid: undefined as EditorGrid | undefined };
            Object.assign(window, { viewportProbe: probe });
            Grid.prototype.draw = function (...args) {
                probe.draws++;
                probe.grid = this;
                return original.apply(this, args);
            };
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
    );
    await input.press('j');
    await page.clock.runFor(32);
    const scroll = async (): Promise<void> => {
        await page.evaluate(() => {
            const { grid } = (window as unknown as { viewportProbe: { grid: EditorGrid } })
                .viewportProbe;
            const args = [1, 0, grid.rows - 1, 0, grid.columns, 1, 0];
            window.rendererTest.emit({
                type: 'redraw',
                id: 'alpha',
                events: [
                    ['nido_scroll', args],
                    ['grid_scroll', args],
                    ['grid_line', [1, grid.rows - 2, 0, [['new row', 0]]]],
                    ['flush']
                ]
            });
        });
    };
    const count = (): Promise<number> =>
        page.evaluate(
            () => (window as unknown as { viewportProbe: { draws: number } }).viewportProbe.draws
        );
    await scroll();
    await page.clock.runFor(16);
    const firstTarget = await count();
    await page.clock.runFor(32);
    expect(await count(), 'animation frames reuse the rendered target').toBe(firstTarget);
    await input.dispatchEvent('keydown', { key: 'j', repeat: true, bubbles: true });
    await page.clock.runFor(16);
    expect(await count(), 'repeating j preserves the current visible animation').toBe(firstTarget);
    await scroll();
    await page.clock.runFor(16);
    const nextTarget = await count();
    expect(nextTarget, 'native redraws refresh the target').toBeGreaterThan(firstTarget);
    await input.dispatchEvent('keydown', { key: 'k', repeat: true, bubbles: true });
    await page.clock.runFor(16);
    expect(await count(), 'repeating k can reverse without snapping first').toBe(nextTarget);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['mode_change', ['insert', 0]], ['flush']]
        })
    );
    await page.clock.runFor(16);
    const beforeEdit = await count();
    await input.dispatchEvent('keydown', { key: 'j', repeat: true, bubbles: true });
    await page.clock.runFor(16);
    expect(await count(), 'Insert-mode text interrupts the viewport animation').toBeGreaterThan(
        beforeEdit
    );
});

for (const setting of ['on', 'off', 'reduced'] as const) {
    test(`wheel detents interpolate only with animations enabled (${setting}), while fine pixel input stays direct`, async ({
        page
    }) => {
        await page.clock.install({ time: new Date(0) });
        await page.clock.pauseAt(new Date(1000));
        await page.emulateMedia({
            reducedMotion: setting === 'reduced' ? 'reduce' : 'no-preference'
        });
        await page.addInitScript((enabled) => {
            localStorage.setItem('nido.animations', String(enabled));
            localStorage.setItem('nido.lineHeight', '18');
        }, setting !== 'off');
        await page.goto(`${origin}?view=app`);
        const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
        await expect(input).toBeFocused();
        await page.clock.runFor(32);
        await page.evaluate(() => {
            const api = window.nido;
            let fraction = 0;
            // Model native replies in both the input handler and animation frames.
            window.nido = new Proxy(api, {
                get(target, method) {
                    if (method !== 'scroll') return Reflect.get(target, method);
                    return async (...args: Parameters<typeof api.scroll>) => {
                        await api.scroll(...args);
                        fraction += args[1];
                        window.rendererTest.emit({
                            type: 'redraw',
                            id: args[0],
                            events: [['nido_pixel_scroll', [fraction, true]], ['flush']]
                        });
                    };
                }
            });
        });
        const canvas = page.locator('canvas:visible');
        const distance = (): Promise<number> =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'scroll')
                    .reduce((sum, call) => sum + Number(call.args[1]), 0)
            );
        await canvas.dispatchEvent('wheel', { deltaY: 36, deltaMode: 0 });
        await page.clock.runFor(16);
        if (setting === 'on') {
            expect(await distance()).toBeGreaterThan(0);
            expect(await distance()).toBeLessThan(1);
        } else {
            expect(await distance()).toBe(1);
        }
        await page.clock.runFor(160);
        expect(await distance()).toBeCloseTo(1, 10);
        const beforeFineInput = await distance();
        await canvas.dispatchEvent('wheel', { deltaY: 2, deltaMode: 0 });
        expect(await distance()).toBeCloseTo(beforeFineInput + 1 / 18, 10);
        if (setting === 'on') {
            await canvas.dispatchEvent('wheel', { deltaY: 3, deltaMode: 1 });
            await page.clock.runFor(16);
            const interrupted = await distance();
            await input.press('i');
            await page.clock.runFor(160);
            expect(await distance(), 'Typing stops the remaining wheel animation').toBe(
                interrupted
            );
        }
    });
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

test('large completion lists bound DOM work while preserving distant selection, scrolling and refresh', async ({
    page
}) => {
    await page.goto(`${origin}?view=completion`);
    const input = page.getByRole('textbox', { name: 'Neovim input' });
    await input.focus();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                [
                    'popupmenu_show',
                    [
                        Array.from({ length: 5000 }, (_, i) => [
                            `candidate_${i}`,
                            'Function',
                            `detail_${i}`,
                            ''
                        ]),
                        0,
                        1,
                        1
                    ]
                ]
            ]
        })
    );
    const list = page.getByRole('listbox', { name: 'Code completion' });
    await expect(list).toHaveAttribute('data-row-count', '5000');
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', '5000');
    await expect.poll(() => list.getByRole('option').count()).toBeLessThan(40);
    const select = async (index: number): Promise<void> => {
        await page.evaluate(
            (index) =>
                window.rendererTest.emit({
                    type: 'redraw',
                    id: 'alpha',
                    events: [['popupmenu_select', [index]]]
                }),
            index
        );
    };
    await select(4999);
    await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-4999');
    await expect(page.locator('#completion-alpha-4999')).toBeInViewport();
    await expect(page.locator('#completion-alpha-4999')).toHaveAttribute('aria-posinset', '5000');
    await select(0);
    await expect(page.locator('#completion-alpha-0')).toBeInViewport();
    await list.evaluate((node) => {
        node.scrollTop = 2500 * 28;
    });
    await expect(page.locator('#completion-alpha-2500')).toBeInViewport();
    await expect(page.locator('#completion-alpha-0')).toHaveCount(1);
    await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-0');
    await expect.poll(() => list.getByRole('option').count()).toBeLessThan(40);
    await page.locator('#completion-alpha-2500').click();
    await expect(input).toBeFocused();
    expect(
        await page.evaluate(() =>
            window.rendererTest.calls.some(
                (call) =>
                    call.method === 'input' &&
                    String(call.args[1]).includes('nvim_select_popupmenu_item(2500,')
            )
        )
    ).toBe(true);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                [
                    'popupmenu_show',
                    [
                        [
                            ['日本語', 'Text', '説明', ''],
                            ['emoji_🙂', 'Variable', '', '']
                        ],
                        -1,
                        1,
                        1
                    ]
                ]
            ]
        })
    );
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(page.locator('#completion-alpha-0')).toBeInViewport();
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    await select(1);
    await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-1');
    await expect(page.locator('#completion-alpha-1')).toContainText('emoji_🙂');
});

test('row text reuses styles without leaking CodeLens, bold, italic or underline colors', async ({
    page
}) => {
    await page.route('**/row-style-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<body></body>' })
    );
    await page.goto(`${origin}row-style-probe`);
    const result = await page.evaluate(
        async (moduleUrl) => {
            const { Grid } = await import(moduleUrl);
            const grid = new Grid();
            grid.busy = true;
            grid.apply([
                ['grid_resize', [1, 80, 5]],
                [
                    'hl_attr_define',
                    [1, { foreground: 0xd4d4d4 }, {}, []],
                    [2, { foreground: 0xff0000, bold: true }, {}, []],
                    [
                        3,
                        { foreground: 0x00ff00, italic: true, underline: true, special: 0x0000ff },
                        {},
                        []
                    ],
                    [4, { foreground: 0xeedd00 }, {}, [{ hi_name: 'NidoCodeLens' }]],
                    [5, { foreground: 0xffffff, background: 0x303030, reverse: true }, {}, []]
                ],
                [
                    'grid_line',
                    [1, 0, 0, [['a', 1, 70]]],
                    [
                        1,
                        1,
                        0,
                        [
                            ['L', 4],
                            ['b', 2],
                            ['i', 3],
                            ['n', 1],
                            ['日', 1],
                            ['', 1],
                            ['e\u0301', 1],
                            ['🙂', 1],
                            ['', 1],
                            ['r', 5]
                        ]
                    ]
                ],
                ['flush']
            ]);
            const canvas = document.createElement('canvas');
            const proto = CanvasRenderingContext2D.prototype;
            const font = Object.getOwnPropertyDescriptor(proto, 'font')!;
            const fill = Object.getOwnPropertyDescriptor(proto, 'fillStyle')!;
            const text = proto.fillText;
            const numberToString = Number.prototype.toString;
            const styles: Record<string, { font: string; color: string }> = {};
            let fonts = 0,
                colors = 0,
                conversions = 0;
            Number.prototype.toString = function (this: number, radix?: number): string {
                if (radix === 16) conversions++;
                return numberToString.call(this, radix);
            };
            Object.defineProperty(proto, 'font', {
                ...font,
                set(value) {
                    fonts++;
                    font.set!.call(this, value);
                }
            });
            Object.defineProperty(proto, 'fillStyle', {
                ...fill,
                set(value) {
                    colors++;
                    fill.set!.call(this, value);
                }
            });
            proto.fillText = function (value, ...args): void {
                styles[value] = { font: this.font, color: String(this.fillStyle) };
                return Reflect.apply(text, this, [value, ...args]);
            };
            try {
                const draw = (): void =>
                    grid.draw(canvas, 720, 100, 15, 'monospace', false, undefined, 19, 400);
                draw();
                const initialStyles = { ...styles };
                fonts = colors = conversions = 0;
                for (let i = 0; i < 20; i++) {
                    grid.apply([['grid_line', [1, 0, 10, [[String(i % 10), 1]]]], ['flush']]);
                    draw();
                }
                const work = { fonts, colors, conversions };
                grid.apply([
                    ['default_colors_set', [0xaabbcc, 0x112233]],
                    [
                        'hl_attr_define',
                        [1, { foreground: 0x123456, italic: true }, {}, []],
                        [5, { reverse: true }, {}, []]
                    ],
                    ['flush']
                ]);
                grid.draw(canvas, 720, 100, 18, 'serif', false, undefined, 23, 500);
                return { styles: initialStyles, updated: { ...styles }, ...work };
            } finally {
                Object.defineProperty(proto, 'font', font);
                Object.defineProperty(proto, 'fillStyle', fill);
                proto.fillText = text;
                Number.prototype.toString = numberToString;
            }
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
    );
    expect(result.styles.L.font).toContain('12px');
    expect(result.styles.b.font).toMatch(/bold|700/);
    expect(result.styles.b.color).toBe('#ff0000');
    expect(result.styles.i.font).toContain('italic');
    expect(result.styles.i.color).toBe('#00ff00');
    for (const text of ['n', '日', 'e\u0301', '🙂']) {
        expect(result.styles[text].font).not.toContain('italic');
        expect(result.styles[text].font).toContain('15px');
        expect(result.styles[text].color).toBe('#d4d4d4');
    }
    expect(result.styles.r.color).toBe('#303030');
    expect(result.fonts).toBeLessThanOrEqual(40);
    expect(result.colors).toBeLessThanOrEqual(80);
    expect(result.conversions).toBeLessThanOrEqual(40);
    expect(result.updated.a.color).toBe('#123456');
    expect(result.updated.a.font).toContain('italic');
    expect(result.updated.a.font).toContain('18px serif');
    expect(result.updated.L.font).toContain('14.4px');
    expect(result.updated.r.color).toBe('#112233');
});

for (const scale of [1, 1.25, 1.5, 2]) {
    test(`dense touchpad scrolling avoids CPU pixel transfers at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/scroll-work-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}scroll-work-probe`);
            const softwareGpu = process.env.NIDO_TEST_SOFTWARE_GPU === '1';
            if (softwareGpu) await requireWebGLCorrection(page);
            const work = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const grid = new Grid();
                    grid.busy = true;
                    grid.pixelScrollEnabled = true;
                    grid.scrolling = true;
                    const line = (row: number, revision: number): [string, number][] =>
                        Array.from(
                            `ROW_${row}_${revision} ${'const result = example(argument); '.repeat(4)}`,
                            (text, column) => [text, 1 + (column % 2)]
                        );
                    grid.apply([
                        ['grid_resize', [1, 160, 50]],
                        [
                            'hl_attr_define',
                            [1, { foreground: 0xd4d4d4 }, {}, []],
                            [2, { foreground: 0x4ec9b0 }, {}, []]
                        ],
                        ...Array.from({ length: 49 }, (_, row) => [
                            'grid_line',
                            [1, row, 0, line(row, 0)]
                        ]),
                        ['flush']
                    ]);
                    const canvas = document.createElement('canvas');
                    document.body.append(canvas);
                    const prototype = CanvasRenderingContext2D.prototype;
                    const read = prototype.getImageData;
                    const write = prototype.putImageData;
                    const text = prototype.fillText;
                    const gpu = WebGL2RenderingContext.prototype;
                    const upload = gpu.texImage2D;
                    const work = {
                        reads: 0,
                        writes: 0,
                        glyphs: 0,
                        cachedGlyphs: 0,
                        editedGlyphs: 0,
                        uploads: 0,
                        cachedUploads: 0,
                        editedUploads: 0
                    };
                    prototype.getImageData = function (...args) {
                        work.reads++;
                        return read.apply(this, args);
                    };
                    prototype.putImageData = function (...args) {
                        work.writes++;
                        return Reflect.apply(write, this, args);
                    };
                    prototype.fillText = function (...args) {
                        work.glyphs++;
                        return text.apply(this, args);
                    };
                    gpu.texImage2D = function (...args) {
                        work.uploads++;
                        return Reflect.apply(upload, this, args);
                    };
                    const durations: number[] = [];
                    let coldMs = 0;
                    try {
                        for (let frame = 0; frame < 33; frame++) {
                            // Include a cold viewport, cached motion and newly changed rows.
                            // A warmed static viewport alone misses expensive row preparation.
                            if (frame) await new Promise(requestAnimationFrame);
                            const edited = frame > 0 && frame % 8 === 0;
                            if (edited) {
                                grid.apply([
                                    ['grid_line', [1, frame, 0, line(frame, frame)]],
                                    ['flush']
                                ]);
                            }
                            grid.scrollFraction = ((frame + 1) * 0.25) / (19 * devicePixelRatio);
                            const glyphs = work.glyphs;
                            const uploads = work.uploads;
                            const start = performance.now();
                            grid.draw(
                                canvas,
                                1500,
                                950,
                                15,
                                '"Cascadia Code", monospace',
                                false,
                                undefined,
                                19,
                                350
                            );
                            const duration = performance.now() - start;
                            if (frame === 0) coldMs = duration;
                            else {
                                durations.push(duration);
                                if (edited) {
                                    work.editedGlyphs += work.glyphs - glyphs;
                                    work.editedUploads += work.uploads - uploads;
                                } else {
                                    work.cachedGlyphs += work.glyphs - glyphs;
                                    work.cachedUploads += work.uploads - uploads;
                                }
                            }
                        }
                    } finally {
                        prototype.getImageData = read;
                        prototype.putImageData = write;
                        prototype.fillText = text;
                        gpu.texImage2D = upload;
                    }
                    durations.sort((a, b) => a - b);
                    return {
                        ...work,
                        coldMs,
                        p95Ms: durations[Math.floor(durations.length * 0.95)]
                    };
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            const metrics = { scale, softwareGpu, ...work };
            console.log('dense-scroll-work', metrics);
            await test.info().attach('dense-scroll-work', {
                body: JSON.stringify(metrics, null, 2),
                contentType: 'application/json'
            });
            expect(work.glyphs).toBeGreaterThan(1000);
            expect(work.editedGlyphs).toBeGreaterThan(0);
            expect(work.cachedGlyphs, 'fractional motion must reuse cached text').toBe(0);
            expect(work.reads, 'cold and changed rows must avoid CPU pixel readback').toBe(0);
            expect(work.writes, 'fractional motion must avoid per-frame CPU pixel uploads').toBe(0);
            expect(work.cachedUploads, 'cached motion must reuse GPU textures').toBe(0);
            expect(work.editedUploads, 'edits upload only changed rows').toBeLessThanOrEqual(4);
            if (softwareGpu) {
                // SwiftShader verifies GPU behavior on the CPU; its elapsed time
                // cannot be compared with the normal rendering frame budget.
                expect(
                    work.uploads,
                    'software GPU checks must exercise WebGL textures'
                ).toBeGreaterThan(0);
            } else {
                expect(
                    work.p95Ms,
                    'warm scrolling must stay within half a 60 Hz frame'
                ).toBeLessThan(8);
            }
        } finally {
            await context.close();
        }
    });
}

test('row rasterization preserves native dark and light text pixels', async ({ browser }) => {
    for (const scale of [1.25, 1.5]) {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/native-row-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}native-row-probe`);
            const reports = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const reports: {
                        foreground: string;
                        weight: number;
                        partialClip: boolean;
                        mismatches: number;
                    }[] = [];
                    for (const [foreground, background] of [
                        ['#d4d4d4', '#121212'],
                        ['#202020', '#f5f5f5']
                    ]) {
                        for (const weight of [350, 400]) {
                            const grid = new Grid();
                            grid.busy = true;
                            grid.background = background;
                            grid.foreground = foreground;
                            grid.pixelScrollEnabled = true;
                            const cells: [string, number][] = [
                                ...Array.from('0001', (text): [string, number] => [text, 0]),
                                ['j', 2],
                                ['日', 0],
                                ['', 0],
                                ['M', 1],
                                ...Array.from(
                                    ' Il1|[](){}MWmw __ fn(value)',
                                    (text): [string, number] => [text, 0]
                                )
                            ];
                            grid.apply([
                                ['grid_resize', [1, 40, 4]],
                                ['hl_attr_define', [1, { bold: true }, {}, []]],
                                ['hl_attr_define', [2, { italic: true }, {}, []]],
                                ['grid_line', [1, 1, 0, cells]],
                                ['flush']
                            ]);
                            const rows = new Set<HTMLCanvasElement>();
                            const fillText = CanvasRenderingContext2D.prototype.fillText;
                            const rect = CanvasRenderingContext2D.prototype.rect;
                            const clips: { canvas: HTMLCanvasElement; width: number }[] = [];
                            CanvasRenderingContext2D.prototype.fillText = function (...args) {
                                rows.add(this.canvas);
                                return fillText.apply(this, args);
                            };
                            CanvasRenderingContext2D.prototype.rect = function (...args) {
                                clips.push({ canvas: this.canvas, width: args[2] });
                                return rect.apply(this, args);
                            };
                            let cellWidth: number;
                            const canvas = document.createElement('canvas');
                            const paint = (): void => {
                                ({ cellWidth } = grid.draw(
                                    canvas,
                                    400,
                                    76,
                                    15,
                                    '"Cascadia Code", monospace',
                                    false,
                                    undefined,
                                    19,
                                    weight
                                ));
                            };
                            try {
                                paint();
                                const prefix = Array.from('0099', (text): [string, number] => [
                                    text,
                                    0
                                ]);
                                grid.apply([['grid_line', [1, 1, 0, prefix]], ['flush']]);
                                cells.splice(0, 4, ...prefix);
                                paint();
                            } finally {
                                CanvasRenderingContext2D.prototype.fillText = fillText;
                                CanvasRenderingContext2D.prototype.rect = rect;
                            }
                            const row = [...rows][0];
                            const native = document.createElement('canvas');
                            native.width = row.width;
                            native.height = row.height;
                            const ctx = native.getContext('2d', { alpha: false })!;
                            ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
                            ctx.fillStyle = background;
                            ctx.fillRect(0, 0, native.width, native.height);
                            ctx.textBaseline = 'alphabetic';
                            ctx.fillStyle = foreground;
                            cells.forEach(([text, highlight], column) => {
                                if (text && text !== ' ') {
                                    ctx.font = `${highlight === 2 ? 'italic ' : ''}${highlight === 1 ? Math.max(700, weight) : weight} 15px "Cascadia Code", monospace`;
                                    ctx.fillText(
                                        text,
                                        Math.round(column * cellWidth * devicePixelRatio) /
                                            devicePixelRatio,
                                        Math.round(14 * devicePixelRatio) / devicePixelRatio
                                    );
                                }
                            });
                            const actual = row
                                .getContext('2d')!
                                .getImageData(0, 0, row.width, row.height).data;
                            const expected = ctx.getImageData(
                                0,
                                0,
                                native.width,
                                native.height
                            ).data;
                            reports.push({
                                foreground,
                                weight,
                                partialClip: clips.some(
                                    ({ canvas, width }) =>
                                        canvas === row && width > 0 && width < row.width
                                ),
                                mismatches: actual.reduce(
                                    (count, value, index) =>
                                        count + Number(value !== expected[index]),
                                    0
                                )
                            });
                        }
                    }
                    return reports;
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            console.log('native-row-pixels', JSON.stringify({ scale, reports }));
            for (const report of reports) {
                expect(report.partialClip).toBe(true);
                expect(report.mismatches).toBe(0);
            }
        } finally {
            await context.close();
        }
    }
});

test('numeric row damage preserves overhanging text and decorations across repeated edits', async ({
    browser
}) => {
    for (const scale of [1, 1.25, 1.5, 2]) {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/numeric-damage-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<body></body>' })
            );
            await page.goto(`${origin}numeric-damage-probe`);
            const failures = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const failures: string[] = [];
                    for (const family of ['monospace', 'serif']) {
                        for (const opacity of [1, 0.8]) {
                            const cells: [string, number][] = [
                                ...Array.from('0001', (text): [string, number] => [text, 0]),
                                ['j\u0301\u0338', 1],
                                ['\u0361\u0488', 1],
                                ['日', 0],
                                ['', 0],
                                ...Array.from(' lens42 ', (text): [string, number] => [text, 2]),
                                ['\u0301\u0338', 1],
                                [' ', 0],
                                [' ', 0],
                                ...Array.from(' warning ', (text): [string, number] => [text, 3]),
                                ['(', 4],
                                ['│', 5],
                                ['x', 6],
                                ['│', 0]
                            ];
                            const setup = (): EditorGrid => {
                                const grid = new Grid();
                                grid.busy = true;
                                grid.backgroundOpacity = opacity;
                                grid.pixelScrollEnabled = true;
                                grid.apply([
                                    ['grid_resize', [1, 40, 4]],
                                    ['hl_attr_define', [1, { italic: true }, {}, []]],
                                    ['hl_attr_define', [2, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
                                    [
                                        'hl_attr_define',
                                        [
                                            3,
                                            { background: 0x302020, special: 0xff7777 },
                                            {},
                                            [{ hi_name: 'DiagnosticVirtualTextError' }]
                                        ]
                                    ],
                                    [
                                        'hl_attr_define',
                                        [4, {}, {}, [{ hi_name: 'NidoBracketMatch' }]]
                                    ],
                                    ['hl_attr_define', [5, {}, {}, [{ hi_name: 'NidoIndent1' }]]],
                                    [
                                        'hl_attr_define',
                                        [6, { underline: true, strikethrough: true }, {}, []]
                                    ],
                                    ['grid_line', [1, 1, 0, cells]],
                                    ['flush']
                                ]);
                                return grid;
                            };
                            const canvas = document.createElement('canvas');
                            const grid = setup();
                            const paint = (
                                grid: EditorGrid,
                                canvas: HTMLCanvasElement
                            ): Uint8ClampedArray => {
                                grid.draw(canvas, 600, 76, 15, family, false, undefined, 19, 350);
                                // Read a copy so the probe cannot change the renderer's Canvas backing.
                                const sample = document.createElement('canvas');
                                sample.width = canvas.width;
                                sample.height = canvas.height;
                                const ctx = sample.getContext('2d')!;
                                ctx.drawImage(canvas, 0, 0);
                                return ctx.getImageData(0, 0, sample.width, sample.height).data;
                            };
                            paint(grid, canvas);
                            for (const [column, text, fractional = true] of [
                                [3, '9'],
                                [17, '8'],
                                [3, '2'],
                                // Follow a full repaint with another numeric edit before fractional motion.
                                [4, 'f\u0301\u0338', false],
                                [3, '7'],
                                [17, ' ']
                            ] as const) {
                                cells[column] = [text, cells[column][1]];
                                grid.apply([
                                    ['grid_line', [1, 1, column, [cells[column]]]],
                                    ['flush']
                                ]);
                                for (const phase of fractional ? [0, 0.25] : [0]) {
                                    grid.scrollFraction = phase / (19 * devicePixelRatio);
                                    const reference = setup();
                                    reference.scrollFraction = grid.scrollFraction;
                                    const actual = paint(grid, canvas);
                                    const expected = paint(
                                        reference,
                                        document.createElement('canvas')
                                    );
                                    const mismatch = actual.findIndex(
                                        (value, index) => value !== expected[index]
                                    );
                                    if (mismatch >= 0) {
                                        failures.push(
                                            `${family}, opacity ${opacity}, column ${column}, phase ${phase}, pixel ${Math.floor(mismatch / 4) % canvas.width},${Math.floor(mismatch / 4 / canvas.width)}`
                                        );
                                    }
                                }
                            }
                        }
                    }
                    return failures;
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            expect(failures, `numeric damage at ${scale * 100}% scale`).toEqual([]);
        } finally {
            await context.close();
        }
    }
});

for (const rows of [4, 8]) {
    for (const direction of [1, -1]) {
        test(`fast touchpad scrolling bounds work as dense rows enter the viewport (${rows}, ${direction})`, async ({
            browser
        }) => {
            const context = await browser.newContext({ deviceScaleFactor: 1.25 });
            try {
                const page = await context.newPage();
                await page.route('**/fast-touchpad-probe', (route) =>
                    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
                );
                await page.goto(`${origin}fast-touchpad-probe`);
                await requireWebGLCorrection(page);
                const reports = await page.evaluate(
                    async ({ moduleUrl, rows, direction }) => {
                        const { Grid } = await import(moduleUrl);
                        const reports: {
                            rows: number;
                            direction: number;
                            frames: number;
                            glyphs: number;
                            uploads: number;
                            canvases: number;
                            p50Ms: number;
                            p95Ms: number;
                            maxMs: number;
                            slowFrames: { frame: number; ms: number }[];
                        }[] = [];
                        const grid = new Grid();
                        grid.pixelScrollEnabled = true;
                        grid.scrolling = true;
                        const line = (row: number): [string, number][] =>
                            Array.from(
                                `${String(row).padStart(4)} ROW_${row} ${'const value = example(argument); '.repeat(5)}`.slice(
                                    0,
                                    160
                                ),
                                (text) => [text, 0]
                            );
                        grid.apply([
                            ['grid_resize', [1, 160, 50]],
                            ...Array.from({ length: 49 }, (_, row) => [
                                'grid_line',
                                [1, row, 0, line(1000 + row)]
                            ]),
                            ['flush']
                        ]);
                        const canvas = document.createElement('canvas');
                        const paint = (): void => {
                            grid.draw(
                                canvas,
                                1500,
                                950,
                                15,
                                'monospace',
                                false,
                                undefined,
                                19,
                                350
                            );
                        };
                        grid.scrollFraction = 0.25 / (19 * devicePixelRatio);
                        const getContext = HTMLCanvasElement.prototype.getContext;
                        const text = CanvasRenderingContext2D.prototype.fillText;
                        const upload = WebGL2RenderingContext.prototype.texImage2D;
                        const canvases = new WeakSet<HTMLCanvasElement>();
                        let canvasCount = 0;
                        let glyphs = 0;
                        let uploads = 0;
                        HTMLCanvasElement.prototype.getContext = function (...args) {
                            if (args[0] === '2d' && this !== canvas && !canvases.has(this)) {
                                canvases.add(this);
                                canvasCount++;
                            }
                            return Reflect.apply(getContext, this, args);
                        };
                        CanvasRenderingContext2D.prototype.fillText = function (...args) {
                            glyphs++;
                            return text.apply(this, args);
                        };
                        WebGL2RenderingContext.prototype.texImage2D = function (...args) {
                            uploads++;
                            return Reflect.apply(upload, this, args);
                        };
                        const durations: number[] = [];
                        let initialImages = 0;
                        try {
                            paint();
                            initialImages = canvasCount;
                            glyphs = uploads = 0;
                            for (let frame = 0; frame < 40; frame++) {
                                await new Promise(requestAnimationFrame);
                                const start = performance.now();
                                const count = rows * direction;
                                grid.apply([
                                    ['nido_scroll', [1, 0, 49, 0, 160, count, 0]],
                                    ['grid_scroll', [1, 0, 49, 0, 160, count, 0]],
                                    ...Array.from({ length: rows }, (_, row) => [
                                        'grid_line',
                                        [
                                            1,
                                            direction > 0 ? 49 - rows + row : row,
                                            0,
                                            line(1000 + (frame + 1) * count + row)
                                        ]
                                    ]),
                                    ...Array.from({ length: 49 }, (_, row) => [
                                        'grid_line',
                                        [
                                            1,
                                            row,
                                            0,
                                            Array.from(
                                                String(Math.abs(row - (frame % 49))).padStart(4),
                                                (text) => [text, 0]
                                            )
                                        ]
                                    ]),
                                    ['flush']
                                ]);
                                paint();
                                durations.push(performance.now() - start);
                            }
                        } finally {
                            HTMLCanvasElement.prototype.getContext = getContext;
                            CanvasRenderingContext2D.prototype.fillText = text;
                            WebGL2RenderingContext.prototype.texImage2D = upload;
                        }
                        const slowFrames = durations
                            .map((ms, frame) => ({ frame, ms }))
                            .filter(({ ms }) => ms > 25);
                        durations.sort((a, b) => a - b);
                        reports.push({
                            rows,
                            direction,
                            frames: durations.length,
                            glyphs,
                            uploads,
                            canvases: canvasCount - initialImages,
                            p50Ms: durations[20],
                            p95Ms: durations[38],
                            maxMs: durations[39],
                            slowFrames
                        });
                        return reports;
                    },
                    {
                        moduleUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
                        rows,
                        direction
                    }
                );
                console.log('fast-touchpad-work', JSON.stringify(reports));
                await test.info().attach('fast-touchpad-work', {
                    body: JSON.stringify(reports, null, 2),
                    contentType: 'application/json'
                });
                for (const work of reports) {
                    expect(work.frames).toBe(40);
                    expect(work.glyphs).toBeGreaterThan(0);
                    if (!process.env.NIDO_PERFORMANCE_BASELINE) {
                        expect(
                            work.glyphs,
                            'repaint incoming text and the changed gutter only'
                        ).toBeLessThanOrEqual(work.frames * (work.rows * 160 + 49 * 8));
                    }
                    expect(work.uploads).toBeLessThanOrEqual(work.frames * 49);
                    expect(work.canvases).toBeLessThanOrEqual(work.frames * work.rows);
                }
            } finally {
                await context.close();
            }
        });
    }
}

for (const scale of [1, 1.25, 1.5, 2]) {
    test(`relative line numbers reuse canvases and defer GPU uploads at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/stationary-work-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}stationary-work-probe`);
            await requireWebGLCorrection(page);
            const work = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const grid = new Grid();
                    grid.pixelScrollEnabled = true;
                    grid.cursor = { row: 17, column: 10 };
                    grid.apply([
                        ['grid_resize', [1, 140, 40]],
                        ...Array.from({ length: 39 }, (_, row) => [
                            'grid_line',
                            [
                                1,
                                row,
                                0,
                                Array.from(`ROW_${row} 日本語 const value = example();`, (text) => [
                                    text,
                                    0
                                ])
                            ]
                        ]),
                        ['flush']
                    ]);
                    const canvas = document.createElement('canvas');
                    const paint = (): void => {
                        grid.draw(canvas, 1120, 760, 15, 'monospace', true, undefined, 19, 350);
                    };
                    const gpu = WebGL2RenderingContext.prototype;
                    const clear = gpu.clear;
                    const program = gpu.useProgram;
                    const upload = gpu.texImage2D;
                    const remove = gpu.deleteTexture;
                    const context = HTMLCanvasElement.prototype.getContext;
                    const rowCanvases = new Set<HTMLCanvasElement>();
                    HTMLCanvasElement.prototype.getContext = function (...args) {
                        if (args[0] === '2d' && this !== canvas) rowCanvases.add(this);
                        return Reflect.apply(context, this, args);
                    };
                    const calls = { clears: 0, programs: 0, uploads: 0, liveTextures: 0 };
                    gpu.clear = function (...args) {
                        calls.clears++;
                        return clear.apply(this, args);
                    };
                    gpu.useProgram = function (...args) {
                        calls.programs++;
                        return program.apply(this, args);
                    };
                    gpu.texImage2D = function (...args) {
                        calls.uploads++;
                        calls.liveTextures++;
                        return Reflect.apply(upload, this, args);
                    };
                    gpu.deleteTexture = function (...args) {
                        calls.liveTextures--;
                        return remove.apply(this, args);
                    };
                    try {
                        paint();
                        const initialTextures = calls.liveTextures;
                        calls.clears = calls.programs = calls.uploads = 0;
                        const cursorTimes: number[] = [];
                        for (let frame = 0; frame < 160; frame++) {
                            grid.cursorOpacity = frame % 2;
                            grid.cursor.column = 10 + (frame % 10);
                            const start = performance.now();
                            paint();
                            cursorTimes.push(performance.now() - start);
                        }
                        const editTimes: number[] = [];
                        for (let frame = 0; frame < 160; frame++) {
                            const start = performance.now();
                            grid.apply([
                                ['grid_line', [1, 17, 10, [[String(frame % 10), 0]]]],
                                ['flush']
                            ]);
                            paint();
                            editTimes.push(performance.now() - start);
                        }
                        const native = { ...calls };
                        const initialImages = rowCanvases.size;
                        const scrollTimes: number[] = [];
                        for (let frame = 0; frame < 80; frame++) {
                            const start = performance.now();
                            const rows = frame < 40 ? 1 : -1;
                            grid.apply([
                                ['nido_scroll', [1, 0, 39, 0, 140, rows, 0]],
                                ['grid_scroll', [1, 0, 39, 0, 140, rows, 0]],
                                [
                                    'grid_line',
                                    [
                                        1,
                                        rows > 0 ? 38 : 0,
                                        5,
                                        Array.from(`fn value_${frame}() { 日本語 }`, (text) => [
                                            text,
                                            0
                                        ])
                                    ]
                                ],
                                ...Array.from({ length: 39 }, (_, row) => [
                                    'grid_line',
                                    [
                                        1,
                                        row,
                                        0,
                                        Array.from(
                                            String(Math.abs(row - (frame % 39))).padStart(4) + ' ',
                                            (text) => [text, 0]
                                        )
                                    ]
                                ]),
                                ['flush']
                            ]);
                            paint();
                            scrollTimes.push(performance.now() - start);
                        }
                        const relativeUploads = calls.uploads - native.uploads;
                        const createdImages = rowCanvases.size - initialImages;
                        grid.scrollFraction = 0.25 / (19 * devicePixelRatio);
                        const uploads = calls.uploads;
                        paint();
                        const scrollUploads = calls.uploads - uploads;
                        const fractionalClears = calls.clears - native.clears;
                        const warmUploads = calls.uploads;
                        grid.scrollFraction = 0.75 / (19 * devicePixelRatio);
                        paint();
                        const cachedUploads = calls.uploads - warmUploads;
                        cursorTimes.sort((a, b) => a - b);
                        editTimes.sort((a, b) => a - b);
                        scrollTimes.sort((a, b) => a - b);
                        return {
                            initialTextures,
                            native,
                            createdImages,
                            relativeUploads,
                            scrollUploads,
                            cachedUploads,
                            fractionalClears,
                            cursorP50: cursorTimes[80],
                            cursorP95: cursorTimes[152],
                            editP50: editTimes[80],
                            editP95: editTimes[152],
                            scrollP50: scrollTimes[40],
                            scrollP95: scrollTimes[76],
                            scrollMax: scrollTimes[79]
                        };
                    } finally {
                        gpu.clear = clear;
                        gpu.useProgram = program;
                        gpu.texImage2D = upload;
                        gpu.deleteTexture = remove;
                        HTMLCanvasElement.prototype.getContext = context;
                    }
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            console.log('stationary-editor-work', JSON.stringify({ scale, ...work }));
            await test.info().attach('stationary-editor-work', {
                body: JSON.stringify({ scale, ...work }, null, 2),
                contentType: 'application/json'
            });
            expect(
                work.initialTextures,
                'integer-position text must not allocate unused GPU textures'
            ).toBe(0);
            expect(work.native.clears, 'integer-position text needs no GPU correction pass').toBe(
                0
            );
            expect(work.native.programs).toBe(0);
            expect(work.native.uploads, 'integer-position edits need no texture uploads').toBe(0);
            expect(
                work.native.liveTextures,
                'obsolete versions must not evict unchanged visible rows'
            ).toBeLessThanOrEqual(work.initialTextures);
            expect(work.relativeUploads, 'relative line numbers need no GPU uploads').toBe(0);
            expect(work.createdImages, 'only incoming rows need new canvases').toBeLessThanOrEqual(
                80
            );
            expect(
                work.scrollUploads,
                'fractional scrolling prepares the visible rows when needed'
            ).toBeGreaterThan(30);
            expect(work.cachedUploads, 'later fractional frames reuse the prepared rows').toBe(0);
            expect(
                work.fractionalClears,
                'fractional motion still needs brightness correction'
            ).toBe(1);
        } finally {
            await context.close();
        }
    });
}

test('editor descriptions stay current through Unicode edits and scrolling without rewriting unchanged text', async ({
    page
}) => {
    await page.addInitScript(() => {
        localStorage.setItem('nido.language', 'en');
        localStorage.setItem('nido.animations', 'false');
    });
    await page.goto(`${origin}?view=app`);
    const canvas = page.locator('canvas:visible');
    await expect(canvas).toHaveAttribute('aria-description', /hello/);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                ['grid_resize', [1, 8, 4]],
                ['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 0])]],
                ['flush']
            ]
        })
    );
    await page.clock.runFor(32);
    await page.evaluate(() => {
        const counter = { writes: 0 };
        Object.assign(window, { descriptionCounter: counter });
        const setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (this instanceof HTMLCanvasElement && name === 'aria-description') counter.writes++;
            setAttribute.call(this, name, value);
        };
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 1])]], ['flush']]
        });
    });
    await page.clock.runFor(32);
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { descriptionCounter: { writes: number } }).descriptionCounter
                    .writes
        )
    ).toBe(0);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
                ['grid_line', [1, 2, 0, [['日', 0], [''], ['e\u0301'], ['🙂'], ['']]]],
                ['flush']
            ]
        })
    );
    await page.clock.runFor(32);
    await expect(canvas).toHaveAttribute('aria-description', /日e\u0301🙂/);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['grid_scroll', [1, 0, 3, 0, 8, 1, 0]], ['flush']]
        })
    );
    await page.clock.runFor(32);
    expect((await canvas.getAttribute('aria-description'))!.split('\n')[1]).toMatch(/^日e\u0301🙂/);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['grid_clear', [1]], ['flush']]
        })
    );
    await page.clock.runFor(32);
    await expect(canvas).not.toHaveAttribute('aria-description', /hello|日|🙂/);
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { descriptionCounter: { writes: number } }).descriptionCounter
                    .writes
        )
    ).toBe(3);
});

test('large explorer trees mount only the viewport and preserve keyboard navigation and sibling semantics', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=files`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await expect
        .poll(() =>
            page.evaluate(() => window.rendererTest.pending.some((call) => call.method === 'files'))
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.settle('files', 0, [
            { path: 'src', name: 'src', directory: true },
            ...Array.from({ length: 10000 }, (_, i) => ({
                path: `file-${String(i).padStart(5, '0')}.txt`,
                name: `file-${String(i).padStart(5, '0')}.txt`,
                directory: false
            }))
        ])
    );
    const tree = page.getByRole('tree', { name: 'Project files' });
    await expect(tree).toHaveAttribute('data-row-count', '10001');
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(70);
    await tree.focus();
    const selected = tree.locator('[aria-selected="true"]');
    await tree.press('End');
    await expect(selected).toHaveText('file-09999.txt');
    await expect(selected).toBeInViewport();
    expect(await tree.getByRole('treeitem').count()).toBeLessThan(70);
    await tree.press('Control+u');
    await expect(selected).not.toHaveText('file-09999.txt');
    await expect(selected).toBeInViewport();
    await tree.press('Home');
    await expect(selected).toHaveText('src');
    await tree.press('ArrowRight');
    await expect
        .poll(() =>
            page.evaluate(() => window.rendererTest.pending.some((call) => call.method === 'files'))
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.settle('files', 0, [
            { path: 'src/one.ts', name: 'one.ts', directory: false },
            { path: 'src/two.ts', name: 'two.ts', directory: false }
        ])
    );
    await expect(tree).toHaveAttribute('data-row-count', '10003');
    await tree.press('ArrowDown');
    await expect(selected).toHaveText('one.ts');
    await expect(selected).toHaveAttribute('aria-level', '2');
    await expect(selected).toHaveAttribute('aria-posinset', '1');
    await expect(selected).toHaveAttribute('aria-setsize', '2');
    const descendant = await tree.getAttribute('aria-activedescendant');
    expect(await selected.getAttribute('id')).toBe(descendant);
    await tree.press('Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'openFile')
                    .map((call) => call.args)
            )
        )
        .toEqual([['alpha', 'src/one.ts']]);
});

test('opening and closing Git does not duplicate badge status reads, and file changes still refresh', async ({
    page
}) => {
    await page.clock.install();
    await page.goto(`${origin}?view=app&defer=gitStatus`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { buffers: [{ id: 1, name: '/alpha/changed.ts', modified: false }], current: 1 }
        })
    );
    await page.clock.runFor(50);
    await expect(page.getByRole('tab', { name: 'changed.ts' })).toBeVisible();
    await page.clock.runFor(300);
    await page.evaluate(() => {
        while (window.rendererTest.pending.some((call) => call.method === 'gitStatus'))
            window.rendererTest.settle('gitStatus', 0, {
                root: '/alpha',
                branch: 'main',
                changes: []
            });
    });
    const before = await page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
    );
    await page.keyboard.press('Control+Shift+g');
    await page.clock.runFor(300);
    expect(
        await page.evaluate(
            () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
        )
    ).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
    );
    await page.keyboard.press('Escape');
    await page.clock.runFor(300);
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
        )
    ).toBe(before + 1);
    await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'gitStatus')
            )
        )
        .toBe(true);
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, {
            root: '/alpha',
            branch: 'main',
            changes: [{ path: 'changed.ts', status: 'M', staged: false }]
        })
    );
    await expect(
        page.getByRole('tab', { name: 'changed.ts' }).getByLabel('Git: Modified', { exact: true })
    ).toBeVisible();
});

test('cursor-only state updates leave file tabs untouched while real tab changes still render', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=gitStatus`);
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    await page.evaluate(() => {
        const buffers = Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            name: `/alpha/file-${i}.txt`,
            modified: false
        }));
        const map = buffers.map;
        Object.assign(window, { tabMaps: 0, performanceBuffers: buffers });
        buffers.map = function (...args: Parameters<typeof map>) {
            (window as unknown as { tabMaps: number }).tabMaps++;
            return map.apply(this, args);
        } as typeof map;
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { buffers, current: 1 }
        });
    });
    const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
    await expect(tabs.getByRole('tab')).toHaveCount(100);
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.pending.some((call) => call.method === 'gitStatus')
            )
        )
        .toBe(true);
    await page.evaluate(() => {
        while (window.rendererTest.pending.some((call) => call.method === 'gitStatus')) {
            window.rendererTest.settle('gitStatus', 0, {
                root: '/alpha',
                branch: 'main',
                changes: [{ path: 'file-0.txt', status: 'M', staged: false }]
            });
        }
    });
    await expect(
        tabs.getByRole('tab').first().getByLabel('Git: Modified', { exact: true })
    ).toBeVisible();
    await page.evaluate(() => {
        (window as unknown as { tabMaps: number }).tabMaps = 0;
    });
    for (let i = 0; i < 20; i++) {
        await page.evaluate(async (column) => {
            window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { column } });
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            );
        }, i + 2);
    }
    const maps = await page.evaluate(() => (window as unknown as { tabMaps: number }).tabMaps);
    console.log(`100 file tabs, 20 cursor-only updates: ${maps} tab list maps`);
    expect(maps).toBe(0);
    await page.evaluate(() => {
        const buffers = (
            window as unknown as {
                performanceBuffers: { id: number; name: string; modified: boolean }[];
            }
        ).performanceBuffers;
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: {
                current: 2,
                buffers: buffers.map((buffer, i) =>
                    i === 1 ? { ...buffer, modified: true } : buffer
                )
            }
        });
    });
    await expect(tabs.getByRole('tab', { selected: true })).toHaveText('file-1.txt');
    await expect(tabs.getByRole('tab', { selected: true }).getByLabel('Unsaved')).toBeVisible();
    await tabs.getByRole('tab').first().click();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'selectBuffer')
                    .map((call) => call.args)
            )
        )
        .toEqual([['alpha', 1]]);
});

test('hidden editors keep their state without scheduling paints, and cursor blinking does not rewrite input styles', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
    await page.evaluate(() =>
        window.rendererTest.settle('restoreWorkspaces', 0, {
            workspaces: [
                { id: 'alpha', root: '/alpha', name: 'Alpha' },
                { id: 'beta', root: '/beta', name: 'Beta' }
            ],
            active: 'alpha',
            errors: []
        })
    );
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
    const scheduled = await page.evaluate(() => {
        let frames = 0;
        const request = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) => {
            frames++;
            return request(callback);
        };
        try {
            for (let i = 0; i < 20; i++)
                window.rendererTest.emit({
                    type: 'redraw',
                    id: 'beta',
                    events: [
                        ['grid_resize', [1, 40, 6]],
                        ['grid_line', [1, 1, 0, [['background output', 0]]]],
                        ['flush']
                    ]
                });
        } finally {
            window.requestAnimationFrame = request;
        }
        return frames;
    });
    expect(scheduled).toBe(0);
    const writes = await input.evaluate(async (node) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        let mutations = 0;
        const observer = new MutationObserver((records) => {
            mutations += records.length;
        });
        observer.observe(node, { attributes: true, attributeFilter: ['style'] });
        for (let i = 0; i < 5; i++) {
            window.dispatchEvent(new Event('focus'));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        observer.disconnect();
        return mutations;
    });
    expect(writes).toBe(0);
    await page.keyboard.press('Alt+2');
    await expect(input).toBeFocused();
    await expect(page.locator('canvas:visible')).toHaveAttribute(
        'aria-description',
        /background output/
    );
});

for (const scale of [1, 1.25, 1.5, 2]) {
    for (const opacity of [1, 0.5]) {
        test(`cursor and edit paints preserve pixels at ${scale * 100}% scale and ${opacity} opacity`, async ({
            browser
        }) => {
            const context = await browser.newContext({ deviceScaleFactor: scale });
            try {
                const page = await context.newPage();
                await page.route('**/canvas-probe', (route) =>
                    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
                );
                await page.goto(`${origin}canvas-probe`);
                const result = await page.evaluate(
                    async ({ moduleUrl, opacity }) => {
                        const { Grid } = (await import(moduleUrl)) as {
                            Grid: typeof EditorGrid;
                        };
                        const grid = new Grid();
                        grid.backgroundOpacity = opacity;
                        grid.pixelScrollEnabled = true;
                        grid.apply([
                            ['grid_resize', [1, 140, 40]],
                            ['hl_attr_define', [1, { foreground: 0x70b5ff }, {}, []]],
                            ...Array.from({ length: 39 }, (_, row) => [
                                'grid_line',
                                [
                                    1,
                                    row,
                                    0,
                                    Array.from(
                                        `${row} 日本語 😀 ${'const variable = { value: 1 }; '.repeat(4)}`,
                                        (text) => [text, row % 2]
                                    )
                                ]
                            ]),
                            ['flush']
                        ]);
                        const canvas = document.createElement('canvas');
                        const reference = document.createElement('canvas');
                        let copies = 0;
                        let width = 1119;
                        let height = 1119;
                        let lineHeight = 28;
                        let fontSize = 16;
                        let focused = true;
                        let position: { row: number; column: number } | undefined;
                        let mismatches = 0;
                        const paint = (target: HTMLCanvasElement): void => {
                            grid.draw(
                                target,
                                Math.floor(width * devicePixelRatio) / devicePixelRatio,
                                Math.floor(height * devicePixelRatio) / devicePixelRatio,
                                fontSize,
                                'monospace',
                                focused,
                                position,
                                lineHeight
                            );
                        };
                        const compare = (): void => {
                            paint(canvas);
                            // A fresh surface provides the full repaint reference without reusing old pixels.
                            const referenceGrid = new Grid();
                            for (const key of [
                                'cells',
                                'columns',
                                'rows',
                                'cursor',
                                'scrollCursor',
                                'scrollFraction',
                                'scrollPreview',
                                'scrollOrigin',
                                'backgroundOpacity',
                                'pixelScrollEnabled',
                                'scrolling',
                                'busy',
                                'mode',
                                'cursorVisible',
                                'cursorOpacity',
                                'bracketGuides',
                                'stickyScroll',
                                'foreground',
                                'background'
                            ] as const) {
                                Reflect.set(referenceGrid, key, grid[key]);
                            }
                            Reflect.set(referenceGrid, 'upperRows', grid.historyRows);
                            Reflect.set(referenceGrid, 'lowerRows', grid.futureRows);
                            for (const [id, highlight] of grid.highlights) {
                                referenceGrid.highlights.set(id, highlight);
                            }
                            referenceGrid.draw(
                                reference,
                                Math.floor(width * devicePixelRatio) / devicePixelRatio,
                                Math.floor(height * devicePixelRatio) / devicePixelRatio,
                                fontSize,
                                'monospace',
                                focused,
                                position,
                                lineHeight
                            );
                            const expected = reference
                                .getContext('2d')!
                                .getImageData(0, 0, reference.width, reference.height).data;
                            const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                            for (let i = 0; i < expected.length; i++) {
                                if (expected[i] !== actual[i]) mismatches++;
                            }
                        };
                        paint(canvas);
                        const ctx = canvas.getContext('2d')!;
                        const drawImage = ctx.drawImage;
                        ctx.drawImage = function (...args) {
                            copies++;
                            Reflect.apply(drawImage, this, args);
                        };
                        grid.invalidatePaint();
                        paint(canvas);
                        const fullCopies = copies;
                        copies = 0;
                        const samples: number[] = [];
                        for (let i = 0; i < 160; i++) {
                            grid.cursorOpacity = i % 2;
                            grid.cursor.column = 10 + (i % 20);
                            const start = performance.now();
                            paint(canvas);
                            samples.push(performance.now() - start);
                        }
                        const cursorCopies = copies;
                        grid.cursor = { row: 17, column: 10 };
                        paint(canvas);
                        copies = 0;
                        const editSamples: number[] = [];
                        for (let i = 0; i < 160; i++) {
                            const start = performance.now();
                            grid.apply([
                                ['grid_line', [1, 17, 10, [[String(i % 10), 0]]]],
                                ['flush']
                            ]);
                            paint(canvas);
                            editSamples.push(performance.now() - start);
                        }
                        const editCopies = copies;
                        compare();
                        for (const row of [0, 1, 17, 38, 39]) {
                            grid.cursor.row = row;
                            for (const mode of ['normal', 'insert', 'cmdline_normal']) {
                                grid.mode = mode;
                                grid.cursorVisible = true;
                                grid.cursorOpacity = 0.4;
                                compare();
                                grid.cursorVisible = false;
                                compare();
                            }
                        }
                        focused = false;
                        compare();
                        focused = true;
                        grid.cursor = { row: 3, column: 8 };
                        for (const row of [3.4, 3.8, 4.2]) {
                            position = { row, column: 8.5 };
                            compare();
                        }
                        position = undefined;
                        canvas.width = 0;
                        compare();
                        grid.busy = true;
                        compare();
                        grid.busy = false;
                        grid.apply([
                            [
                                'nido_bracket_guides',
                                [
                                    [
                                        {
                                            column: 4,
                                            top: 0,
                                            bottom: 10,
                                            opening: 8,
                                            closing: 4,
                                            color: '#fff',
                                            active: true
                                        }
                                    ]
                                ]
                            ],
                            ['flush']
                        ]);
                        compare();
                        for (const row of [7, 9, -1]) {
                            grid.apply([
                                [
                                    'nido_sticky_scroll',
                                    [
                                        {
                                            window: 1,
                                            buffer: 1,
                                            top: 0,
                                            left: 0,
                                            width: 140,
                                            height: 39,
                                            gutter: 4,
                                            tabstop: 4,
                                            leftcol: 0,
                                            scopes: [],
                                            separators: row >= 0 ? [{ line: row + 1, row }] : []
                                        }
                                    ]
                                ],
                                ['flush']
                            ]);
                            compare();
                        }
                        grid.apply([['default_colors_set', [0xffffff, 0x101010]], ['flush']]);
                        compare();
                        grid.apply([['grid_line', [1, 5, 0, [['EDITED', 1]]]], ['flush']]);
                        compare();
                        grid.apply([
                            ['grid_line', [1, 0, 10, [['TOP', 0]]], [1, 39, 0, [['COMMAND', 0]]]],
                            ['flush']
                        ]);
                        compare();
                        grid.scrollFraction = 0.25;
                        grid.scrolling = true;
                        compare();
                        grid.scrolling = false;
                        compare();
                        width = 900;
                        height = 990;
                        lineHeight = 25;
                        fontSize = 15;
                        compare();
                        grid.apply([
                            ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
                            ['flush']
                        ]);
                        for (const row of [2, 3, 4, 17, 38]) {
                            grid.cursor.row = row;
                            compare();
                        }
                        grid.apply([['grid_line', [1, 5, 7, [['x', 0]]]], ['flush']]);
                        compare();
                        grid.apply([['grid_line', [1, 5, 7, [[' ', 0]]]], ['flush']]);
                        compare();
                        grid.apply([['grid_scroll', [1, 0, 10, 4, 30, 1, 0]], ['flush']]);
                        compare();
                        grid.apply([['grid_scroll', [1, 0, 38, 0, 140, -1, 0]], ['flush']]);
                        compare();
                        grid.apply([
                            ['nido_scroll', [1, 0, 39, 0, 140, -3, 0]],
                            ['grid_scroll', [1, 0, 39, 0, 140, -3, 0]],
                            ['flush']
                        ]);
                        for (const preview of [1.5, 2.5, 0]) {
                            grid.scrollPreview = preview;
                            compare();
                        }
                        grid.scrollFraction = 0;
                        // Relative numbers change every retained visible row on each move.
                        // Compare copied, reused bitmaps with freshly rasterized cells.
                        for (const direction of [1, 1, -1, -1]) {
                            grid.apply([
                                ['nido_scroll', [1, 0, 39, 0, 140, direction, 0]],
                                ['grid_scroll', [1, 0, 39, 0, 140, direction, 0]],
                                ...Array.from({ length: 39 }, (_, row) => [
                                    'grid_line',
                                    [
                                        1,
                                        row,
                                        0,
                                        Array.from(
                                            `${String(row + direction + 2).padStart(3)} `,
                                            (text) => [text, 0]
                                        )
                                    ]
                                ]),
                                ['flush']
                            ]);
                            for (const preview of [-0.25, 0, 0.25]) {
                                grid.scrollPreview = preview;
                                compare();
                            }
                        }
                        grid.apply([['grid_clear', [1]], ['flush']]);
                        compare();
                        samples.sort((a, b) => a - b);
                        editSamples.sort((a, b) => a - b);
                        return {
                            fullCopies,
                            cursorCopies,
                            editCopies,
                            mismatches,
                            p50: samples[80],
                            p95: samples[152],
                            editP50: editSamples[80],
                            editP95: editSamples[152]
                        };
                    },
                    {
                        moduleUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
                        opacity
                    }
                );
                console.log(JSON.stringify({ scale, opacity, ...result }));
                expect(result.mismatches).toBe(0);
                if (!process.env.NIDO_PERFORMANCE_BASELINE) {
                    expect(result.cursorCopies).toBeLessThanOrEqual(160 * 3);
                    expect(result.editCopies).toBeLessThanOrEqual(160 * 3);
                }
            } finally {
                await context.close();
            }
        });
    }
}

for (const scale of [1, 1.25, 1.5, 2]) {
    for (const opacity of [1, 0.5]) {
        test(`paint bands bound cached row geometry at ${scale * 100}% scale and ${opacity} opacity`, async ({
            browser
        }) => {
            const context = await browser.newContext({ deviceScaleFactor: scale });
            try {
                const page = await context.newPage();
                await page.route('**/row-band-probe', (route) =>
                    route.fulfill({ contentType: 'text/html', body: '<body></body>' })
                );
                await page.goto(`${origin}row-band-probe`);
                const result = await page.evaluate(
                    async ({ moduleUrl, referenceModuleUrl, baseline, opacity }) => {
                        const { Grid } = (await import(
                            baseline && referenceModuleUrl ? referenceModuleUrl : moduleUrl
                        )) as {
                            Grid: typeof EditorGrid;
                        };
                        const ReferenceGrid = referenceModuleUrl
                            ? ((await import(referenceModuleUrl)) as { Grid: typeof EditorGrid })
                                  .Grid
                            : Grid;
                        const createGrid = (Constructor: typeof EditorGrid): EditorGrid => {
                            const value = new Constructor();
                            value.backgroundOpacity = opacity;
                            value.pixelScrollEnabled = true;
                            value.apply([
                                ['grid_resize', [1, 80, 40]],
                                ['hl_attr_define', [1, { foreground: 0x7ab5ff }, {}, []]],
                                [
                                    'hl_attr_define',
                                    [2, { foreground: 0x99aacc }, {}, [{ hi_name: 'NidoCodeLens' }]]
                                ],
                                ...Array.from({ length: 40 }, (_, row) => [
                                    'grid_line',
                                    [
                                        1,
                                        row,
                                        0,
                                        [[`${row} 日本語 😀 cached row `, row % 5 === 0 ? 2 : 1]]
                                    ]
                                ]),
                                ['flush']
                            ]);
                            for (const [key, prefix] of [
                                ['upperRows', 'U'],
                                ['lowerRows', 'L']
                            ]) {
                                Reflect.set(
                                    value,
                                    key,
                                    Array.from({ length: 256 }, (_, row) =>
                                        Array.from({ length: 80 }, (_, column) => ({
                                            text: column === 0 ? `${prefix}${row}` : 'x',
                                            highlight: row % 5 === 0 ? 2 : 1
                                        }))
                                    )
                                );
                            }
                            return value;
                        };
                        const grid = createGrid(Grid);
                        const canvas = document.createElement('canvas');
                        const reference = document.createElement('canvas');
                        let lineHeight = 20;
                        const paint = (target: HTMLCanvasElement, value = grid): void => {
                            value.draw(
                                target,
                                800,
                                800,
                                15,
                                'monospace',
                                true,
                                undefined,
                                lineHeight
                            );
                        };
                        const geometryReads: number[] = [];
                        for (const fraction of [-0.25, 0.25]) {
                            grid.scrollFraction = fraction;
                            grid.cursor = { row: 17, column: 10 };
                            paint(canvas);
                            let reads = 0;
                            const rowTop = grid.rowTop;
                            grid.rowTop = function (row) {
                                reads++;
                                return rowTop.call(this, row);
                            };
                            for (let frame = 0; frame < 160; frame++) {
                                grid.cursorOpacity = frame % 2;
                                grid.cursor.column = 10 + (frame % 20);
                                paint(canvas);
                            }
                            grid.rowTop = rowTop;
                            geometryReads.push(reads);
                        }
                        let mismatches = 0;
                        let comparisons = 0;
                        const mismatchCases: unknown[] = [];
                        const full = createGrid(ReferenceGrid);
                        // Retain the exhaustive painter's row candidates and rendering
                        // history. Its partial paints receive the same edits and motion.
                        Reflect.set(Reflect.get(full, 'canvas'), 'rowRange', () => [
                            full.scrollOffset < 0 ? -full.historyRows.length : 0,
                            full.rows + (full.scrollOffset > 0 ? full.futureRows.length : 0)
                        ]);
                        const compare = (): void => {
                            paint(canvas);
                            for (const key of [
                                'cursor',
                                'scrollFraction',
                                'scrollPreview',
                                'scrollOrigin',
                                'backgroundOpacity',
                                'pixelScrollEnabled',
                                'cursorVisible',
                                'cursorOpacity',
                                'mode'
                            ] as const) {
                                Reflect.set(full, key, grid[key]);
                            }
                            paint(reference, full);
                            const expected = reference
                                .getContext('2d')!
                                .getImageData(0, 0, reference.width, reference.height).data;
                            const actual = canvas
                                .getContext('2d')!
                                .getImageData(0, 0, canvas.width, canvas.height).data;
                            const before = mismatches;
                            for (let i = 0; i < expected.length; i++) {
                                if (expected[i] !== actual[i]) mismatches++;
                            }
                            if (mismatches !== before) {
                                mismatchCases.push({
                                    comparison: comparisons,
                                    fraction: grid.scrollFraction,
                                    row: grid.cursor.row,
                                    opacity: grid.cursorOpacity,
                                    count: mismatches - before
                                });
                            }
                            comparisons++;
                        };
                        for (const fraction of [
                            -255.75, -100.25, -1, -0.25, 0, 0.25, 1, 100.25, 255.75
                        ]) {
                            grid.scrollFraction = fraction;
                            for (const row of [0, 17, 38, 39]) {
                                grid.cursor = { row, column: 10 };
                                grid.cursorVisible = true;
                                grid.cursorOpacity = 0.6;
                                compare();
                                grid.cursorOpacity = 0;
                                compare();
                            }
                        }
                        // A text change can damage a compact row away from the cursor.
                        grid.scrollFraction = 0.25;
                        grid.cursor.row = 39;
                        grid.apply([['grid_line', [1, 5, 0, [['EDIT', 1]]]], ['flush']]);
                        full.apply([['grid_line', [1, 5, 0, [['EDIT', 1]]]], ['flush']]);
                        compare();
                        grid.scrollFraction = -0.25;
                        grid.apply([['grid_line', [1, 39, 0, [['COMMAND', 1]]]], ['flush']]);
                        full.apply([['grid_line', [1, 39, 0, [['COMMAND', 1]]]], ['flush']]);
                        compare();
                        // Odd row heights and a non-zero origin put both compact and
                        // regular row edges between physical pixels at fractional DPI.
                        lineHeight = 19;
                        grid.scrollOrigin = 3.75;
                        for (const fraction of [-255.75, -0.25, 0, 0.25, 255.75]) {
                            grid.scrollFraction = fraction;
                            for (const row of [0, 39]) {
                                grid.cursor = { row, column: 10 };
                                grid.cursorOpacity = 0.6;
                                compare();
                                grid.cursorOpacity = 0;
                                compare();
                            }
                        }
                        grid.scrollFraction = 0;
                        for (const rows of [40, 1, 0]) {
                            for (const value of [grid, full]) {
                                Reflect.set(value, 'upperRows', []);
                                Reflect.set(value, 'lowerRows', []);
                                value.apply([['grid_resize', [1, 80, rows]], ['flush']]);
                            }
                            grid.cursor = { row: 0, column: 0 };
                            compare();
                        }
                        return { geometryReads, mismatches, comparisons, mismatchCases };
                    },
                    {
                        moduleUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
                        referenceModuleUrl: process.env.NIDO_GRID_REFERENCE_MODULE
                            ? `/@fs/${resolve(process.env.NIDO_GRID_REFERENCE_MODULE).replaceAll('\\', '/')}`
                            : undefined,
                        baseline: process.env.NIDO_PERFORMANCE_BASELINE === '1',
                        opacity
                    }
                );
                console.log(JSON.stringify({ scale, opacity, ...result }));
                expect(result.mismatches).toBe(0);
                if (!process.env.NIDO_PERFORMANCE_BASELINE) {
                    for (const reads of result.geometryReads) {
                        expect(reads).toBeLessThanOrEqual(160 * 50);
                    }
                }
            } finally {
                await context.close();
            }
        });
    }
}
