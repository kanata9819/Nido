import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './renderer/harness';
import { applyNeovimUI, emptyNeovimUI } from '../src/shared/neovimUI';
import { requireWebGLCorrection } from './helpers/row-image-probe';

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
    (items) => window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: true }),
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

for (const [scale, size, family] of [
  [1, 15, '"Cascadia Code", monospace'],
  [1.25, 18, '"Cascadia Code", monospace'],
  [1.5, 15, 'serif']
] as const) {
  test(`Sticky Scroll preserves editor cells and relative numbers at ${scale * 100}% scale`, async ({
    browser
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.addInitScript(
        ({ size, family }) => {
          localStorage.setItem('nido.language', 'en');
          localStorage.setItem('nido.fontSize', String(size));
          localStorage.setItem('nido.fontFamily', family);
          localStorage.setItem('nido.animations', 'false');
        },
        { size, family }
      );
      await page.goto(`${origin}?view=app`);
      const display = page.locator('canvas[aria-label="Neovim editor display"]');
      await expect(display).toBeVisible();
      const publish = async (relativeTo?: number): Promise<void> => {
        await page.evaluate((relativeTo) => {
          window.rendererTest.emit({
            type: 'redraw',
            id: 'alpha',
            events: [
              [
                'nido_sticky_scroll',
                [
                  {
                    window: 1,
                    buffer: 1,
                    top: 0,
                    left: 0,
                    width: 60,
                    height: 24,
                    gutter: 4,
                    tabstop: 8,
                    leftcol: 0,
                    relativeTo,
                    scopes: [
                      {
                        line: 27,
                        ending: 90,
                        top: -1,
                        bottom: 30,
                        text: [
                          { text: 'i', color: '#ffffff', cells: 1 },
                          { text: 'm', color: '#ffffff', cells: 1 },
                          { text: '日', color: '#ffffff', cells: 2 },
                          { text: 'e\u0301', color: '#ffffff', cells: 1 },
                          { text: '\t', color: '#ffffff', cells: 3 },
                          ...Array.from({ length: 200 }, () => ({
                            text: 'x',
                            color: '#ffffff',
                            cells: 1
                          })),
                          { text: 'W', color: '#ffffff', cells: 1 }
                        ],
                        endText: [{ text: '}', color: '#ffffff', cells: 1 }]
                      }
                    ]
                  }
                ]
              ],
              ['flush']
            ]
          });
        }, relativeTo);
      };
      await publish(32);
      const sticky = page.getByRole('navigation', { name: 'Sticky Scroll' });
      const header = sticky.locator('[data-source-line="27"]');
      await expect(header).toHaveAttribute('aria-label', 'Go to line 27');
      const number = header.locator(':scope > span').first();
      await expect(number).toHaveText('5');
      const layout = await header.evaluate(
        async (node, { url, size, family }) => {
          const { Grid } = await import(url);
          const grid = new Grid();
          grid.apply([['grid_resize', [1, 60, 24]], ['flush']]);
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const { cellWidth } = grid.draw(
            canvas,
            600,
            432,
            size,
            family,
            false,
            undefined,
            18,
            350
          );
          canvas.remove();
          const code = node.children[1];
          const spans = [...code.querySelectorAll<HTMLElement>('span[style*="color"]')];
          const start = code.getBoundingClientRect().left;
          return {
            cellWidth,
            spans: spans.map((span) => ({
              left: span.getBoundingClientRect().left - start,
              width: span.getBoundingClientRect().width,
              size: getComputedStyle(span).fontSize,
              weight: getComputedStyle(span).fontWeight
            }))
          };
        },
        { url: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`, size, family }
      );
      const columns = [0, 1, 2, 4, 5, ...Array.from({ length: 201 }, (_, index) => index + 8)];
      expect(layout.spans).toHaveLength(columns.length);
      for (const [index, column] of columns.entries()) {
        expect(
          Math.abs(layout.spans[index].left - column * layout.cellWidth),
          JSON.stringify(layout)
        ).toBeLessThan(0.1);
        expect(layout.spans[index].size).toBe(`${size}px`);
        expect(layout.spans[index].weight).toBe('350');
      }
      await publish(33);
      await expect(number).toHaveText('6');
      await header.hover();
      await page.keyboard.down('Shift');
      await expect(header).toHaveAttribute('aria-label', 'Go to line 90');
      await expect(number).toHaveText('57');
      await page.keyboard.up('Shift');
      await publish(27);
      await expect(number).toHaveText('27');
      await publish();
      await expect(number).toHaveText('27');
    } finally {
      await context.close();
    }
  });
}

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
              [1, { underline: true, special: 0xffffff }, {}, [{ hi_name: 'NidoBracketMatch' }]],
              [2, { background: 0xffffff, blend: 88 }, {}, [{ hi_name: 'LspReferenceRead' }]],
              [3, { background: 0xffffff, blend: 80 }, {}, [{ hi_name: 'LspReferenceWrite' }]]
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
            Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data).slice(
              0,
              3
            );
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

for (const scale of [1, 1.25, 1.5]) {
  test(`text underlines stay close to glyphs independently of line spacing at ${scale * 100}% scale`, async ({
    browser
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.route('**/underline-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<body></body>' })
      );
      await page.goto(`${origin}underline-probe`);
      const results = await page.evaluate(
        async (url) => {
          const { Grid } = await import(url);
          return [
            [11, 18],
            [14, 24],
            [14, 36]
          ].map(([fontSize, lineHeight]) => {
            const grid = new Grid();
            grid.busy = true;
            grid.apply([
              ['grid_resize', [1, 40, 4]],
              ['hl_attr_define', [1, { underline: true, special: 0xff00ff }, {}, []]],
              ['grid_line', [1, 0, 0, Array.from('mutable_name', (text) => [text, 1])]],
              ['flush']
            ]);
            let baseline = 0;
            let underline = 0;
            const prototype = CanvasRenderingContext2D.prototype;
            const text = prototype.fillText;
            const fill = prototype.fillRect;
            prototype.fillText = function (...args) {
              if (args[0] === 'm') baseline = args[2];
              text.apply(this, args);
            };
            prototype.fillRect = function (...args) {
              if (this.fillStyle === '#ff00ff') underline = args[1];
              fill.apply(this, args);
            };
            const canvas = document.createElement('canvas');
            document.body.append(canvas);
            try {
              const { cellWidth } = grid.draw(
                canvas,
                400,
                lineHeight * 4,
                fontSize,
                'monospace',
                true,
                undefined,
                lineHeight
              );
              const pixel = Array.from(
                canvas
                  .getContext('2d')!
                  .getImageData(
                    Math.floor(cellWidth * 0.5 * devicePixelRatio),
                    Math.floor((underline + 0.5) * devicePixelRatio),
                    1,
                    1
                  ).data
              );
              return { gap: underline - baseline, pixel };
            } finally {
              prototype.fillText = text;
              prototype.fillRect = fill;
            }
          });
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
      );
      for (const result of results) {
        expect(result.gap).toBeGreaterThanOrEqual(1);
        expect(result.gap).toBeLessThanOrEqual(2);
        expect(result.pixel[0] - result.pixel[1]).toBeGreaterThan(100);
        expect(result.pixel[2] - result.pixel[1]).toBeGreaterThan(100);
      }
    } finally {
      await context.close();
    }
  });
}

for (const scale of [1, 1.25, 1.5]) {
  for (const opacity of [1, 0.5]) {
    test(`inline diagnostic capsules retain rounded corners, accents and cached rows at ${scale * 100}% scale, opacity ${opacity}`, async ({
      browser
    }) => {
      const context = await browser.newContext({ deviceScaleFactor: scale });
      try {
        const page = await context.newPage();
        await page.route('**/diagnostic-probe', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
        );
        await page.goto(`${origin}diagnostic-probe`);
        const result = await page.evaluate(
          async ({ moduleUrl, opacity }) => {
            const { Grid } = await import(moduleUrl);
            const grid = new Grid();
            grid.background = '#121212';
            grid.backgroundOpacity = opacity;
            grid.busy = true;
            const code = 'fn main() {}   ';
            const annotation = '  ERROR · expected `;`  ';
            grid.apply([
              ['grid_resize', [1, 60, 4]],
              [
                'hl_attr_define',
                [
                  1,
                  {
                    foreground: 0xcbb9be,
                    background: 0x261c20,
                    special: 0xe58c98
                  },
                  {},
                  [{ hi_name: 'DiagnosticVirtualTextError' }]
                ]
              ],
              [
                'grid_line',
                [
                  1,
                  0,
                  0,
                  [
                    ...Array.from(code, (text) => [text, 0]),
                    ...Array.from(annotation, (text) => [text, 1])
                  ]
                ]
              ],
              ['flush']
            ]);
            let roundedShapes = 0;
            const roundRect = CanvasRenderingContext2D.prototype.roundRect;
            CanvasRenderingContext2D.prototype.roundRect = function (...args) {
              roundedShapes++;
              roundRect.apply(this, args);
            };
            const canvas = document.createElement('canvas');
            document.body.append(canvas);
            const draw = (): { cellWidth: number } =>
              grid.draw(canvas, 600, 96, 14, 'monospace', true, undefined, 24);
            const { cellWidth } = draw();
            const left = Math.round(code.length * cellWidth * devicePixelRatio) / devicePixelRatio;
            const pixel = (x: number, y: number): number[] =>
              Array.from(
                canvas
                  .getContext('2d')!
                  .getImageData(
                    Math.round(x * devicePixelRatio),
                    Math.round(y * devicePixelRatio),
                    1,
                    1
                  ).data
              ).slice(0, 3);
            const corner = pixel(left, 2);
            const background = pixel(left + 11, 12);
            const accent = pixel(left + 5, 12);
            const firstShapes = roundedShapes;
            draw();
            grid.scrolling = true;
            grid.scrollOffset = 0.25;
            draw();
            const cachedShapes = roundedShapes;
            grid.scrolling = false;
            grid.scrollOffset = 0;
            grid.apply([
              ['grid_line', [1, 0, code.length, [[' ', 0, annotation.length]]]],
              ['flush']
            ]);
            draw();
            const erased = pixel(left + 5, 12);
            return { corner, background, accent, firstShapes, cachedShapes, erased };
          },
          {
            moduleUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
            opacity
          }
        );
        // Edge pixels include the faint outline's antialiasing at 100% DPI.
        expect(result.corner[0]).toBeLessThan(result.background[0] - 5);
        expect(result.background).toEqual([38, 28, 32]);
        expect(result.accent).toEqual([229, 140, 152]);
        expect(result.firstShapes).toBe(2);
        expect(result.cachedShapes).toBe(result.firstShapes);
        expect(result.erased).toEqual([18, 18, 18]);
      } finally {
        await context.close();
      }
    });
  }
}

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
          window.rendererTest.calls.filter((call) => call.method === 'selectCompletion').at(-1)
            ?.args
      )
    )
    .toEqual(['alpha', 1]);
  await expect(input).toBeFocused();
  await command.getByRole('button', { name: 'Cancel command' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
      )
    )
    .toEqual(['alpha', '<Esc>']);
  state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
  await emit();
  await expect(command).toHaveCount(0);
  await expect(input).not.toHaveAttribute('data-nvim-command-active');
});

test('command completion bounds large lists while preserving selection and manual scrolling', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  let state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [[[0, 'edit ']], 5, ':', '', 0, 1]);
  state = applyNeovimUI(state, 'popupmenu_show', [
    Array.from({ length: 10000 }, (_, index) => [`候補${index}日本😀`, '', `detail ${index}`, '']),
    0,
    0,
    0,
    -1
  ]);
  const publish = async (): Promise<void> => {
    await page.evaluate(
      (state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
      state
    );
  };
  await publish();
  const list = page.getByRole('listbox', { name: 'Command completion' });
  await expect(list).toBeVisible();
  const before = await list.evaluate((node) => ({
    count: node.querySelectorAll('[role="option"]').length,
    rowHeight: node.querySelector('[role="option"]')!.getBoundingClientRect().height
  }));
  console.log('command-completion-rows', JSON.stringify(before));
  expect(before.count).toBeLessThan(60);
  state = applyNeovimUI(state, 'popupmenu_select', [9999]);
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'neovimUIPatch',
      id: 'alpha',
      state: { completion: { selected: 9999 } }
    })
  );
  const selected = list.locator('[aria-selected="true"]');
  await expect(selected).toContainText('候補9999日本😀');
  await expect(selected).toHaveAttribute('aria-posinset', '10000');
  await expect(selected).toHaveAttribute('aria-setsize', '10000');
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toHaveAttribute(
    'aria-activedescendant',
    'neovim-completion-alpha-9999'
  );
  const visible = async (): Promise<boolean> =>
    selected.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const list = node.closest('[role="listbox"]')!.getBoundingClientRect();
      const pixel = 1 / devicePixelRatio;
      return bounds.top >= list.top - pixel && bounds.bottom <= list.bottom + pixel;
    });
  await expect.poll(visible).toBe(true);
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(list.getByRole('option').first()).toContainText('候補0日本😀');
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  expect(await list.getByRole('option').count()).toBeLessThan(60);
  await list.getByRole('option').first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.rendererTest.calls.filter((call) => call.method === 'selectCompletion').at(-1)
            ?.args
      )
    )
    .toEqual(['alpha', 0]);
  await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
  state = applyNeovimUI(state, 'popupmenu_show', [[['short', '', '', '']], -1, 0, 0, -1]);
  await publish();
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option')).toContainText('short');
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
  const state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [[[0, 'echo 1']], 6, ':', '', 0, 1]);
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
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
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
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
      )
    )
    .toEqual(['alpha', '<CR>']);
  await expect(messages).toBeVisible();
  state = applyNeovimUI(state, 'msg_clear', []);
  await emit();
  await expect(messages).toHaveCount(0);

  state = applyNeovimUI(state, 'cmdline_show', [
    [[0, '']],
    0,
    '',
    'Do you really want to write to it (y/n)?',
    0,
    1
  ]);
  await emit();
  const command = page.getByRole('dialog', { name: 'Neovim command line' });
  await expect(command).toBeVisible();
  await page.keyboard.press('n');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
      )
    )
    .toEqual(['alpha', 'n']);
  await command.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args
      )
    )
    .toEqual(['alpha', '<Esc>']);
  state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
  await emit();
  await expect(command).toHaveCount(0);
  await expect(input).toBeFocused();
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
    (items) => window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
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
  await expect(content.locator('article[data-severity="warning"]')).toContainText('unused_parens');
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
    (items) => window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
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
        () => window.rendererTest.calls.filter((call) => call.method === 'input').at(-1)?.args[1]
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
            message: items[0].message + '\n' + 'Detailed compiler explanation.\n'.repeat(60)
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
      content.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop))
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
  await expect(page.getByRole('dialog', { name: 'Type information', exact: true })).toHaveCount(0);
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

test('type information ignores documentation failures from replaced or closed cards', async ({
  page
}) => {
  await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
  await page.goto(`${origin}?view=app&defer=openDocumentation`);
  const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
  const card = page.getByRole('dialog', { name: 'Type information', exact: true });
  await expect(editor).toBeFocused();
  const show = async (markdown: string): Promise<void> => {
    await page.evaluate(
      (markdown) =>
        window.rendererTest.emit({
          type: 'hover',
          id: 'alpha',
          markdown,
          filetype: 'rust',
          codeBlocks: []
        }),
      markdown
    );
    await expect(card).toContainText(markdown.match(/\[([^\]]+)\]/)?.[1] || markdown);
  };
  await show('[Old docs](https://example.com/old)');
  await card.getByRole('link', { name: 'Old docs', exact: true }).click();
  await show('[Current docs](https://example.com/current)');
  await card.getByRole('link', { name: 'Current docs', exact: true }).click();
  await page.evaluate(() =>
    window.rendererTest.settle('openDocumentation', 0, 'Obsolete documentation failure', true)
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expect(card.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() =>
    window.rendererTest.settle('openDocumentation', 0, 'Current documentation failure', true)
  );
  await expect(card.getByRole('alert')).toHaveText('Current documentation failure');
  await show('[Closing docs](https://example.com/closing)');
  await card.getByRole('link', { name: 'Closing docs', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(editor).toBeFocused();
  await show('A newly opened type card');
  await page.evaluate(() =>
    window.rendererTest.settle('openDocumentation', 0, 'Closed documentation failure', true)
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((call) => call.method === 'openDocumentation')
        .map((call) => call.args)
    )
  ).toEqual([
    ['https://example.com/old'],
    ['https://example.com/current'],
    ['https://example.com/closing']
  ]);
});

test('passive diagnostics return focus from replaced type information without stealing outside focus', async ({
  page
}) => {
  await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
  await page.goto(`${origin}?view=app`);
  const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
  const card = page.getByRole('dialog', { name: 'Type information', exact: true });
  const diagnostics = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
  const showType = async (): Promise<void> => {
    await page.evaluate(() =>
      window.rendererTest.emit({
        type: 'hover',
        id: 'alpha',
        markdown: 'Type details being read',
        filetype: 'rust',
        codeBlocks: []
      })
    );
    await expect(page.getByLabel('Type information content', { exact: true })).toBeFocused();
  };
  const showPassiveDiagnostics = async (): Promise<void> => {
    await page.evaluate(
      (items) =>
        window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
      diagnosticItems
    );
    await expect(card).toHaveCount(0);
    await expect(diagnostics).toBeVisible();
  };
  await expect(editor).toBeFocused();
  await showType();
  await showPassiveDiagnostics();
  await expect(editor).toBeFocused();
  await page.keyboard.type('a');
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((call) => call.method === 'input').map((call) => call.args)
    )
  ).toEqual([['alpha', 'a']]);
  await showType();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await showPassiveDiagnostics();
  await expect(settings).toBeFocused();
  await showType();
  await showDiagnosticCard(page);
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel('Diagnostic content', { exact: true })).toBeFocused();
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
      page.evaluate(() => window.rendererTest.pending.some((call) => call.method === 'attach'))
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
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) {
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
  await page.evaluate(() => window.rendererTest.settle('attach', 0, 'Editor startup failed', true));
  await page.clock.runFor(50);
  await expect(loading).toHaveCount(0);
  await expect(page.getByText('Editor startup failed', { exact: true })).toBeVisible();
});

for (const reject of [false, true]) {
  test(`editor resize keeps only the latest dimensions behind a ${reject ? 'failed' : 'slow'} request`, async ({
    page
  }) => {
    await pauseRendererClock(page);
    await page.goto(`${origin}?view=app&defer=resize`);
    await page.clock.runFor(100);
    const paintWidth = async (width: number): Promise<void> => {
      await page.evaluate((width) => {
        const host = document.querySelector(
          'canvas[aria-label="Neovim editor display"]'
        )?.parentElement;
        if (!host) throw new Error('Missing editor host');
        host.style.width = `${width}px`;
        window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['flush']] });
      }, width);
      await page.clock.runFor(32);
    };
    await paintWidth(600);
    for (let pass = 0; pass < 3; pass++) {
      await page.evaluate(() => {
        while (window.rendererTest.pending.some((call) => call.method === 'resize')) {
          window.rendererTest.settle('resize', 0, undefined);
        }
      });
      await page.clock.runFor(32);
    }
    const before = await page.evaluate(() => {
      const resizes = window.rendererTest.calls.filter((call) => call.method === 'resize');
      return { count: resizes.length, dimensions: resizes.at(-1)!.args };
    });
    for (let index = 0; index < 20; index++) {
      await paintWidth(index === 19 ? 600 : 800 + index * 10);
    }
    const queued = await page.evaluate(() => ({
      pending: window.rendererTest.pending.filter((call) => call.method === 'resize').length,
      calls: window.rendererTest.calls.filter((call) => call.method === 'resize').length
    }));
    expect(queued.pending).toBe(1);
    expect(queued.calls - before.count).toBe(1);
    await page.evaluate((reject) => {
      window.rendererTest.settle('resize', 0, reject ? 'Resize interrupted' : undefined, reject);
    }, reject);
    await page.clock.runFor(32);
    const latest = await page.evaluate(() => {
      const resizes = window.rendererTest.calls.filter((call) => call.method === 'resize');
      return {
        pending: window.rendererTest.pending.filter((call) => call.method === 'resize').length,
        calls: resizes.length,
        dimensions: resizes.at(-1)!.args
      };
    });
    expect(latest.pending).toBe(1);
    expect(latest.calls - before.count).toBe(2);
    expect(latest.dimensions).toEqual(before.dimensions);
    await page.evaluate(() => window.rendererTest.settle('resize', 0, undefined));
    await page.clock.runFor(32);
    expect(
      await page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'resize').length
      )
    ).toBe(0);
    if (reject) {
      await expect(page.getByText('Resize interrupted', { exact: true })).toBeVisible();
    }
    await paintWidth(800);
    await paintWidth(900);
    const beforeClose = await page.evaluate(
      () => window.rendererTest.calls.filter((call) => call.method === 'resize').length
    );
    await page.evaluate(() => window.rendererTest.emit({ type: 'exit', id: 'alpha' }));
    await page.clock.runFor(32);
    await expect(page.locator('canvas[aria-label="Neovim editor display"]')).toHaveCount(0);
    await page.evaluate(() => window.rendererTest.settle('resize', 0, undefined));
    await page.clock.runFor(32);
    expect(
      await page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'resize').length
      )
    ).toBe(beforeClose);
    console.log('editor-resize-backpressure', JSON.stringify({ reject, queued, latest }));
  });
}

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

  test(`font weight refreshes cached glyphs and preserves emphasis at ${scale * 100}% scale`, async ({
    browser
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(
        async (moduleUrl) => {
          const { Grid } = await import(moduleUrl);
          const grid = new Grid();
          grid.busy = true;
          grid.background = '#121212';
          grid.foreground = '#ffffff';
          grid.pixelScrollEnabled = true;
          grid.apply([
            ['grid_resize', [1, 40, 6]],
            ['hl_attr_define', [1, { bold: true }, {}, []], [2, { italic: true }, {}, []]],
            [
              'grid_line',
              [
                1,
                0,
                0,
                [
                  ['n', 0],
                  ['日', 0],
                  ['', 0],
                  ['本', 0],
                  ['', 0]
                ]
              ],
              [1, 1, 0, [['b', 1]]],
              [1, 2, 0, [['i', 2]]]
            ],
            ['flush']
          ]);
          const canvas = document.createElement('canvas');
          const family = '"Cascadia Code", monospace';
          const fillText = CanvasRenderingContext2D.prototype.fillText;
          const calls: { text: string; font: string; x: number; y: number }[] = [];
          CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
            calls.push({ text, font: this.font, x, y });
            return Reflect.apply(fillText, this, [text, x, y, ...rest]);
          };
          try {
            const paint = (weight: number): { cellWidth: number; cellHeight: number } =>
              grid.draw(canvas, 400, 152, 15, family, false, undefined, 19, weight);
            const pixels = (): Uint8ClampedArray =>
              canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
            const initial = paint(400);
            const before = pixels();
            const initialCalls = calls.splice(0);
            const lighter = paint(350);
            const lighterCalls = calls.splice(0);
            paint(350);
            const repeatedGlyphs = calls.splice(0).length;
            paint(400);
            const restored = pixels();
            return {
              initial,
              lighter,
              initialCalls,
              lighterCalls,
              repeatedGlyphs,
              restoredPixels: before.reduce(
                (count, value, i) => count + Number(value !== restored[i]),
                0
              )
            };
          } finally {
            CanvasRenderingContext2D.prototype.fillText = fillText;
          }
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
      );
      expect(result.lighter).toEqual(result.initial);
      expect(result.lighterCalls.map(({ text, x, y }) => ({ text, x, y }))).toEqual(
        result.initialCalls.map(({ text, x, y }) => ({ text, x, y }))
      );
      expect(result.lighterCalls.find(({ text }) => text === 'n')?.font).toContain('350 ');
      expect(result.lighterCalls.find(({ text }) => text === '日')?.font).toContain('350 ');
      expect(result.lighterCalls.find(({ text }) => text === 'b')?.font).toContain('bold ');
      expect(result.lighterCalls.find(({ text }) => text === 'i')?.font).toContain('italic 350 ');
      expect(result.repeatedGlyphs).toBe(0);
      expect(result.restoredPixels).toBe(0);
    } finally {
      await context.close();
    }
  });

  test(`editor text reuses native opaque rasters at ${scale * 100}% scale`, async ({ browser }) => {
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
            ['hl_attr_define', [1, { bold: true }, {}, []], [2, { italic: true }, {}, []]],
            ...[0, 1, 2, 3].map((row) => [
              'grid_line',
              [1, row, 0, Array.from('alacritty(options)?,', (text) => [text, row % 3])]
            ]),
            ['flush']
          ]);
          const canvas = document.createElement('canvas');
          let originalRows: HTMLCanvasElement[] = [];
          let paintedRows: HTMLCanvasElement[] = [];
          let copies = 0;
          let resampled = 0;
          let mismatches = 0;
          const drawImage = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function (...args) {
            Reflect.apply(drawImage, this, args);
            const source = args[0];
            if (!(source instanceof HTMLCanvasElement)) return;
            if (this.canvas !== canvas) {
              const width = Number(args[args.length === 9 ? 7 : 3] ?? source.width);
              const height = Number(args[args.length === 9 ? 8 : 4] ?? source.height);
              const transform = this.getTransform();
              if (
                Math.abs(width * transform.a - source.width) > 0.001 ||
                Math.abs(height * transform.d - source.height) > 0.001
              )
                resampled++;
              return;
            }
            if (!source.getContext('2d')) {
              return;
            }
            copies++;
            paintedRows.push(source);
            const y = Number(args[2]) * devicePixelRatio;
            const top = Math.round(y);
            // Fractional movement is composited once on the destination.
            // At integer positions it must still be an exact native copy.
            if (Math.abs(y - top) > 0.001) return;
            // Only compare the visible portion of a row.
            const height = Math.min(source.height, canvas.height - top);
            const expected = source.getContext('2d')!.getImageData(0, 0, 220, height).data;
            const actual = this.getImageData(0, top, 220, height).data;
            for (let i = 0; i < expected.length; i++) {
              if (expected[i] !== actual[i]) mismatches++;
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
            opaqueRows: originalRows.every(
              (row) => !row.getContext('2d')!.getContextAttributes().alpha
            ),
            resampled,
            mismatches,
            nativeRows: paintedRows.every((row, index) => row === originalRows[index])
          };
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
      );
      expect(samples.copies).toBe(10);
      expect(
        samples.nativeRows,
        'settled fractional scrolling must reuse the native glyph images'
      ).toBe(true);
      expect(samples.opaqueRows, 'opaque themes must allow the native LCD text raster').toBe(true);
      expect(samples.resampled, 'rows must not use an interpolated intermediate bitmap').toBe(0);
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
            ['hl_attr_define', [1, { foreground: 0xffffff, background: 0x191e23 }, {}, []]],
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
                const native = reference.getContext('2d', { alpha: false })!;
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
                const expected = native.getImageData(0, 0, reference.width, reference.height).data;
                const actual = ctx.getImageData(
                  0,
                  56 * dpr,
                  reference.width,
                  reference.height
                ).data;
                nativeMismatches = actual.reduce(
                  (count, value, index) => count + Number(value !== expected[index]),
                  0
                );
              }
              const top = Math.floor(40 * dpr);
              const width = Math.floor(120 * dpr);
              const pixels = ctx.getImageData(0, top, width, Math.ceil(48 * dpr)).data;
              const light = (value: number): number => {
                const encoded = value / 255;
                return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
              };
              const background = light(pixels[0]);
              let mass = 0;
              let moment = 0;
              for (let offset = 0; offset < pixels.length; offset += 4) {
                const coverage = Math.max(0, light(pixels[offset]) - background);
                mass += coverage;
                moment += coverage * (top + Math.floor(offset / 4 / width));
              }
              positions.push(moment / mass);
            }
            grid.apply([
              ['grid_line', [1, 2, 0, Array.from('MMMMMMMMMMMM', (text) => [text, 1])]],
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
      const steps = samples.positions.slice(1).map((y, index) => samples.positions[index] - y);
      expect(steps.every((step) => step >= -0.02)).toBe(true);
      expect(
        Math.max(...steps),
        'eighth-pixel input must not stall and jump a whole physical pixel'
      ).toBeLessThanOrEqual(0.16);
      expect(samples.positions[0] - samples.positions.at(-1)!).toBeCloseTo(2, 1);
      expect(samples.nativeMismatches, 'resting text must preserve its native pixels').toBe(0);
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
      await requireWebGLCorrection(page);
      const samples = await page.evaluate(
        async (moduleUrl) => {
          const { Grid } = await import(moduleUrl);
          const dpr = devicePixelRatio;
          const light = (value: number): number => {
            const encoded = value / 255;
            return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
          };
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
              ['grid_line', [1, 2, 0, Array.from('Il1|[](){}MWmw', (text) => [text, 0])]],
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
                const weight = Math.max(0, light(data[i]) - light(18));
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
              inkVariation = Math.max(inkVariation, Math.abs(measured.ink / initial.ink - 1));
              const before = canvas
                .getContext('2d')!
                .getImageData(0, 0, canvas.width, canvas.height).data;
              const offset = grid.scrollOffset;
              grid.scrolling = false;
              paint();
              settlingDistance = Math.max(settlingDistance, Math.abs(grid.scrollOffset - offset));
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
      expect(samples.inkVariation, 'moving glyphs keep their total coverage').toBeLessThan(0.01);
      expect(samples.settlingPixels, 'pausing input must not sharpen or move the text').toBe(0);
      expect(samples.settlingDistance, 'pausing input must not change the viewport offset').toBe(0);
      expect(Math.min(...samples.steps), 'rebasing must not reverse the movement').toBeGreaterThan(
        0.05
      );
      expect(Math.max(...samples.steps), 'rebasing must not jump a physical pixel').toBeLessThan(
        0.15
      );
      expect(samples.origins).toEqual([19, -19]);
    } finally {
      await context.close();
    }
  });
  test(`fractional text preserves light and motion across themes at ${scale * 100}% scale`, async ({
    browser
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.route('**/light-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
      );
      await page.goto(`${origin}light-probe`);
      await requireWebGLCorrection(page);
      const results = await page.evaluate(
        async (moduleUrl) => {
          const { Grid } = await import(moduleUrl);
          const light = Array.from({ length: 256 }, (_, value) => {
            const encoded = value / 255;
            return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
          });
          const luminance = (red: number, green: number, blue: number): number =>
            0.2126 * light[red] + 0.7152 * light[green] + 0.0722 * light[blue];
          const results: {
            variation: number;
            minStep: number;
            maxStep: number;
            paused: number;
            repeatWork: number;
          }[] = [];
          for (const [foreground, background, fontWeight] of [350, 400].flatMap(
            (weight) =>
              [
                ['#d4d4d4', '#121212', weight],
                ['#4ec9b0', '#121212', weight],
                ['#ce9178', '#121212', weight],
                ['#202020', '#f5f5f5', weight]
              ] as const
          )) {
            const grid = new Grid();
            grid.busy = true;
            grid.background = background;
            grid.foreground = foreground;
            grid.pixelScrollEnabled = true;
            grid.apply([
              ['grid_resize', [1, 40, 8]],
              ['grid_line', [1, 2, 0, Array.from('Il1|[](){}MWmw __ fn(value)', (c) => [c, 0])]],
              ['flush']
            ]);
            const canvas = document.createElement('canvas');
            const paint = (): void => {
              grid.invalidatePaint();
              grid.draw(
                canvas,
                400,
                152,
                15,
                '"Cascadia Code", monospace',
                false,
                undefined,
                19,
                fontWeight
              );
            };
            const top = Math.round(38 * devicePixelRatio) - 3;
            const width = Math.round(300 * devicePixelRatio);
            const height = Math.ceil(19 * devicePixelRatio) + 6;
            const pixels = (): Uint8ClampedArray =>
              canvas.getContext('2d')!.getImageData(0, top, width, height).data;
            const rgb = Number.parseInt(background.slice(1), 16);
            const base = luminance((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
            const samples: { light: number; center: number }[] = [];
            let paused = 0;
            let repeatWork = 0;
            let work = 0;
            const read = CanvasRenderingContext2D.prototype.getImageData;
            const write = CanvasRenderingContext2D.prototype.putImageData;
            CanvasRenderingContext2D.prototype.getImageData = function (...args) {
              if (this.canvas !== canvas) work++;
              return Reflect.apply(read, this, args);
            };
            CanvasRenderingContext2D.prototype.putImageData = function (...args) {
              work++;
              return Reflect.apply(write, this, args);
            };
            try {
              for (let step = 0; step <= 32; step++) {
                grid.scrollFraction = step / 32 / (19 * devicePixelRatio);
                grid.scrolling = true;
                paint();
                const data = pixels();
                let total = 0;
                let moment = 0;
                for (let i = 0; i < data.length; i += 4) {
                  const weight = Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - base);
                  total += weight;
                  moment += weight * (top + Math.floor(i / 4 / width));
                }
                samples.push({ light: total, center: moment / total });
                const before = work;
                grid.scrolling = false;
                paint();
                repeatWork += work - before;
                const repeated = pixels();
                paused += data.reduce((n, value, i) => n + Number(value !== repeated[i]), 0);
              }
            } finally {
              CanvasRenderingContext2D.prototype.getImageData = read;
              CanvasRenderingContext2D.prototype.putImageData = write;
            }
            const levels = samples.map((sample) => sample.light);
            const steps = samples.slice(1).map((sample, i) => samples[i].center - sample.center);
            results.push({
              variation: (Math.max(...levels) - Math.min(...levels)) / Math.max(...levels),
              minStep: Math.min(...steps),
              maxStep: Math.max(...steps),
              paused,
              repeatWork
            });
          }
          return results;
        },
        `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`
      );
      console.log('fractional-text-light', JSON.stringify({ scale, results }));
      for (const result of results) {
        expect(result.variation, 'subpixel translation must retain text brightness').toBeLessThan(
          0.01
        );
        expect(result.minStep, 'each input must visibly advance the glyph').toBeGreaterThan(0.015);
        expect(
          result.maxStep,
          'brightness correction must not introduce positional jumps'
        ).toBeLessThan(0.05);
        expect(result.paused, 'pausing must not change the raster').toBe(0);
        expect(result.repeatWork, 'pausing must reuse the corrected image').toBe(0);
      }
    } finally {
      await context.close();
    }
  });
}

for (const failure of ['unavailable', 'lost'] as const) {
  test(`scrolling retains native text when WebGL is ${failure}`, async ({ page }) => {
    await page.route('**/gpu-fallback-probe', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
    );
    await page.goto(`${origin}gpu-fallback-probe`);
    if (failure === 'lost') {
      await requireWebGLCorrection(page);
    }
    const result = await page.evaluate(
      async ({ moduleUrl, failure }) => {
        const { Grid } = await import(moduleUrl);
        const getContext = HTMLCanvasElement.prototype.getContext;
        let gpu: WebGL2RenderingContext | undefined;
        HTMLCanvasElement.prototype.getContext = function (...args) {
          if (args[0] === 'webgl2' && failure === 'unavailable') return null;
          const context = Reflect.apply(getContext, this, args);
          if (args[0] === 'webgl2' && context) gpu = context;
          return context;
        } as typeof getContext;
        const grid = new Grid();
        grid.busy = true;
        grid.pixelScrollEnabled = true;
        grid.scrollFraction = 0.375 / 19;
        grid.apply([
          ['grid_resize', [1, 30, 5]],
          ['grid_line', [1, 2, 0, Array.from('Native text Il1|[]()', (text) => [text, 0])]],
          ['flush']
        ]);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false })!;
        const pixels = (): Uint8ClampedArray =>
          context.getImageData(0, 0, canvas.width, canvas.height).data;
        const draw = context.drawImage;
        let native: Uint8ClampedArray;
        context.drawImage = function (...args) {
          Reflect.apply(draw, this, args);
          if ((args[0] as HTMLCanvasElement).getContext('2d')) native = pixels();
        };
        const paint = (): void => {
          grid.invalidatePaint();
          grid.draw(canvas, 300, 95, 15, 'monospace', false, undefined, 19);
        };
        const differences = (a: Uint8ClampedArray, b: Uint8ClampedArray): number =>
          a.reduce((count, value, index) => count + Number(value !== b[index]), 0);
        let fallback = 0;
        let restored = 0;
        let corrected = 0;
        try {
          paint();
          const initial = pixels();
          const baseline = native!;
          corrected = differences(initial, baseline);
          if (failure === 'lost') {
            const gl = gpu!;
            const extension = gl.getExtension('WEBGL_lose_context')!;
            await new Promise<void>((resolve) => {
              gl.canvas.addEventListener('webglcontextlost', () => resolve(), {
                once: true
              });
              extension.loseContext();
            });
            paint();
            fallback = differences(pixels(), baseline);
            // Finish dispatching the canceled loss event before requesting recovery.
            await new Promise(requestAnimationFrame);
            await new Promise<void>((resolve) => {
              gl.canvas.addEventListener('webglcontextrestored', () => resolve(), {
                once: true
              });
              extension.restoreContext();
            });
            paint();
            restored = differences(pixels(), initial);
          } else {
            fallback = differences(initial, baseline);
          }
          const rgb = Number.parseInt(grid.background.slice(1), 16);
          let ink = 0;
          for (let i = 0; i < baseline.length; i += 4) {
            if (baseline[i] !== rgb >> 16) ink++;
          }
          return { fallback, restored, corrected, ink };
        } finally {
          HTMLCanvasElement.prototype.getContext = getContext;
        }
      },
      {
        moduleUrl: `/@fs/${resolve('src/renderer/src/grid.ts').replaceAll('\\', '/')}`,
        failure
      }
    );
    expect(result.ink, 'fallback keeps visible text').toBeGreaterThan(100);
    expect(result.fallback, 'GPU failure must retain native scrolling pixels').toBe(0);
    if (failure === 'lost') {
      expect(result.corrected, 'the initial viewport receives light correction').toBeGreaterThan(0);
      expect(result.restored, 'restored GPU rebuilds the same corrected image').toBe(0);
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
  await expect(page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })).toBeVisible();
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
  await expect(page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })).toBeVisible();
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

test('compact mode keeps every session visible and fixes bar heights during hover and keyboard navigation', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
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
  const header = page.getByRole('banner');
  const alpha = header.getByRole('tab', { name: 'Workspace Alpha', exact: true });
  const beta = header.getByRole('tab', { name: 'Workspace Beta', exact: true });
  const editor = page.getByRole('textbox', { name: 'Neovim input' });
  const files = page.getByRole('tablist', { name: 'Files', exact: true });
  const status = page.getByRole('contentinfo');
  const layout = (): Promise<unknown[]> =>
    Promise.all(
      [header, files, status, page.locator('main')].map((element) => element.boundingBox())
    );
  await expect(editor).toBeFocused();
  await expect(header).toHaveCSS('height', '38px');
  await expect(files).toHaveCSS('height', '34px');
  await expect(status).toHaveCSS('height', '32px');
  await expect(beta).toBeVisible();
  const normalEditorTop = (await page.locator('main').boundingBox())!.y;
  await header.getByRole('button', { name: 'Settings', exact: true }).click();
  const option = page.getByRole('checkbox', { name: 'Compact mode' });
  await expect(option).not.toBeChecked();
  await option.check();
  await page.keyboard.press('Escape');
  await page.mouse.move(500, 300);
  await expect(beta).toBeVisible();
  await expect(alpha).toBeVisible();
  await expect(header).toHaveCSS('height', '24px');
  await expect(files).toHaveCSS('height', '28px');
  await expect(status).toHaveCSS('height', '26px');
  expect((await page.locator('main').boundingBox())!.y).toBe(normalEditorTop - 14);
  const compactLayout = await layout();
  await alpha.hover();
  await expect(beta).toBeVisible();
  expect(await layout()).toEqual(compactLayout);
  await beta.hover();
  expect(await layout()).toEqual(compactLayout);
  await page.mouse.move(500, 300);
  expect(await layout()).toEqual(compactLayout);
  await page.keyboard.press('Alt+Shift+w');
  await expect(alpha).toBeFocused();
  await expect(beta).toBeVisible();
  expect(await layout()).toEqual(compactLayout);
  for (
    let step = 0;
    step < 8 && !(await beta.evaluate((button) => button === document.activeElement));
    step++
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(beta).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toBeFocused();
  await expect(alpha).toBeVisible();
  await page.keyboard.press('Alt+Shift+w');
  await expect(beta).toBeFocused();
  const minimize = header.getByRole('button', { name: 'Minimize', exact: true });
  for (
    let step = 0;
    step < 16 && !(await minimize.evaluate((button) => button === document.activeElement));
    step++
  ) {
    await page.keyboard.press('Tab');
  }
  for (const [index, name] of ['Minimize', 'Maximize', 'Close Nido'].entries()) {
    if (index) {
      await page.keyboard.press('Tab');
    }
    await expect(header.getByRole('button', { name, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  expect(await recordedWindowActions(page)).toEqual([['minimize'], ['maximize'], ['close']]);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect(alpha).toBeVisible();
  expect(await layout()).toEqual(compactLayout);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
    .toBe('true');
});

test('compact mode migrates the old setting and respects a saved disabled value after restarting in Japanese', async ({
  page
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('nido.autoHideSessionTabs', 'true');
    localStorage.setItem('nido.language', 'ja');
  });
  await page.goto(`${origin}?view=app`);
  const header = page.getByRole('banner');
  await expect(page.getByRole('textbox', { name: 'Neovim入力' })).toBeFocused();
  await page.mouse.move(500, 300);
  expect((await header.boundingBox())!.height).toBe(24);
  await header.getByRole('button', { name: '設定', exact: true }).click();
  const option = page.getByRole('checkbox', { name: 'コンパクトモード' });
  await expect(option).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
    .toBe('true');
  await option.uncheck();
  await page.keyboard.press('Escape');
  expect((await header.boundingBox())!.height).toBe(38);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
    .toBe('false');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Neovim入力' })).toBeFocused();
  await expect(header).toHaveCSS('height', '38px');
  await expect(page.getByRole('tablist', { name: 'ファイル', exact: true })).toHaveCSS(
    'height',
    '34px'
  );
  await expect(page.getByRole('contentinfo')).toHaveCSS('height', '32px');
});

test('compact mode scrolls the active session into view in a narrow window with many sessions', async ({
  page
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await page.addInitScript(() => localStorage.setItem('nido.compactMode', 'true'));
  await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('restoreWorkspaces', 0, {
      workspaces: Array.from({ length: 12 }, (_, i) => ({
        id: `session-${i}`,
        root: `/session-${i}`,
        name: `Session ${i + 1}`
      })),
      active: 'session-11',
      errors: []
    })
  );
  const tabs = page.getByRole('tablist', { name: 'Workspaces', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(12);
  for (const index of [11, 0, 8]) {
    if (index !== 11) await page.keyboard.press(`Alt+${index + 1}`);
    const selected = tabs.getByRole('tab', {
      name: `Workspace Session ${index + 1}`,
      exact: true
    });
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() =>
        selected.evaluate((element) => {
          const tab = element.getBoundingClientRect();
          const list = element.closest('[role="tablist"]')!.getBoundingClientRect();
          return tab.left >= list.left - 1 && tab.right <= list.right + 1;
        })
      )
      .toBe(true);
  }
  await expect(page.getByRole('banner')).toHaveCSS('height', '24px');
});

test('activity bar moves above the explorer, preserves navigation and persists its placement', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
  const explorer = page.getByRole('complementary', { name: 'File explorer' });
  await expect(navigation).toHaveAttribute('data-position', 'left');
  const titlebar = page.getByRole('banner');
  for (const name of ['Command palette', 'Settings']) {
    await expect(navigation.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    const button = (await titlebar.getByRole('button', { name, exact: true }).boundingBox())!;
    const minimize = (await titlebar.getByRole('button', { name: 'Minimize' }).boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(minimize.x);
    expect(button.y + button.height / 2).toBe(minimize.y + minimize.height / 2);
  }
  await titlebar.getByRole('button', { name: 'Command palette', exact: true }).click();
  const commands = page.getByRole('dialog', { name: 'commands palette', exact: true });
  await expect(commands).toBeVisible();
  await commands.getByRole('button', { name: 'Close palette' }).click();
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Activity bar position' }).selectOption('top');
  await page.keyboard.press('Escape');
  await expect(navigation).toHaveAttribute('data-position', 'top');
  await expect
    .poll(async () => {
      const bar = (await navigation.boundingBox())!;
      const side = (await explorer.boundingBox())!;
      const editor = (await page.locator('main').boundingBox())!;
      return {
        sameLeft: bar.x === side.x,
        sameWidth: bar.width === side.width,
        above: bar.y + bar.height <= side.y,
        editorBeside: editor.x >= side.x + side.width
      };
    })
    .toEqual({ sameLeft: true, sameWidth: true, above: true, editorBeside: true });
  await expect(page.getByRole('navigation')).toHaveCount(1);
  await navigation.getByRole('button', { name: 'Source control', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'git palette', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await navigation.getByRole('button', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Extensions', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await navigation.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'restoreWorkspaces').length
      )
    )
    .toBe(1);
  await page.reload();
  await expect(navigation).toHaveAttribute('data-position', 'top');
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Activity bar position' })).toHaveValue('top');
  await page.getByRole('checkbox', { name: 'Show file explorer' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(explorer).toHaveCount(0);
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(explorer).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
  const position = page.getByRole('combobox', { name: 'アクティビティバーの位置' });
  await expect(position).toHaveValue('top');
  await expect(position.getByRole('option', { name: 'エクスプローラーの上部' })).toBeAttached();
  await position.selectOption('left');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation')).toHaveAttribute('data-position', 'left');
  await page.reload();
  await expect(page.getByRole('navigation')).toHaveAttribute('data-position', 'left');
});

test('top activity bar keeps every action inside a narrow explorer', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 720 });
  await page.goto(`${origin}?view=app`);
  await page.evaluate(() => {
    localStorage.setItem('nido.activityBarPosition', 'top');
    localStorage.setItem('nido.sidebarWidth', '160');
  });
  await page.reload();
  const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
  await expect(navigation).toHaveCSS('width', '160px');
  const bounds = (await navigation.boundingBox())!;
  for (const button of await navigation.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('separator', { name: 'Explorer width' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(navigation).toHaveCSS('width', '180px');
});

for (const view of ['welcome', 'terminal'] as const) {
  test(`top activity bar remains accessible on the ${view} screen`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nido.activityBarPosition', 'top'));
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.rendererTest.pending.filter((call) => call.method === 'restoreWorkspaces').length
        )
      )
      .toBe(1);
    await page.evaluate((view) => {
      const terminal = { id: 'shell', root: '/alpha', name: 'Shell', kind: 'terminal' };
      window.rendererTest.settle('restoreWorkspaces', 0, {
        workspaces: view === 'terminal' ? [terminal] : [],
        active: view === 'terminal' ? 'shell' : '',
        errors: []
      });
    }, view);
    await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCount(0);
    const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
    await expect(navigation).toHaveAttribute('data-position', 'top');
    await expect
      .poll(async () => {
        const bar = (await navigation.boundingBox())!;
        const main = (await page.locator('main').boundingBox())!;
        return bar.width === main.width && bar.y + bar.height <= main.y;
      })
      .toBe(true);
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  });
}

test('settings switch the UI language immediately, persist it and switch back to English', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toBeFocused();
  const saving = settings.getByRole('region', { name: 'Saving and history', exact: true });
  await expect(saving.getByRole('checkbox', { name: 'Use EditorConfig' })).toBeChecked();
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
  await expect(japaneseSettings.getByRole('heading', { level: 3 })).toHaveText([
    '全般・レイアウト',
    'エディター表示',
    'カーソル・操作',
    '保存・履歴',
    'ターミナル'
  ]);
  await expect(
    japaneseSettings
      .getByRole('region', { name: '保存・履歴', exact: true })
      .getByRole('checkbox', { name: 'EditorConfigを使用' })
  ).toBeChecked();
  await expect(page.getByRole('button', { name: 'エクスプローラー', exact: true })).toHaveAttribute(
    'title',
    'エクスプローラー（Space e）'
  );
  await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('ja');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.rendererTest.calls.filter((call) => call.method === 'setLanguage').at(-1)?.args[0]
      )
    )
    .toBe('ja');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.calls.filter((call) => call.method === 'restoreWorkspaces').length
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
  await expect(page.getByRole('dialog', { name: 'キーボードコマンド', exact: true })).toBeVisible();
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

test('file icons recognize common formats, exact names and Windows paths', async ({ page }) => {
  await page.goto(`${origin}?view=icons`);
  for (const [path, icon] of [
    ['C:\\logs\\CHIBI.LOG', 'scroll-text'],
    ['logs/chibi.log.2', 'scroll-text'],
    ['Cargo.toml', 'package'],
    ['Cargo.lock', 'package'],
    ['package.json', 'package'],
    ['.env.local', 'file-key'],
    ['.gitignore', 'git-branch'],
    ['.editorconfig', 'file-cog'],
    ['.eslintrc.js', 'file-cog'],
    ['README.md', 'book-open'],
    ['Dockerfile.prod', 'container'],
    ['compose.yaml', 'container'],
    ['data.JSON', 'braces'],
    ['settings.yml', 'file-cog'],
    ['server.ps1', 'file-terminal'],
    ['photo.PNG', 'file-image'],
    ['sound.mp3', 'file-music'],
    ['video.mp4', 'file-video-camera'],
    ['archive.tar.gz', 'file-archive'],
    ['data.sqlite3', 'database'],
    ['data.csv', 'file-spreadsheet'],
    ['notes.md', 'file-text'],
    ['report.pdf', 'file-type'],
    ['server.key', 'file-lock'],
    ['file.unknown', 'file-code-2']
  ]) {
    await page.evaluate((path) => window.rendererTest.render({ path }), path);
    const image = page.locator('[data-file-icon] svg');
    await expect(image).toHaveClass(new RegExp(`lucide-${icon}\\b`));
    await expect(image).toHaveAttribute('aria-hidden', 'true');
  }
  await page.evaluate(() => window.rendererTest.render({ path: 'C:\\project\\main.RS' }));
  await expect(page.locator('[data-file-icon] img')).toHaveAttribute('src', /rust\.svg/);
  await page.evaluate(() => window.rendererTest.render({ path: 'component.TSX' }));
  await expect(page.locator('[data-file-icon] img')).toHaveAttribute(
    'src',
    /react\.svg|^data:image\/svg\+xml,/
  );
});

test('folder icons distinguish project roles and keep ordinary folder open states', async ({
  page
}) => {
  await page.goto(`${origin}?view=icons`);
  for (const [path, icon] of [
    ['C:\\project\\SRC', 'folder-code'],
    ['project/tests', 'folder-check'],
    ['logs', 'folder-clock'],
    ['logger', 'folder-clock'],
    ['.vscode', 'folder-cog'],
    ['.github', 'folder-git-2'],
    ['target', 'folder-archive'],
    ['screen', 'folder-tree'],
    ['consts', 'folder-lock']
  ]) {
    await page.evaluate((path) => window.rendererTest.render({ path }), path);
    for (const selector of ['[data-folder-closed] svg', '[data-folder-open] svg']) {
      await expect(page.locator(selector)).toHaveClass(new RegExp(`lucide-${icon}\\b`));
      await expect(page.locator(selector)).toHaveAttribute('aria-hidden', 'true');
    }
  }
  await page.evaluate(() => window.rendererTest.render({ path: 'my-project' }));
  await expect(page.locator('[data-folder-closed] svg')).toHaveClass(/lucide-folder$/);
  await expect(page.locator('[data-folder-open] svg')).toHaveClass(/lucide-folder-open\b/);
});

test('Explorer and editor tabs use the same log icon without changing file accessibility', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=files`);
  const tree = page.getByRole('tree', { name: 'Project files' });
  await expect(tree).toBeVisible();
  await page.evaluate(() => {
    window.rendererTest.settle('files', 0, [
      { name: 'logs', path: 'logs', directory: true, ignored: true },
      { name: 'src', path: 'src', directory: true },
      { name: 'chibi.log', path: 'chibi.log', directory: false }
    ]);
    window.rendererTest.emit({
      type: 'state',
      id: 'alpha',
      state: {
        buffers: [{ id: 1, name: '/alpha/chibi.log', modified: false }],
        current: 1,
        mode: 'n',
        line: 1,
        column: 1,
        filetype: 'log'
      }
    });
  });
  const log = tree.getByRole('treeitem', { name: 'chibi.log', exact: true });
  await expect(log.locator('.lucide-scroll-text')).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'chibi.log', exact: true }).locator('.lucide-scroll-text')
  ).toBeVisible();
  await expect(
    tree.getByRole('treeitem', { name: 'src', exact: true }).locator('.lucide-folder-code')
  ).toBeVisible();
  const folder = tree.getByRole('treeitem', { name: 'logs', exact: true });
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(folder.locator('.lucide-folder-clock')).toHaveCSS('opacity', '0.55');
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

const windowCommands = [
  {
    key: '-',
    stroke: 'Minus',
    action: 'minimize',
    en: 'Minimize window',
    ja: 'ウィンドウを最小化'
  },
  {
    key: '+',
    stroke: 'Shift+Equal',
    action: 'maximize',
    en: 'Maximize or restore window',
    ja: 'ウィンドウを最大化・元に戻す'
  },
  { key: 'q', stroke: 'q', action: 'close', en: 'Quit Nido', ja: 'Nidoを終了' }
] as const;

async function recordedWindowActions(page: Page): Promise<unknown[][]> {
  return page.evaluate(() =>
    window.rendererTest.calls
      .filter((call) => call.method === 'windowAction')
      .map((call) => call.args)
  );
}

for (const language of ['en', 'ja'] as const) {
  test(`window commands show translated leader keys and return editor focus in ${language}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 850, height: 560 });
    await page.addInitScript((language) => {
      localStorage.setItem('nido.language', language);
      localStorage.setItem('nido.animations', 'false');
    }, language);
    await page.goto(`${origin}?view=app`);
    const input = page.getByRole('textbox', {
      name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
      exact: true
    });
    const guide = page.getByRole('dialog', {
      name: language === 'ja' ? 'キーボードコマンド' : 'Keyboard commands',
      exact: true
    });
    const palette = page.getByRole('dialog', {
      name: language === 'ja' ? 'すべてのコマンド' : 'commands palette',
      exact: true
    });
    await expect(input).toBeFocused();
    const expected: string[][] = [];
    for (const command of windowCommands) {
      await page.keyboard.press('Space');
      await expect(guide).toBeVisible();
      const layout = await guide.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return {
          inViewport:
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight,
          wrapped: [...node.querySelectorAll('button')]
            .filter((button) =>
              [...button.childNodes].some((child) => {
                if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) {
                  return false;
                }
                const range = document.createRange();
                range.selectNodeContents(child);
                return range.getClientRects().length > 1;
              })
            )
            .map((button) => button.textContent),
          clipped: [...node.querySelectorAll('button')]
            .filter((button) => {
              const range = document.createRange();
              range.selectNodeContents(button);
              const content = range.getBoundingClientRect();
              const box = button.getBoundingClientRect();
              return (
                button.scrollWidth > button.clientWidth + 1 ||
                button.scrollHeight > button.clientHeight + 1 ||
                content.left < box.left - 1 ||
                content.right > box.right + 1 ||
                content.top < box.top - 1 ||
                content.bottom > box.bottom + 1
              );
            })
            .map((button) => button.textContent)
        };
      });
      expect(layout).toEqual({ inViewport: true, wrapped: [], clipped: [] });
      if (command.key === '-') {
        await page.screenshot({
          path: testInfo.outputPath(`window-guide-${language}.png`)
        });
      }
      for (const entry of windowCommands) {
        const button = guide.getByRole('button').filter({ hasText: entry[language] });
        await expect(button).toHaveCount(1);
        await expect(button.locator('kbd')).toHaveText(entry.key);
      }
      await page.keyboard.press(command.stroke);
      expected.push([command.action]);
      await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
      await expect(guide).toHaveCount(0);
      await expect(palette).toHaveCount(0);
      await expect(input).toBeFocused();
    }
    for (const command of windowCommands) {
      await page.keyboard.press('Control+Shift+p');
      await expect(palette).toBeVisible();
      const filter = page.getByRole('textbox', {
        name: language === 'ja' ? '項目を絞り込む' : 'Filter items',
        exact: true
      });
      await filter.fill(command[language]);
      await expect(palette.getByRole('button').filter({ hasText: command[language] })).toHaveCount(
        1
      );
      await filter.press('Enter');
      expected.push([command.action]);
      await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
      await expect(palette).toHaveCount(0);
      await expect(guide).toHaveCount(0);
      await expect(input).toBeFocused();
    }
  });
}

for (const view of ['welcome', 'terminal'] as const) {
  test(`window commands remain available from the ${view} command palette`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nido.language', 'en');
      localStorage.setItem('nido.animations', 'false');
    });
    await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
    await page.evaluate((view) => {
      window.rendererTest.settle('restoreWorkspaces', 0, {
        workspaces:
          view === 'terminal'
            ? [{ id: 'shell', root: '/alpha', name: 'Shell', kind: 'terminal' }]
            : [],
        active: view === 'terminal' ? 'shell' : '',
        errors: []
      });
    }, view);
    if (view === 'terminal') {
      await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
    } else {
      await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
    }
    const expected: string[][] = [];
    for (const command of windowCommands) {
      await page.keyboard.press('Control+Shift+p');
      const palette = page.getByRole('dialog', { name: 'commands palette', exact: true });
      await expect(palette).toBeVisible();
      const filter = page.getByRole('textbox', { name: 'Filter items', exact: true });
      await filter.fill(command.en);
      await expect(palette.getByRole('button').filter({ hasText: command.en })).toHaveCount(1);
      await filter.press('Enter');
      expected.push([command.action]);
      await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
      await expect(palette).toHaveCount(0);
      if (view === 'terminal') {
        await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
      }
    }
  });
}

test('window commands preserve Insert-mode spaces and punctuation during a pending mode check', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=inputMode`);
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.keyboard.type(' -+q');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'inputMode').length
      )
    )
    .toBe(1);
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
    .toBe(' -+q');
  expect(await recordedWindowActions(page)).toEqual([]);
  await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('window commands leave IME-owned spaces and punctuation with composition', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  const accepted = await input.evaluate((node: HTMLTextAreaElement) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const accepted = [' ', '-', '+', 'q'].map((key) =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    );
    node.value = ' -+q 日本語';
    node.dispatchEvent(
      new InputEvent('input', {
        data: node.value,
        inputType: 'insertCompositionText',
        isComposing: true,
        bubbles: true
      })
    );
    node.dispatchEvent(new CompositionEvent('compositionend', { data: node.value, bubbles: true }));
    return accepted;
  });
  expect(accepted).toEqual([true, true, true, true]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    )
    .toEqual([' -+q 日本語']);
  expect(await recordedWindowActions(page)).toEqual([]);
  await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('window commands preserve AltGr spaces and punctuation as editor input', async ({ page }) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  await input.evaluate((node) => {
    for (const key of [' ', '-', '+', 'q']) {
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
          bubbles: true,
          cancelable: true
        })
      );
    }
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
          .join('')
      )
    )
    .toBe(' -+q');
  expect(await recordedWindowActions(page)).toEqual([]);
  await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('IME transition keys stay with composition before its start and after its commit', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  const prevented = await input.evaluate((node: HTMLTextAreaElement) => {
    const imeKey = (key: string): boolean =>
      !node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          keyCode: 229,
          bubbles: true,
          cancelable: true
        })
      );
    const before = imeKey('a');
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.value = '日本語<入力>';
    node.dispatchEvent(
      new InputEvent('input', {
        data: node.value,
        inputType: 'insertCompositionText',
        isComposing: true,
        bubbles: true
      })
    );
    node.dispatchEvent(new CompositionEvent('compositionend', { data: node.value, bubbles: true }));
    return [before, imeKey('Enter')];
  });
  expect(prevented, 'the browser must keep control of IME-owned key events').toEqual([
    false,
    false
  ]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    )
    .toEqual(['日本語<LT>入力>']);
  await expect(input).toHaveValue('');
});

