import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './renderer/harness';
import { applyNeovimUI, emptyNeovimUI } from '../src/shared/neovimUI';

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

for (const scale of [1, 1.25, 1.5]) {
    test(`bracket borders, translucent word highlights and wide cursors render at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/highlight-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}highlight-probe`);
            const result = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const grid = new Grid();
                    grid.background = '#121212';
                    grid.foreground = '#4ec9b0';
                    grid.busy = true;
                    grid.apply([
                        ['grid_resize', [1, 40, 6]],
                        [
                            'hl_attr_define',
                            [
                                1,
                                { underline: true, special: 0xffffff },
                                {},
                                [{ hi_name: 'NidoBracketMatch' }]
                            ],
                            [
                                2,
                                { background: 0xffffff, blend: 88 },
                                {},
                                [{ hi_name: 'LspReferenceRead' }]
                            ],
                            [
                                3,
                                { background: 0xffffff, blend: 80 },
                                {},
                                [{ hi_name: 'LspReferenceWrite' }]
                            ]
                        ],
                        [
                            'grid_line',
                            [
                                1,
                                0,
                                0,
                                [
                                    ['{', 1],
                                    [' ', 0, 2],
                                    ['}', 1]
                                ]
                            ],
                            [
                                1,
                                1,
                                0,
                                [
                                    ...Array.from('cells', (text) => [text, 2]),
                                    [' ', 0],
                                    ...Array.from('cells', (text) => [text, 3])
                                ]
                            ],
                            [1, 2, 0, [['a', 0], ['日'], [''], ['😀'], [''], ['e\u0301']]]
                        ],
                        ['flush']
                    ]);
                    const canvas = document.createElement('canvas');
                    document.body.append(canvas);
                    const draw = (position?: {
                        row: number;
                        column: number;
                        width?: number;
                    }): { cellWidth: number; cellHeight: number } =>
                        grid.draw(canvas, 400, 150, 14, 'monospace', true, position, 24);
                    const { cellWidth } = draw();
                    const ctx = canvas.getContext('2d')!;
                    const dpr = devicePixelRatio;
                    const pixel = (x: number, y: number): number[] =>
                        Array.from(
                            ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
                        ).slice(0, 3);
                    const border = pixel(0, 4);
                    const read = pixel(cellWidth / 2, 28);
                    const write = pixel(cellWidth * 6.5, 28);
                    const margins = [0, 23, 24, 47].map((y) => pixel(cellWidth / 2, y));
                    grid.apply([
                        [
                            'grid_line',
                            [
                                1,
                                0,
                                0,
                                [
                                    ['{', 0],
                                    [' ', 0, 2],
                                    ['}', 0]
                                ]
                            ]
                        ],
                        ['flush']
                    ]);
                    draw();
                    const erased = pixel(0, 4);
                    const widths: number[] = [];
                    const fill = ctx.fillRect.bind(ctx);
                    ctx.fillRect = function (x, y, width, height) {
                        if (this.fillStyle === '#f5f5f5') widths.push(width);
                        fill(x, y, width, height);
                    };
                    grid.busy = false;
                    grid.cursor = { row: 2, column: 1 };
                    draw();
                    draw({ row: 2, column: 1, width: 1.5 });
                    grid.mode = 'insert';
                    draw();
                    return { border, read, write, margins, erased, widths, cellWidth };
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            expect(result.border).toEqual([137, 137, 137]);
            expect(result.margins).toEqual(Array.from({ length: 4 }, () => [18, 18, 18]));
            expect(result.erased).toEqual([18, 18, 18]);
            expect(result.read[0]).toBeGreaterThan(18);
            expect(result.read[0]).toBeLessThan(55);
            expect(result.read[0]).toBe(result.read[1]);
            expect(result.read[1]).toBe(result.read[2]);
            expect(result.write[0]).toBeGreaterThan(result.read[0]);
            expect(result.widths).toEqual([result.cellWidth * 2, result.cellWidth * 1.5, 2]);
        } finally {
            await context.close();
        }
    });
}
test.afterAll(async () => {
    await server?.close();
});