test('interrupted IME input recovers on focus return and ignores an obsolete commit', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  for (const boundary of ['element', 'window']) {
    await input.evaluate((node: HTMLTextAreaElement, boundary) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      node.value = '未確定';
      if (boundary === 'element') node.blur();
      else window.dispatchEvent(new Event('blur'));
    }, boundary);
    await input.focus();
    await page.keyboard.type('az');
    const expected = boundary === 'element' ? ['a', 'z'] : ['a', 'z', 'a', 'z'];
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.rendererTest.calls
            .filter((call) => call.method === 'input')
            .map((call) => call.args[1])
        )
      )
      .toEqual(expected);
    await input.evaluate((node: HTMLTextAreaElement) =>
      node.dispatchEvent(new CompositionEvent('compositionend', { data: '未確定', bubbles: true }))
    );
    expect(
      await page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    ).toEqual(expected);
    await expect(input).toHaveValue('');
  }
});

test('native IME text is visible as it changes and only committed text reaches Neovim', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  const ime = await page.context().newCDPSession(page);
  try {
    let previousWidth = 0;
    for (const text of ['に', 'にほ', '日本語<入力>']) {
      await ime.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length
      });
      await expect(input).toHaveValue(text);
      await expect(input).toHaveCSS('opacity', '1');
      await expect(input).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
      const width = await input.evaluate((node) => node.clientWidth);
      expect(width).toBeGreaterThan(previousWidth);
      previousWidth = width;
      expect(
        await page.evaluate(() =>
          window.rendererTest.calls.filter((call) => call.method === 'input')
        )
      ).toEqual([]);
    }
    await page.screenshot({ path: test.info().outputPath('japanese-composition.png') });
    await ime.send('Input.insertText', { text: '日本語<入力>' });
    await expect(input).toHaveValue('');
    await expect(input).not.toHaveAttribute('data-composing');
    expect(
      await page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    ).toEqual(['日本語<LT>入力>']);
    await ime.send('Input.imeSetComposition', {
      text: '未確定',
      selectionStart: 3,
      selectionEnd: 3
    });
    await expect(input).toHaveCSS('opacity', '1');
    const longText = '未確定の日本語'.repeat(100);
    await ime.send('Input.imeSetComposition', {
      text: longText,
      selectionStart: longText.length,
      selectionEnd: longText.length
    });
    expect(await input.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await input.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    expect(
      await input.evaluate(
        (node) =>
          node.getBoundingClientRect().right <=
          node.parentElement!.getBoundingClientRect().right + 1
      )
    ).toBe(true);
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expect(input).toHaveValue('');
    await expect(input).not.toHaveAttribute('data-composing');
    expect(
      await page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    ).toEqual(['日本語<LT>入力>']);
  } finally {
    await ime.detach();
  }
});

test('native IME commits remain intact when editor focus moves', async ({ page }) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  const ime = await page.context().newCDPSession(page);
  try {
    await ime.send('Input.imeSetComposition', {
      text: '日本語<入力>',
      selectionStart: 7,
      selectionEnd: 7
    });
    await ime.send('Input.insertText', { text: '日本語<入力>' });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.rendererTest.calls
            .filter((call) => call.method === 'input')
            .map((call) => call.args[1])
        )
      )
      .toEqual(['日本語<LT>入力>']);
    await ime.send('Input.imeSetComposition', {
      text: '次の入力',
      selectionStart: 4,
      selectionEnd: 4
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.rendererTest.calls
            .filter((call) => call.method === 'input')
            .map((call) => call.args[1])
        )
      )
      .toEqual(['日本語<LT>入力>', '次の入力']);
  } finally {
    await ime.detach();
  }
});

test('blocked editors ignore late text, composition commits and paste events', async ({ page }) => {
  await page.goto(`${origin}?view=app`);
  const input = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(input).toBeFocused();
  await input.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await input.evaluate((node: HTMLTextAreaElement) => {
    node.dispatchEvent(
      new CompositionEvent('compositionend', { data: '遅れて確定', bubbles: true })
    );
    node.value = 'late text';
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'late paste');
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true
      })
    );
  });
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((call) => ['input', 'paste'].includes(call.method))
    )
  ).toEqual([]);
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await page.keyboard.type('az');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.calls
          .filter((call) => call.method === 'input')
          .map((call) => call.args[1])
      )
    )
    .toEqual(['a', 'z']);
});