test('external command cards preserve native input focus, UTF-8 cursor, nested prompts and completion', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    let state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
        [[0, 'echo "日本😀"']],
        15,
        ':',
        '',
        0,
        1
    ]);
    const emit = async (): Promise<void> => {
        await page.evaluate(
            (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
            state
        );
    };
    await emit();
    const command = page.getByRole('dialog', { name: 'Neovim command line', exact: true });
    await expect(command).toBeVisible();
    await expect(command.getByLabel('Command content')).toHaveText(':echo "日本😀"');
    await expect(command.locator('[data-neovim-caret]')).toHaveText('😀');
    await expect(input).toHaveAttribute('data-nvim-command-active', '');
    await expect(input).toBeFocused();
    await command.getByLabel('Command content').click();
    await expect(input).toBeFocused();
    const positions = await input.evaluate((node) => {
        const caret = document.querySelector('[data-neovim-caret]')!.getBoundingClientRect();
        const anchor = node.getBoundingClientRect();
        return { x: Math.abs(caret.x - anchor.x), y: Math.abs(caret.y - anchor.y) };
    });
    expect(positions.x).toBeLessThan(1);
    expect(positions.y).toBeLessThan(1);
    state = applyNeovimUI(state, 'cmdline_show', [[[0, '1+1']], 3, '=', '', 0, 2]);
    await emit();
    await expect(command.getByLabel('Command content')).toContainText('=1+1');
    state = applyNeovimUI(state, 'cmdline_hide', [2, false]);
    state = applyNeovimUI(state, 'popupmenu_show', [
        [
            ['echo', '', '', ''],
            ['echomsg', '', '', '']
        ],
        0,
        0,
        0,
        -1
    ]);
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['popupmenu_show', [[['echo', '', '', '']], 0, 0, 0, -1]]]
        })
    );
    await emit();
    await expect(page.getByRole('listbox', { name: 'Code completion' })).toHaveCount(0);
    const completion = page.getByRole('listbox', { name: 'Command completion' });
    await expect(completion).toBeVisible();
    await completion.getByRole('option', { name: 'echomsg', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls
                        .filter((call) => call.method === 'selectCompletion')
                        .at(-1)?.args
            )
        )
        .toEqual(['alpha', 1]);
    await expect(input).toBeFocused();
    await command.getByRole('button', { name: 'Cancel command' }).click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
            )
        )
        .toEqual(['alpha', '<Esc>']);
    state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
    await emit();
    await expect(command).toHaveCount(0);
    await expect(input).not.toHaveAttribute('data-nvim-command-active');
});

test('external command input keeps spaces, Unicode and control keys in order', async ({ page }) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    const state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
        [[0, 'echomsg "']],
        9,
        ':',
        '',
        0,
        1
    ]);
    await page.evaluate(
        (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
        state
    );
    await expect(input).toHaveAttribute('data-nvim-command-active', '');
    await page.keyboard.type('Native message 日本語"');
    await page.keyboard.press('Control+p');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'c'));
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'input')
                    .map((call) => call.args[1])
                    .join('')
            )
        )
        .toBe('Native message 日本語"<C-p>');
    await page.keyboard.press('Control+Shift+m');
    await expect(page.getByRole('listbox', { name: 'Problems', exact: true })).toBeFocused();
});