test('hidden editors discard late IME input while another workspace accepts typing', async ({
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
  const alpha = page.locator('[data-editor-input="editor"]').first();
  await expect(alpha).toBeFocused();
  await alpha.dispatchEvent('compositionstart');
  await page.keyboard.press('Alt+2');
  const beta = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(beta).toBeFocused();
  await alpha.evaluate((node: HTMLTextAreaElement) => {
    node.dispatchEvent(new CompositionEvent('compositionend', { data: '前の作業', bubbles: true }));
    node.value = 'obsolete';
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.keyboard.type('az');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.calls.filter((call) => call.method === 'input').map((call) => call.args)
      )
    )
    .toEqual([
      ['beta', 'a'],
      ['beta', 'z']
    ]);
  await page.keyboard.press('Alt+1');
  await expect(alpha).toBeFocused();
  await expect(alpha).toHaveValue('');
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

test('Git page scrolling returns to the same position with an odd viewport height', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=gitDiff`);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Source control', exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle(
      'gitDiff',
      0,
      '@@ -1,500 +1,500 @@\n' + Array.from({ length: 500 }, (_, i) => ` row ${i}`).join('\n')
    )
  );
  await page.addStyleTag({
    content: 'pre[data-git-scroll] { flex: none; height: 335px; padding: 0; }'
  });
  for (const side of ['before', 'after']) {
    const preview = page.locator(`[data-git-scroll="${side}"]`);
    expect(await preview.evaluate((node) => node.clientHeight)).toBe(335);
    await preview.focus();
    for (const [down, up, distance] of [
      ['Control+d', 'Control+u', 168],
      ['Control+f', 'Control+b', 335]
    ] as const) {
      for (let step = 0; step < 3; step++) {
        await preview.press(down);
        await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(distance);
        await preview.press(up);
        await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(0);
      }
    }
  }
});

test('Git staging keeps the reviewed file selected and commits only staged changes', async ({
  page
}) => {
  await page.goto(`${origin}?view=git&defer=gitStatus,gitStage,gitCommit`);
  await page.addStyleTag({ content: '#root { display: flex; flex-direction: column; }' });
  const path = 'crate/chibi/src/screen/renderer.rs';
  const first = { path: 'src/main.rs', status: 'M', staged: false };
  const reviewed = { path, status: 'M', staged: false };
  const status = { root: '/alpha', branch: 'main', changes: [first, reviewed] };
  await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), status);
  const list = page.getByRole('listbox', { name: 'Changed files' });
  const input = page.getByRole('textbox', { name: 'Commit message' });
  const commit = page.getByRole('button', { name: 'Commit staged', exact: true });
  const preview = page.locator('[data-git-preview]');
  await expect(commit).toBeDisabled();
  await expect(input).toHaveAccessibleDescription('Stage changes to include them in the commit.');
  const file = list.getByRole('option', { name: path, exact: true });
  await expect(file.locator('strong')).toHaveText('renderer.rs');
  await expect(file.locator('small')).toHaveText('crate/chibi/src/screen');
  await file.click();
  await input.fill('Improve rendering');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
      )
    )
    .toBe(1);
  await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
    ...status,
    changes: [first, reviewed, { ...reviewed, staged: true }]
  });
  await expect(preview.getByRole('button', { name: 'Stage (s)', exact: true })).toBeEnabled();

  for (const staged of [true, false]) {
    await list.focus();
    await list.press(staged ? 's' : 'u');
    await expect(input).toHaveAttribute('readonly', '');
    await list.press(staged ? 's' : 'u');
    expect(
      await page.evaluate(() =>
        window.rendererTest.pending
          .filter((call) => call.method === 'gitStage')
          .map((call) => call.args)
      )
    ).toEqual([['alpha', path, !staged]]);
    await page.evaluate(() => window.rendererTest.settle('gitStage', 0, undefined));
    await expect
      .poll(() =>
        page.evaluate(
          () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
        )
      )
      .toBe(1);
    await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
      ...status,
      changes: [first, { ...reviewed, staged }]
    });
    await expect(list.getByRole('option', { selected: true })).toHaveAccessibleName(path);
    await expect(
      preview.getByRole('button', { name: staged ? 'Unstage (u)' : 'Stage (s)', exact: true })
    ).toBeEnabled();
    await expect(commit).toBeEnabled({ enabled: staged });
    await expect(input).toHaveValue('Improve rendering');
  }

  await list.press('s');
  await page.evaluate(() => window.rendererTest.settle('gitStage', 0, undefined));
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
      )
    )
    .toBe(1);
  await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
    ...status,
    changes: [first, { ...reviewed, staged: true }]
  });
  await expect(input).toHaveAccessibleDescription('Only staged changes (1) will be committed.');
  await expect(page.getByRole('heading', { name: 'Staged changes', exact: true })).toHaveText(
    'Staged changes1'
  );
  await expect(page.getByRole('heading', { name: 'Changes', exact: true })).toHaveText('Changes1');
  await commit.click();
  await input.press('Control+Enter');
  expect(
    await page.evaluate(() =>
      window.rendererTest.pending
        .filter((call) => call.method === 'gitCommit')
        .map((call) => call.args)
    )
  ).toEqual([['alpha', 'Improve rendering']]);
  await page.evaluate(() =>
    window.rendererTest.settle('gitCommit', 0, 'Committed Improve rendering')
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
      )
    )
    .toBe(1);
  await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
    ...status,
    changes: [first]
  });
  await expect(input).toHaveValue('');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option', { name: first.path })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('status')).toHaveText('Committed Improve rendering');
  await expect(commit).toBeDisabled();
});

test('Git commit failures preserve the draft and it survives switching views', async ({ page }) => {
  await page.goto(`${origin}?view=git&defer=gitStatus,gitCommit`);
  await page.evaluate(() =>
    window.rendererTest.settle('gitStatus', 0, {
      root: '/alpha',
      branch: 'main',
      changes: [{ path: 'new name.ts', original: 'old name.ts', status: 'R', staged: true }]
    })
  );
  const input = page.getByRole('textbox', { name: 'Commit message' });
  await expect(input).toHaveAccessibleDescription('Enter a message to commit staged changes (1).');
  await expect(page.getByRole('option', { name: 'new name.ts' })).toHaveAttribute(
    'title',
    'old name.ts → new name.ts'
  );
  await input.fill('Rename the module');
  await input.press('Control+Enter');
  await expect(input).toHaveAttribute('readonly', '');
  await page.evaluate(() =>
    window.rendererTest.settle('gitCommit', 0, 'Commit hook rejected the message.', true)
  );
  await expect(page.getByRole('alert')).toHaveText('Commit hook rejected the message.');
  await expect(input).toHaveValue('Rename the module');
  await expect(input).not.toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: '2 History', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
      )
    )
    .toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
  );
  await page.getByRole('button', { name: '1 Changes', exact: true }).click();
  await page.evaluate(() =>
    window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
  );
  await expect(input).toHaveValue('Rename the module');
  await expect(input).toHaveAccessibleDescription('No changes to commit.');
  await expect(page.getByText('Working tree clean.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stage all (S)', exact: true })).toBeDisabled();
  await page.getByText('Keyboard shortcuts', { exact: true }).click();
  await expect(
    page.getByText(
      'j/k Select · s Stage · S Stage all · u Unstage · r Refresh · c Message · Esc Close',
      { exact: true }
    )
  ).toBeVisible();
});

test('Git keeps the commit input reachable while typing in a small window', async ({ page }) => {
  await page.setViewportSize({ width: 850, height: 560 });
  await page.goto(`${origin}?view=git`);
  await page.addStyleTag({
    content: '#root { display: flex; flex-direction: column; height: 350px; }'
  });
  const list = page.getByRole('listbox', { name: 'Changed files' });
  const input = page.getByRole('textbox', { name: 'Commit message' });
  await list.focus();
  await list.press('c');
  await input.fill('A commit message that stays visible');
  await expect(input).toBeInViewport({ ratio: 1 });
  await input.press('End');
  await input.press('!');
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(input).toHaveValue('A commit message that stays visible!');
  await list.focus();
  await expect(list.getByRole('option', { selected: true })).toBeInViewport();
  await list.press('j');
  await expect(list.getByRole('option', { name: 'second.ts' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(list.getByRole('option', { selected: true })).toBeInViewport();
  await list.press('c');
  await expect(input).toBeInViewport({ ratio: 1 });
  expect(await page.locator('#root').evaluate((node) => node.scrollTop)).toBe(0);
});

test('Git keyboard help stays in the modal focus cycle', async ({ page }) => {
  await page.goto(`${origin}?view=app`);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Source control', exact: true })
    .click();
  const dialog = page.locator('[data-panel="git"]');
  const help = dialog.locator('summary');
  const close = dialog.getByRole('button', { name: 'Close palette', exact: true });
  await page.getByLabel('Git diff', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  await help.press('Enter');
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await help.press('Tab');
  await expect(close).toBeFocused();
  await close.press('Shift+Tab');
  await expect(help).toBeFocused();
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
    await expect(page.getByRole('heading', { name: `Commit ${index}`, exact: true })).toBeVisible();
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
  await page.evaluate(() => window.rendererTest.settle('gitHistory', 0, { commits: [], total: 0 }));
  await expect(page.getByRole('button', { name: '2 History', exact: true })).toBeEnabled();
  await expect(page.getByText('Commits: 0', { exact: true })).toBeVisible();
  await list.press('Control+d');
  await expect(list).not.toHaveAttribute('aria-activedescendant');
});

test('A new diff clears the previous highlighting failure', async ({ page }) => {
  await page.goto(`${origin}?view=highlight&defer=highlightSources`);
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.evaluate(() => window.rendererTest.settle('highlightSources', 0, 'unavailable', true));
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
        () => window.rendererTest.pending.filter((call) => call.method === 'browseFolders').length
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
        () => window.rendererTest.pending.filter((call) => call.method === 'browseFolders').length
      )
    )
    .toBe(2);
  await page.keyboard.press('ArrowDown');
  await expect(connection).toHaveValue('Ubuntu');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.rendererTest.pending.filter((call) => call.method === 'browseFolders').length
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
          window.rendererTest.calls.filter((call) => call.method === 'browseFolders').at(-1)?.args
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
          window.rendererTest.calls.filter((call) => call.method === 'browseFolders').at(-1)?.args
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
  await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(5);
  const alpha = { id: 'alpha', name: 'Renamed Alpha', root: '/alpha' };
  const beta = { id: 'beta', name: 'Beta', root: '/beta' };
  await page.evaluate((alpha) => window.rendererTest.render({ workspaces: [alpha] }), alpha);
  await expect(page.getByRole('status')).toHaveText('Ready');
  await page.evaluate(
    ([alpha, beta]) => window.rendererTest.render({ workspaces: [beta, alpha] }),
    [alpha, beta]
  );
  await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(10);
  expect(
    await page.evaluate(() => window.rendererTest.calls.slice(5).map((call) => call.args[0]))
  ).toEqual(['beta', 'beta', 'beta', 'beta', 'beta']);
  await page.evaluate(
    ([alpha, beta]) =>
      window.rendererTest.render({
        workspaces: [alpha, beta],
        settings: {
          clipboardSharing: true,
          relativeLineNumbers: true,
          editorConfig: true,
          methodSeparators: false,
          wordWrap: true
        }
      }),
    [alpha, beta]
  );
  await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(12);
  expect(await page.evaluate(() => window.rendererTest.calls.slice(10))).toEqual([
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
  await expect.poll(() => page.evaluate(() => window.rendererTest.calls.length)).toBe(14);
  expect(await page.evaluate(() => window.rendererTest.calls.slice(12))).toEqual([
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
        methodSeparators: false,
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
        methodSeparators: false,
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

for (const dismiss of ['button', 'Escape', 'toggle'] as const) {
  test(`closed reference searches stay closed across workspace switches after ${dismiss}`, async ({
    page
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
    const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
    const panel = page.locator('[data-references-panel]');
    const list = page.getByRole('listbox', { name: 'Reference results' });
    const toggle = page.getByRole('button', { name: 'Toggle references', exact: true });
    const references = async (id: string, search: number, version: number): Promise<void> => {
      await page.evaluate(
        ({ id, search, version }) =>
          window.rendererTest.emit({
            type: 'statePatch',
            id,
            state: {
              references: {
                search,
                version,
                loading: false,
                error: '',
                items: [
                  {
                    path: `/${id}/result.ts`,
                    line: 1,
                    column: 1,
                    text: `${id}-${search}-${version}`
                  }
                ]
              }
            }
          }),
        { id, search, version }
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
    };
    const switchTo = async (name: 'Alpha' | 'Beta'): Promise<void> => {
      await page.keyboard.press(name === 'Alpha' ? 'Alt+1' : 'Alt+2');
      await expect(
        page.getByRole('tab', { name: `Workspace ${name}`, exact: true })
      ).toHaveAttribute('aria-selected', 'true');
    };
    await expect(editor).toBeFocused();
    await references('alpha', 1, 1);
    await expect(list).toBeFocused();
    if (dismiss === 'button') {
      await page.getByRole('button', { name: 'Hide references', exact: true }).click();
    } else if (dismiss === 'toggle') {
      await toggle.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(panel).toBeHidden();
    await switchTo('Beta');
    await references('beta', 1, 1);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('beta-1-1');
    for (let index = 0; index < 3; index++) {
      await switchTo('Alpha');
      await expect(panel).toBeHidden();
      await expect(editor).toBeFocused();
      await switchTo('Beta');
      await expect(panel).toBeVisible();
    }
    await switchTo('Alpha');
    await references('alpha', 1, 2);
    await expect(panel).toContainText('alpha-1-2');
    await expect(panel).toBeHidden();
    await expect(editor).toBeFocused();
    await references('alpha', 2, 3);
    await expect(panel).toBeVisible();
    await expect(list).toBeFocused();
    await page.keyboard.press('Escape');
    await switchTo('Beta');
    await references('alpha', 3, 4);
    await expect(panel).toContainText('beta-1-1');
    await switchTo('Alpha');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('alpha-3-4');
    await page.keyboard.press('Escape');
    for (const reopen of ['toggle', 'Control+j']) {
      if (reopen === 'toggle') {
        await toggle.click();
      } else {
        await page.keyboard.press(reopen);
      }
      await expect(list).toBeFocused();
      await switchTo('Beta');
      await switchTo('Alpha');
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });
}

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

test('closing a terminal during startup keeps it closed and reuses the finished session', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=openTerminal`);
  const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
  const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+`');
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.keyboard.press('Control+`');
  await page.evaluate(() =>
    window.rendererTest.settle('openTerminal', 0, {
      id: 'alpha-shell',
      root: '/alpha',
      name: 'Terminal Alpha',
      kind: 'terminal'
    })
  );
  // The session stays mounted but need not attach its hidden editor until it is opened.
  await expect(page.locator('section[aria-label="Terminal"]')).toHaveCount(1);
  await expect(terminal).toBeHidden();
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(
      () => window.rendererTest.calls.filter((call) => call.method === 'openTerminal').length
    )
  ).toBe(1);
  await page.keyboard.press('Control+`');
  await expect(terminal).toBeVisible();
  await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
});

test('terminal startup in another workspace cannot take focus from the current editor', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=restoreWorkspaces,openTerminal`);
  await page.evaluate(() =>
    window.rendererTest.settle('restoreWorkspaces', 0, {
      workspaces: [
        { id: 'alpha', root: '/alpha', name: 'Alpha' },
        { id: 'beta', root: '/beta', name: 'Beta', terminalId: 'beta-shell' }
      ],
      active: 'alpha',
      errors: []
    })
  );
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.keyboard.press('Control+`');
  await page.keyboard.press('Alt+2');
  await page.keyboard.press('Control+`');
  const betaTerminal = page.getByRole('region', { name: 'Terminal', exact: true });
  await expect(betaTerminal).toBeVisible();
  await page.keyboard.press('Control+k');
  const editor = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(editor).toBeFocused();
  await page.evaluate(() =>
    window.rendererTest.settle('openTerminal', 0, {
      id: 'alpha-shell',
      root: '/alpha',
      name: 'Terminal Alpha',
      kind: 'terminal'
    })
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expect(editor).toBeFocused();
  await expect(betaTerminal).toBeVisible();
});

test('opening a file cannot dismiss a newer command palette', async ({ page }) => {
  await page.goto(`${origin}?view=app&defer=findFiles,openFile`);
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 0, [
      { name: 'main.rs', path: 'main.rs', directory: false }
    ])
  );
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => window.rendererTest.pending.some((call) => call.method === 'openFile'))
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
  const filter = page.getByRole('textbox', { name: 'Filter items' });
  await filter.fill('Open debug');
  await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue('Open debug');
  await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
});