test('file picker opens after command submission before the command card redraws', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=inputMode`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    const state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
        [[0, 'echo 1']],
        6,
        ':',
        '',
        0,
        1
    ]);
    await page.evaluate((state) => {
        window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [['mode_change', ['cmdline_normal', 0]]]
        });
        window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state });
    }, state);
    await expect(input).toHaveAttribute('data-nvim-command-active', '');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+p');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    // Neovim processed Enter, but its redraw and the old command card are still pending.
    await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'n'));
    await expect(page.getByRole('textbox', { name: 'Filter items' })).toBeFocused();
});

test('external messages show safe selectable output, severity, history and keyboard scrolling', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    let state = applyNeovimUI(emptyNeovimUI(), 'msg_show', [
        'emsg',
        [[0, '<img src=x onerror=alert(1)>\nE492: Unknown command']],
        false
    ]);
    const emit = async (): Promise<void> => {
        await page.evaluate(
            (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
            state
        );
    };
    await page.evaluate(
        (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'other', state }),
        state
    );
    const messages = page.getByRole('dialog', { name: 'Neovim messages', exact: true });
    await expect(messages).toHaveCount(0);
    await emit();
    await expect(messages).toBeVisible();
    await expect(messages.locator('article[data-severity="error"]')).toContainText('E492');
    await expect(messages.locator('img')).toHaveCount(0);
    await expect(input).toBeFocused();
    state = applyNeovimUI(state, 'msg_show', [
        'shell_out',
        [[0, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')]],
        false
    ]);
    await emit();
    await page.keyboard.press('Alt+Shift+m');
    const body = page.getByLabel('Message content', { exact: true });
    await expect(body).toBeFocused();
    await expect
        .poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight))
        .toBe(true);
    await page.keyboard.press('Control+u');
    const before = await body.evaluate((node) => node.scrollTop);
    await page.keyboard.press('Control+u');
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(before);
    await body.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await expect(messages).toBeVisible();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.keyboard.press('Escape');
    await expect(messages).toHaveCount(0);
    await expect(input).toBeFocused();
    state = applyNeovimUI(state, 'cmdline_show', [[[0, 'echo']], 4, ':', '', 0, 1]);
    await emit();
    await expect(messages).toHaveCount(0);
    state = applyNeovimUI(state, 'msg_show', ['wmsg', [[0, 'New warning']], false]);
    await emit();
    await expect(messages.locator('article[data-severity="warning"]')).toContainText('New warning');
    state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
    state = applyNeovimUI(state, 'msg_history_show', [[['echomsg', [[0, 'retained history']]]]]);
    await emit();
    const history = page.getByRole('dialog', { name: 'Message history' });
    await expect(history).toContainText('retained history');
    await history.getByRole('button', { name: 'Close messages' }).click();
    await expect(history).toHaveCount(0);
});

test('external confirmation and hit-enter cards send replies to Neovim before dismissing', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    await expect(input).toBeFocused();
    let state = applyNeovimUI(emptyNeovimUI(), 'msg_show', [
        'confirm',
        [[0, 'Continue? [Y]es, (N)o: ']],
        false
    ]);
    const emit = async (): Promise<void> => {
        await page.evaluate(
            (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
            state
        );
    };
    await emit();
    await page.keyboard.press('Alt+Shift+m');
    await page.keyboard.press('n');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
            )
        )
        .toEqual(['alpha', 'n']);
    await expect(input).toBeFocused();
    state = applyNeovimUI(state, 'msg_clear', []);
    state = applyNeovimUI(state, 'msg_show', [
        'return_prompt',
        [[0, 'Press ENTER or type command to continue']],
        false
    ]);
    await emit();
    const messages = page.getByRole('dialog', { name: 'Neovim messages' });
    await messages.getByRole('button', { name: 'Enter Continue' }).click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
            )
        )
        .toEqual(['alpha', '<CR>']);
    await expect(messages).toBeVisible();
    state = applyNeovimUI(state, 'msg_clear', []);
    await emit();
    await expect(messages).toHaveCount(0);
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

    test(`editor text reuses native rasters without color fringes at ${scale * 100}% scale`, async ({
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
                        const y = Number(args[2]) * devicePixelRatio;
                        const top = Math.round(y);
                        // Fractional movement is composited once on the destination.
                        // At integer positions it must still be an exact native copy.
                        if (Math.abs(y - top) > 0.001) return;
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
                        // Compare complete row bitmaps here; partial paints may clip overlapping padding.
                        grid.invalidatePaint();
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
                'settled fractional scrolling must reuse the native glyph images'
            ).toBe(true);
            expect(samples.colored, 'white text on gray must not gain red or blue edges').toBe(0);
            expect(samples.resampled, 'rows must not use an interpolated intermediate bitmap').toBe(
                0
            );
            expect(samples.mismatches, 'integer destinations must preserve native pixels').toBe(0);
        } finally {
            await context.close();
        }
    });

    test(`slow pixel scrolling moves cached glyphs continuously at ${scale * 100}% scale`, async ({
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
                'eighth-pixel input must not stall and jump a whole physical pixel'
            ).toBeLessThanOrEqual(0.16);
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

    test(`slow touchpad scrolling keeps continuous coverage through rebases and pauses at ${scale * 100}% scale`, async ({
        browser
    }) => {
        const context = await browser.newContext({ deviceScaleFactor: scale });
        try {
            const page = await context.newPage();
            await page.route('**/scroll-raster-probe', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
            );
            await page.goto(`${origin}scroll-raster-probe`);
            const samples = await page.evaluate(
                async (moduleUrl) => {
                    const { Grid } = await import(moduleUrl);
                    const dpr = devicePixelRatio;
                    const differences = (a: Uint8ClampedArray, b: Uint8ClampedArray): number =>
                        a.reduce((count, value, index) => count + Number(value !== b[index]), 0);
                    let inkVariation = 0;
                    let settlingPixels = 0;
                    let settlingDistance = 0;
                    const steps: number[] = [];
                    const origins: number[] = [];
                    for (const direction of [1, -1]) {
                        const grid = new Grid();
                        grid.busy = true;
                        grid.background = '#121212';
                        grid.foreground = '#ffffff';
                        grid.pixelScrollEnabled = true;
                        grid.apply([
                            ['grid_resize', [1, 40, 8]],
                            [
                                'grid_line',
                                [1, 2, 0, Array.from('Il1|[](){}MWmw', (text) => [text, 0])]
                            ],
                            ['flush']
                        ]);
                        const canvas = document.createElement('canvas');
                        const paint = (): void => {
                            grid.invalidatePaint();
                            grid.draw(canvas, 400, 152, 15, 'monospace', false, undefined, 19);
                        };
                        let nativeRows = 0;
                        const coverage = (): { ink: number; center: number } => {
                            const top = Math.floor(grid.rowY(2 - nativeRows) * dpr) - 2;
                            const width = Math.floor(120 * dpr);
                            const data = canvas
                                .getContext('2d')!
                                .getImageData(0, top, width, Math.ceil(19 * dpr) + 4).data;
                            let ink = 0;
                            let moment = 0;
                            for (let i = 0; i < data.length; i += 4) {
                                const weight = Math.max(0, data[i] - 18);
                                ink += weight;
                                moment += weight * (top + Math.floor(i / 4 / width));
                            }
                            return { ink, center: moment / ink };
                        };
                        const start = direction > 0 ? 0.9 : 0.1;
                        grid.scrollFraction = start;
                        paint();
                        const initial = coverage();
                        let previous = initial.center;
                        for (let step = 1; step <= 40; step++) {
                            const distance = start + (direction * step) / 10 / (19 * dpr);
                            const rows = Math.floor(distance);
                            if (rows !== nativeRows) {
                                const shift = rows - nativeRows;
                                grid.apply([
                                    ['nido_scroll', [1, 0, 7, 0, 40, shift, 0]],
                                    ['grid_scroll', [1, 0, 7, 0, 40, shift, 0]],
                                    ['nido_pixel_scroll', [distance - rows, true]],
                                    ['flush']
                                ]);
                                nativeRows = rows;
                            }
                            grid.scrolling = true;
                            grid.scrollFraction = distance - rows;
                            paint();
                            const measured = coverage();
                            steps.push(direction * (previous - measured.center));
                            previous = measured.center;
                            inkVariation = Math.max(
                                inkVariation,
                                Math.abs(measured.ink / initial.ink - 1)
                            );
                            const before = canvas
                                .getContext('2d')!
                                .getImageData(0, 0, canvas.width, canvas.height).data;
                            const offset = grid.scrollOffset;
                            grid.scrolling = false;
                            paint();
                            settlingDistance = Math.max(
                                settlingDistance,
                                Math.abs(grid.scrollOffset - offset)
                            );
                            const after = canvas
                                .getContext('2d')!
                                .getImageData(0, 0, canvas.width, canvas.height).data;
                            settlingPixels = Math.max(settlingPixels, differences(before, after));
                        }
                        origins.push(grid.scrollOrigin);
                    }
                    return { inkVariation, settlingPixels, settlingDistance, steps, origins };
                },
                `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
            );
            expect(samples.inkVariation, 'moving glyphs keep their total coverage').toBeLessThan(
                0.01
            );
            expect(samples.settlingPixels, 'pausing input must not sharpen or move the text').toBe(
                0
            );
            expect(
                samples.settlingDistance,
                'pausing input must not change the viewport offset'
            ).toBe(0);
            expect(
                Math.min(...samples.steps),
                'rebasing must not reverse the movement'
            ).toBeGreaterThan(0.05);
            expect(
                Math.max(...samples.steps),
                'rebasing must not jump a physical pixel'
            ).toBeLessThan(0.15);
            expect(samples.origins).toEqual([19, -19]);
        } finally {
            await context.close();
        }
    });
}