test('terminal startup honors the latest toggle and a failed startup can be retried', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=openTerminal`);
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.keyboard.press('Control+`');
  await page.evaluate(() => window.rendererTest.settle('openTerminal', 0, 'Shell failed', true));
  await expect(page.getByRole('alert')).toContainText('Shell failed');
  await page.keyboard.press('Escape');
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press('Control+`');
  }
  expect(
    await page.evaluate(
      () => window.rendererTest.pending.filter((call) => call.method === 'openTerminal').length
    )
  ).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('openTerminal', 0, {
      id: 'shell',
      root: '/alpha',
      name: 'Terminal Alpha',
      kind: 'terminal'
    })
  );
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
});

test('a delayed shell restart cannot take focus after returning to the editor', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=restoreWorkspaces,restartTerminal`);
  await page.evaluate(() =>
    window.rendererTest.settle('restoreWorkspaces', 0, {
      workspaces: [{ id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'shell' }],
      active: 'alpha',
      errors: []
    })
  );
  const editor = page.getByRole('textbox', { name: 'Neovim input' });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+`');
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.press('Control+Shift+r');
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.keyboard.press('Control+k');
  await expect(editor).toBeFocused();
  await page.evaluate(() => window.rendererTest.settle('restartTerminal', 0, undefined));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expect(editor).toBeFocused();
});