test('Extensions opens without a workspace, searches language packs and restores navigation focus', async ({
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
    const trigger = page.getByRole('button', { name: 'Extensions', exact: true });
    await trigger.click();
    const extensions = page.getByRole('region', { name: 'Extensions', exact: true });
    const search = extensions.getByRole('textbox', { name: 'Search language packs' });
    await expect(search).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await expect(extensions.locator('[data-pack]')).toHaveCount(2);
    await expect(extensions.getByRole('tab')).toHaveText(['Languages', 'Other extensions']);
    await expect(extensions.locator('[data-feature], [data-language]')).toHaveCount(0);
    await search.fill('Deno');
    await expect(extensions.locator('[data-pack]')).toHaveCount(0);
    await search.fill('.rs');
    await expect(extensions.locator('[data-pack]')).toHaveCount(1);
    await expect(extensions.locator('[data-pack="rust"]')).toBeVisible();
    await search.fill('does-not-exist');
    await expect(extensions.getByText('No language packs match your search.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(extensions).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Control+Shift+x');
    await expect(extensions).toBeVisible();
    await page.keyboard.press('Control+Shift+x');
    await expect(extensions).toHaveCount(0);
});

test('Extensions shortcut preserves the editor and supports Japanese and command palette access', async ({
    page
}) => {
    await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
    await page.goto(`${origin}?view=app`);
    const editor = page.getByRole('textbox', { name: 'Neovim入力' });
    await expect(
        page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+Shift+x');
    const extensions = page.getByRole('region', { name: '拡張機能', exact: true });
    const search = extensions.getByRole('textbox', { name: '言語パックを検索' });
    await expect(search).toBeFocused();
    await search.fill('診断');
    await expect(extensions.locator('[data-pack]')).toHaveCount(2);
    await extensions.getByRole('tab', { name: 'その他の拡張', exact: true }).click();
    await expect(extensions.locator('[data-pack="deno"]')).toContainText('Denoの導入が必要');
    await expect(extensions.getByRole('textbox', { name: 'その他の拡張を検索' })).toHaveValue('');
    await expect(
        extensions.getByRole('button', { name: '拡張機能を追加', exact: true })
    ).toBeVisible();
    await expect(extensions.locator('[data-feature]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(
        page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+Shift+p');
    const palette = page.getByRole('dialog', { name: 'すべてのコマンド' });
    await palette.getByRole('textbox').fill('拡張');
    await palette.getByRole('button', { name: /拡張機能/ }).click();
    await expect(extensions).toBeVisible();
    await extensions.getByRole('button', { name: '拡張機能を閉じる' }).click();
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

test('Extensions separates language packs from other extensions and supports keyboard tabs', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    await page.keyboard.press('Control+Shift+x');
    const extensions = page.getByRole('region', { name: 'Extensions', exact: true });
    const languagesTab = extensions.getByRole('tab', { name: 'Languages', exact: true });
    await expect(languagesTab).toHaveAttribute('aria-selected', 'true');
    await expect(extensions.locator('[data-pack]')).toHaveCount(2);
    const search = extensions.getByRole('textbox', { name: 'Search language packs' });
    await search.fill('Rust');
    await expect(extensions.locator('[data-pack]')).toHaveCount(1);
    await languagesTab.focus();
    await page.keyboard.press('ArrowRight');
    const otherTab = extensions.getByRole('tab', { name: 'Other extensions', exact: true });
    await expect(otherTab).toBeFocused();
    await expect(otherTab).toHaveAttribute('aria-selected', 'true');
    await expect(extensions.getByRole('tabpanel', { name: 'Other extensions' })).toBeVisible();
    await expect(extensions.locator('[data-pack]')).toHaveCount(1);
    await expect(extensions.locator('[data-pack="deno"]')).toBeVisible();
    const otherSearch = extensions.getByRole('textbox', { name: 'Search other extensions' });
    await expect(otherSearch).toHaveValue('');
    await otherSearch.fill('Rust');
    await expect(extensions.getByText('No extensions match your search.')).toBeVisible();
    await otherSearch.fill('Deno');
    await expect(extensions.locator('[data-pack="deno"]')).toBeVisible();
    await otherTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(languagesTab).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(extensions.locator('[data-pack]')).toHaveCount(2);
    await page.keyboard.press('ArrowLeft');
    await expect(otherTab).toBeFocused();
    await page.keyboard.press('Home');
    await expect(languagesTab).toBeFocused();
    await page.keyboard.press('End');
    await expect(otherTab).toBeFocused();
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

test('Git history counts all commits and supports paging without reloading the first page', async ({
    page
}) => {
    await page.goto(`${origin}?view=git&defer=gitHistory`);
    await page.addStyleTag({ content: '#root { display: flex; flex-direction: column; }' });
    await page.getByRole('button', { name: '2 History', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('gitHistory', 0, {
            total: 101,
            commits: Array.from({ length: 100 }, (_, index) => ({
                hash: index.toString(16).padStart(40, '0'),
                subject: `Commit ${index}`,
                author: 'Ada',
                date: '2026-01-01'
            }))
        })
    );
    await expect(page.getByText('Commits: 101', { exact: true })).toBeVisible();
    const list = page.getByRole('listbox', { name: 'Commit history' });
    const steps = await list.evaluate((node) => {
        const row = node.querySelector('[role="option"]')!;
        const rows = node.clientHeight / row.getBoundingClientRect().height;
        return { half: Math.max(1, Math.floor(rows / 2)), full: Math.max(1, Math.floor(rows)) };
    });
    await list.focus();
    for (const [key, index] of [
        ['Control+d', steps.half],
        ['Control+u', 0],
        ['Control+f', steps.full],
        ['Control+b', 0],
        ['PageDown', steps.full],
        ['PageUp', 0],
        ['G', 99],
        ['Control+d', 99],
        ['g', 0],
        ['Control+u', 0]
    ] as const) {
        await list.press(key);
        await expect(list).toHaveAttribute('aria-activedescendant', `git-entry-${index}`);
        await expect(list.getByRole('option', { selected: true })).toBeInViewport();
        await expect(
            page.getByRole('heading', { name: `Commit ${index}`, exact: true })
        ).toBeVisible();
    }
    await page.screenshot({ path: 'test-results/git-history-keyboard.png' });
    await page.getByRole('button', { name: 'Load older commits' }).click();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[1])).toBe(100);
    await list.press('Control+d');
    await expect(list).toHaveAttribute('aria-activedescendant', 'git-entry-0');
    await page.evaluate(() =>
        window.rendererTest.settle('gitHistory', 0, {
            total: 101,
            commits: [
                { hash: 'f'.repeat(40), subject: 'Older commit', author: 'Ada', date: '2025-01-01' }
            ]
        })
    );
    await expect(
        page.getByRole('listbox', { name: 'Commit history' }).getByRole('option')
    ).toHaveCount(101);
    await expect(page.getByRole('button', { name: 'Load older commits' })).toHaveCount(0);
    await expect(page.getByText('Commits: 101', { exact: true })).toBeVisible();
    await list.press('G');
    await expect(list).toHaveAttribute('aria-activedescendant', 'git-entry-100');
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
    await page.evaluate(() =>
        window.rendererTest.settle('gitHistory', 0, { commits: [], total: 0 })
    );
    await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeEnabled();
    await expect(page.getByText('Commits: 0', { exact: true })).toBeVisible();
    await list.press('Control+d');
    await expect(list).not.toHaveAttribute('aria-activedescendant');
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

test('workspace picker reaches connection and folder actions without a session type selector', async ({
    page
}) => {
    await page.goto(`${origin}?view=app`);
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
    await page.keyboard.press('Control+Shift+n');
    await expect(page.getByRole('listbox', { name: 'Folders', exact: true })).toBeFocused();
    await page.keyboard.press('Control+l');
    await expect(page.getByRole('textbox', { name: 'Folder path', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const parent = page.getByRole('button', { name: '↑ Parent', exact: true });
    await expect(parent).toBeFocused();
    await expect(page.getByRole('combobox', { name: 'Session type', exact: true })).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('combobox', { name: 'Connection', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(parent).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('folder loading preserves keyboard focus on the connection', async ({ page }) => {
    await page.goto(`${origin}?view=folders&defer=browseFolders`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Shift+Tab');
    const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
    await expect(connection).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, { path: '/alpha', parent: '/', folders: [] })
    );
    await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(connection).toBeFocused();
});

test('browsing folders moves focus to the list only if the user has not moved it', async ({
    page
}) => {
    await page.goto(`${origin}?view=folders&defer=browseFolders`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, { path: '/alpha', parent: '/', folders: [] })
    );
    const list = page.getByRole('listbox', { name: 'Folders' });
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('Control+l');
    await page.keyboard.type('/beta');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, { path: '/beta', parent: '/', folders: [] })
    );
    await expect(list).toBeFocused();
    await page.keyboard.press('Control+l');
    await page.keyboard.type('/gamma');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.keyboard.press('Shift+Tab');
    const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
    await expect(connection).toBeFocused();
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, { path: '/gamma', parent: '/', folders: [] })
    );
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(connection).toBeFocused();
});

test('creation entry chooses the session kind and cancelling resets the next editor request', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=favoriteWorkspaces`);
    await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('favoriteWorkspaces', 0, [
            { root: '/editor', name: 'Editor project', kind: 'editor' },
            { root: '/terminal', name: 'Terminal project', kind: 'terminal' }
        ])
    );
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('New terminal session');
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'folders palette' });
    await expect(picker).toContainText('New terminal session');
    await expect(
        picker.getByRole('option', { name: 'Favorite Terminal project (terminal)' })
    ).toHaveCount(1);
    await expect(
        picker.getByRole('option', { name: 'Favorite Editor project (editor)' })
    ).toHaveCount(0);
    await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('Control+l');
    await page.keyboard.type('/different/project');
    await page.keyboard.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .find((call) => call.method === 'createWorkspace')
                    ?.args.slice(0, 2)
            )
        )
        .toEqual(['/different/project', 'terminal']);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+n');
    await expect(picker).toContainText('Open a workspace');
    await expect(
        picker.getByRole('option', { name: 'Favorite Editor project (editor)' })
    ).toHaveCount(1);
    await expect(
        picker.getByRole('option', { name: 'Favorite Terminal project (terminal)' })
    ).toHaveCount(0);
    await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
        'aria-busy',
        'false'
    );
    await page.keyboard.press('Control+Enter');
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.rendererTest.calls
                    .filter((call) => call.method === 'createWorkspace')
                    .at(-1)
                    ?.args.slice(0, 2)
            )
        )
        .toEqual(['/alpha', 'editor']);
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
    await expect(list.getByRole('option')).toHaveCount(2);
    await list.press('j');
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-1');
    await page.evaluate(() =>
        window.rendererTest.render({
            favorites: [{ root: '/first', name: 'First', kind: 'editor' }]
        })
    );
    await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-0');
});

test('Switching WSL connections ignores stale listings and displays Linux paths', async ({
    page
}) => {
    await page.goto(`${origin}?view=folders&defer=browseFolders,wslDistributions`);
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'browseFolders')
                        .length
            )
        )
        .toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('wslDistributions', 0, ['Fedora', 'Ubuntu'])
    );
    const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
    await page.keyboard.press('Control+l');
    await page.keyboard.press('Shift+Tab');
    await expect(connection).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(connection).toHaveValue('Fedora');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'browseFolders')
                        .length
            )
        )
        .toBe(2);
    await page.keyboard.press('ArrowDown');
    await expect(connection).toHaveValue('Ubuntu');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.pending.filter((call) => call.method === 'browseFolders')
                        .length
            )
        )
        .toBe(3);
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 2, {
            path: '\\\\wsl.localhost\\Ubuntu\\home\\me',
            parent: '\\\\wsl.localhost\\Ubuntu\\home',
            folders: []
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 1, {
            path: '\\\\wsl.localhost\\Fedora\\home\\old',
            parent: '\\\\wsl.localhost\\Fedora\\home',
            folders: [{ name: 'STALE_WSL_FOLDER', path: 'old', directory: true }]
        })
    );
    await page.evaluate(() =>
        window.rendererTest.settle('browseFolders', 0, {
            path: '/alpha',
            parent: '/',
            folders: []
        })
    );
    const address = page.getByRole('textbox', { name: 'Folder path' });
    await expect(address).toHaveValue('/home/me');
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(connection).toBeFocused();
    await expect(page.getByText('STALE_WSL_FOLDER')).toHaveCount(0);
    await address.fill('/home/me/project with spaces');
    await address.press('Enter');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls
                        .filter((call) => call.method === 'browseFolders')
                        .at(-1)?.args
            )
        )
        .toEqual(['/home/me/project with spaces', 'Ubuntu']);
    await address.fill('\\\\wsl$\\Fedora\\home\\me\\direct');
    await address.press('Enter');
    await expect(connection).toHaveValue('Fedora');
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.rendererTest.calls
                        .filter((call) => call.method === 'browseFolders')
                        .at(-1)?.args
            )
        )
        .toEqual(['\\\\wsl$\\Fedora\\home\\me\\direct', 'Fedora']);
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

test('state patches coalesce without dropping diagnostics, other sessions or optional clears', async ({
    page
}) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=session-updates`);
    await page.evaluate(() => {
        window.rendererTest.emit({
            type: 'state',
            id: 'alpha',
            state: {
                buffers: [{ id: 1, name: '/alpha/main.rs', modified: false }],
                current: 1,
                mode: 'i',
                line: 1,
                column: 1,
                filetype: 'rust',
                lineEnding: 'LF',
                problems: [
                    {
                        path: '/alpha/main.rs',
                        line: 1,
                        column: 1,
                        severity: 1,
                        message: 'error',
                        source: 'rustc'
                    }
                ]
            }
        });
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { line: 9, column: 4, lspProgress: 'Indexing' }
        });
        window.rendererTest.emit({ type: 'statePatch', id: 'beta', state: { line: 3 } });
    });
    await page.clock.runFor(50);
    const states = await page.getByRole('status').textContent();
    expect(JSON.parse(states!)).toMatchObject({
        alpha: {
            line: 9,
            column: 4,
            mode: 'i',
            lineEnding: 'LF',
            problems: [{ message: 'error' }],
            buffers: [{ name: '/alpha/main.rs' }],
            lspProgress: 'Indexing'
        },
        beta: { line: 3, buffers: [], mode: 'n' }
    });
    await page.evaluate(() =>
        window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state: { lineEnding: undefined, mode: 'n' }
        })
    );
    await page.clock.runFor(50);
    const next = JSON.parse((await page.getByRole('status').textContent())!);
    expect(next.alpha.lineEnding).toBeUndefined();
    expect(next.alpha.mode).toBe('n');
    expect(next.alpha.problems).toHaveLength(1);
});

test('workspace changes apply only missing settings and changed values', async ({ page }) => {
    await page.goto(`${origin}?view=settings`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(4);
    const alpha = { id: 'alpha', name: 'Renamed Alpha', root: '/alpha' };
    const beta = { id: 'beta', name: 'Beta', root: '/beta' };
    await page.evaluate((alpha) => window.rendererTest.render({ workspaces: [alpha] }), alpha);
    await expect(page.getByRole('status')).toHaveText('Ready');
    await page.evaluate(
        ([alpha, beta]) => window.rendererTest.render({ workspaces: [beta, alpha] }),
        [alpha, beta]
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(8);
    expect(
        await page.evaluate(() => window.rendererTest.calls.slice(4).map((call) => call.args[0]))
    ).toEqual(['beta', 'beta', 'beta', 'beta']);
    await page.evaluate(
        ([alpha, beta]) =>
            window.rendererTest.render({
                workspaces: [alpha, beta],
                settings: {
                    clipboardSharing: true,
                    relativeLineNumbers: true,
                    editorConfig: true,
                    wordWrap: true
                }
            }),
        [alpha, beta]
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(10);
    expect(await page.evaluate(() => window.rendererTest.calls.slice(8))).toEqual([
        { method: 'setWordWrap', args: ['alpha', true] },
        { method: 'setWordWrap', args: ['beta', true] }
    ]);
    await page.evaluate(
        ([alpha, beta]) =>
            window.rendererTest.render({
                workspaces: [
                    { ...alpha, terminalId: 'shell' },
                    beta,
                    { id: 'terminal', root: '/terminal', name: 'Terminal', kind: 'terminal' }
                ]
            }),
        [alpha, beta]
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(12);
    expect(await page.evaluate(() => window.rendererTest.calls.slice(10))).toEqual([
        { method: 'setClipboardSharing', args: ['shell', true] },
        { method: 'setClipboardSharing', args: ['terminal', true] }
    ]);
});

test('Explorer discards obsolete manual refreshes and loads started before a file change', async ({
    page
}) => {
    await page.goto(`${origin}?view=app&defer=files`);
    await expect
        .poll(() =>
            page.evaluate(
                () => window.rendererTest.pending.filter((call) => call.method === 'files').length
            )
        )
        .toBe(1);
    const tree = page.getByRole('tree', { name: 'Project files' });
    const initial = [{ name: 'initial.txt', path: 'initial.txt', directory: false }];
    await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
    await expect(tree).toContainText('initial.txt');
    const refresh = page.getByRole('button', { name: 'Refresh files' });
    await refresh.click();
    await refresh.click();
    const fresh = [{ name: 'fresh.txt', path: 'fresh.txt', directory: false }];
    await page.evaluate((value) => window.rendererTest.settle('files', 1, value), fresh);
    await expect(tree).toContainText('fresh.txt');
    await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
    await expect(tree).toContainText('fresh.txt');
    await expect(tree).not.toContainText('initial.txt');
    await refresh.click();
    await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
    await expect
        .poll(() =>
            page.evaluate(
                () => window.rendererTest.pending.filter((call) => call.method === 'files').length
            )
        )
        .toBe(2);
    await page.evaluate((value) => window.rendererTest.settle('files', 1, value), fresh);
    await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
    await expect(tree).toContainText('fresh.txt');
    await expect(tree).not.toContainText('initial.txt');
});

test('unchanged Git polls avoid commits while changed and removed badges still update', async ({
    page
}) => {
    await page.goto(`${origin}?view=badges&defer=gitStatus`);
    const status = {
        root: '/alpha',
        branch: 'main',
        changes: [{ path: 'first.ts', status: 'M', staged: false }]
    };
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate((value) => window.rendererTest.settle('gitStatus', 0, value), status);
    const badges = page.getByRole('status');
    await expect(badges).toContainText('Modified');
    const commits = await badges.getAttribute('data-commits');
    await page.evaluate((value) => {
        window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
        window.rendererTest.settle('gitStatus', 0, value);
    }, status);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(0);
    expect(await badges.getAttribute('data-commits')).toBe(commits);
    await page.evaluate(
        (value) => {
            window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
            window.rendererTest.settle('gitStatus', 0, value);
        },
        { ...status, changes: [{ ...status.changes[0], staged: true }] }
    );
    await expect(badges).toContainText('(staged)');
    await page.evaluate(
        (value) => {
            window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
            window.rendererTest.settle('gitStatus', 0, value);
        },
        { ...status, changes: [] }
    );
    await expect(badges).toHaveText('{}');
});

test('Git changes during an in-flight poll trigger a fresh request without waiting for the next poll', async ({
    page
}) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=badges&defer=gitStatus`);
    await page.clock.runFor(250);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() => {
        window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
        window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
        window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] });
    });
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.settle('gitStatus', 0, {
            root: '/alpha',
            branch: 'main',
            changes: [{ path: 'first.ts', status: 'M', staged: false }]
        })
    );
    await expect(page.getByRole('status')).toContainText('Modified');
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
        )
    ).toBe(2);
});

test('settings ignore obsolete failures after a newer request for the same value succeeds', async ({
    page
}) => {
    await page.goto(`${origin}?view=settings&defer=setWordWrap`);
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    await page.evaluate(() =>
        window.rendererTest.render({
            settings: {
                clipboardSharing: true,
                relativeLineNumbers: true,
                editorConfig: true,
                wordWrap: true
            }
        })
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(2);
    await page.evaluate(() =>
        window.rendererTest.render({
            settings: {
                clipboardSharing: true,
                relativeLineNumbers: true,
                editorConfig: true,
                wordWrap: false
            }
        })
    );
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(3);
    await page.evaluate(() => {
        window.rendererTest.settle('setWordWrap', 2, undefined);
        window.rendererTest.settle('setWordWrap', 0, 'Obsolete request failed', true);
        window.rendererTest.render({
            workspaces: [{ id: 'alpha', root: '/alpha', name: 'Renamed' }]
        });
    });
    await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
    expect(
        await page.evaluate(
            () => window.rendererTest.calls.filter((call) => call.method === 'setWordWrap').length
        )
    ).toBe(3);
});

test('cursor-only patches preserve completion and a normal-mode patch dismisses it', async ({
    page
}) => {
    await page.goto(`${origin}?view=completion`);
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
        window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { line: 2, column: 3 } })
    );
    await expect(menu).toBeVisible();
    await page.evaluate(() =>
        window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { mode: 'n' } })
    );
    await expect(menu).toHaveCount(0);
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