test('only the latest file opening returns focus, while normal file opening still closes the picker', async ({
  page
}) => {
  await page.goto(`${origin}?view=app&defer=findFiles,openFile`);
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
  await page.evaluate(() =>
    window.rendererTest.settle('findFiles', 0, [
      { name: 'first.rs', path: 'first.rs', directory: false },
      { name: 'second.rs', path: 'second.rs', directory: false }
    ])
  );
  const filter = page.getByRole('textbox', { name: 'Filter items' });
  await expect(filter).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+j');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.rendererTest.pending
          .filter((call) => call.method === 'openFile')
          .map((call) => call.args)
      )
    )
    .toEqual([
      ['alpha', 'first.rs'],
      ['alpha', 'second.rs']
    ]);
  await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await expect(filter).toBeFocused();
  await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
  await expect(page.getByRole('dialog', { name: 'files palette' })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
});

for (const navigation of ['reference', 'problem', 'search'] as const) {
  test(`a delayed ${navigation} jump cannot dismiss a newer command palette`, async ({ page }) => {
    const method =
      navigation === 'reference'
        ? 'openReference'
        : navigation === 'problem'
          ? 'openProblem'
          : 'openFile';
    await page.goto(
      `${origin}?view=app&defer=${method}${navigation === 'search' ? ',searchText' : ''}`
    );
    await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
    if (navigation === 'search') {
      await page.keyboard.press('Control+Shift+f');
      await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('match');
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.rendererTest.pending.some(
              (call) => call.method === 'searchText' && call.args[1] === 'match'
            )
          )
        )
        .toBe(true);
      await page.evaluate(() => {
        const pending = window.rendererTest.pending.filter((call) => call.method === 'searchText');
        for (let index = 0; index < pending.length; index++) {
          window.rendererTest.settle('searchText', 0, {
            truncated: false,
            matches: [{ path: 'main.rs', line: 2, column: 1, text: 'match' }]
          });
        }
      });
      await expect(
        page.getByRole('listbox', { name: 'Search results' }).getByRole('option')
      ).toHaveCount(1);
    } else {
      await page.evaluate(
        (navigation) =>
          window.rendererTest.emit({
            type: 'statePatch',
            id: 'alpha',
            state:
              navigation === 'reference'
                ? {
                    references: {
                      version: 1,
                      loading: false,
                      error: '',
                      items: [
                        {
                          path: '/alpha/main.rs',
                          line: 2,
                          column: 1,
                          text: 'match'
                        }
                      ]
                    }
                  }
                : {
                    diagnosticsVersion: 1,
                    problems: [
                      {
                        path: '/alpha/main.rs',
                        line: 2,
                        column: 1,
                        severity: 1,
                        message: 'match',
                        source: 'rustc'
                      }
                    ]
                  }
          }),
        navigation
      );
      if (navigation === 'problem') {
        await expect(page.getByRole('contentinfo')).toContainText('1');
        await page.keyboard.press('Control+Shift+m');
        await expect(
          page.getByRole('dialog', { name: 'problems palette' }).getByRole('option')
        ).toHaveCount(1);
      } else {
        await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
      }
    }
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(
          (method) => window.rendererTest.pending.some((call) => call.method === method),
          method
        )
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    if (navigation === 'search') {
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Control+Shift+p');
    await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
    const filter = page.getByRole('textbox', { name: 'Filter items' });
    await filter.fill('Open debug');
    await page.evaluate((method) => window.rendererTest.settle(method, 0, undefined), method);
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('Open debug');
    await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
  });
}

test('late reference results keep command palette focus and remain reachable afterwards', async ({
  page
}) => {
  await page.goto(`${origin}?view=app`);
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.keyboard.press('Control+Shift+p');
  const filter = page.getByRole('textbox', { name: 'Filter items' });
  await filter.fill('Open');
  await page.evaluate(() =>
    window.rendererTest.emit({
      type: 'statePatch',
      id: 'alpha',
      state: {
        references: {
          version: 1,
          loading: false,
          error: '',
          items: [{ path: '/alpha/main.rs', line: 2, column: 1, text: 'match' }]
        }
      }
    })
  );
  await expect(page.locator('[data-references-panel]')).toBeVisible();
  await expect(filter).toBeFocused();
  await page.keyboard.type(' debug');
  await expect(filter).toHaveValue('Open debug');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
  await page.keyboard.press('Control+j');
  await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
});
