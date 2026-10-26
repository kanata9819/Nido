import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 0 }
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing renderer test address');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server.close();
});

for (const scale of [1, 1.25, 1.5, 2]) {
  test(`horizontal native rebases preserve glyph shapes in both directions at ${scale * 100}% scale`, async ({
    browser
  }) => {
    const context = await browser.newContext({ deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.route('**/horizontal-rebase-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
      );
      await page.goto(`${origin}/horizontal-rebase-probe`);
      const result = await page.evaluate(async (moduleUrl) => {
        const { Grid } = await import(moduleUrl);
        const grid = new Grid();
        grid.cursorVisible = false;
        grid.busy = true;
        const columns = 64;
        const rows = 8;
        const gutter = 6;
        const source = 'WM[]()lI|\\/fox_09 : Console::trace(args); '.repeat(8);
        grid.apply([
          ['grid_resize', [1, columns, rows]],
          ['hl_attr_define', [1, { foreground: 0x81c784 }, {}, []]],
          ['hl_attr_define', [2, { foreground: 0xf0ae81 }, {}, []]],
          ['flush']
        ]);
        const canvas = document.createElement('canvas');
        let previous: Uint8ClampedArray | undefined;
        let previousShift = 0;
        let mismatches = 0;
        let comparisons = 0;
        let rawPitch = 0;
        const failures: { shift: number; mismatches: number }[] = [];
        for (const shift of [0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
          grid.apply([
            ...Array.from({ length: rows - 1 }, (_, row) => [
              'grid_line',
              [
                1,
                row,
                0,
                Array.from({ length: columns }, (_, col) => [
                  col < gutter ? ' ' : source[col - gutter + shift],
                  col < gutter ? 0 : (col - gutter + shift) % 7 < 3 ? 1 : 2
                ])
              ]
            ]),
            ['flush']
          ]);
          const { cellWidth } = grid.draw(
            canvas,
            660,
            132,
            15.3,
            'Consolas, monospace',
            false,
            undefined,
            22
          );
          const ctx = canvas.getContext('2d')!;
          rawPitch = ctx.measureText('M').width * devicePixelRatio;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          if (previous) {
            const movement = Math.round((shift - previousShift) * cellWidth * devicePixelRatio);
            let changed = 0;
            for (
              let y = Math.round(22 * devicePixelRatio);
              y < Math.round(66 * devicePixelRatio);
              y++
            ) {
              for (
                let x = Math.ceil((gutter + 4) * cellWidth * devicePixelRatio);
                x < Math.floor((columns - 4) * cellWidth * devicePixelRatio);
                x++
              ) {
                const current = (y * canvas.width + x) * 4;
                const prior = (y * canvas.width + x + movement) * 4;
                for (let channel = 0; channel < 4; channel++) {
                  changed += Number(pixels[current + channel] !== previous[prior + channel]);
                }
              }
            }
            mismatches += changed;
            comparisons++;
            if (changed && failures.length < 4) failures.push({ shift, mismatches: changed });
          }
          previous = pixels;
          previousShift = shift;
        }
        return { rawPitch, comparisons, mismatches, failures };
      }, '/src/renderer/src/grid.ts');
      expect(Math.abs(result.rawPitch - Math.round(result.rawPitch))).toBeGreaterThan(0.001);
      expect(result.comparisons).toBe(16);
      expect(result.mismatches, JSON.stringify(result)).toBe(0);
    } finally {
      await context.close();
    }
  });

  for (const opacity of [1, 0.5]) {
    test(`horizontal log updates match fresh rasters at ${scale * 100}% scale and ${opacity} opacity`, async ({
      browser
    }) => {
      const context = await browser.newContext({ deviceScaleFactor: scale });
      try {
        const page = await context.newPage();
        await page.route('**/horizontal-probe', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
        );
        await page.goto(`${origin}/horizontal-probe`);
        const result = await page.evaluate(
          async ({ opacity, moduleUrl }) => {
            const { Grid } = await import(moduleUrl);
            const native = CanvasRenderingContext2D.prototype.fillText;
            const counts = [0, 0];
            let drawing = 0;
            CanvasRenderingContext2D.prototype.fillText = function (...args) {
              counts[drawing]++;
              native.apply(this, args);
            };
            try {
              const grids = [new Grid(), new Grid()];
              const canvases = grids.map(() => document.createElement('canvas'));
              const columns = 88;
              const rows = 14;
              const source =
                Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') +
                '2026-10-25T23:25:43.824Z INFO rows=[42, 227, 32] message="debug params" '.repeat(
                  4
                );
              const cells = (row: number, shift: number): [string, number][] =>
                Array.from({ length: columns }, (_, col) => [
                  col < 6
                    ? `${row}`.padStart(5).concat(' ')[col]
                    : source[(col - 6 + shift + row * 7) % source.length],
                  col < 6 ? 1 : (col + shift) % 17 < 4 ? 2 : 3
                ]);
              for (const grid of grids) {
                grid.backgroundOpacity = opacity;
                grid.cursorVisible = false;
                grid.apply([
                  ['grid_resize', [1, columns, rows]],
                  ['hl_attr_define', [1, { foreground: 0x858585 }, {}, []]],
                  ['hl_attr_define', [2, { foreground: 0x81c784 }, {}, []]],
                  ['hl_attr_define', [3, { foreground: 0xf0ae81 }, {}, []]],
                  ...Array.from({ length: rows - 1 }, (_, row) => [
                    'grid_line',
                    [1, row, 0, cells(row, 0)]
                  ]),
                  ['flush']
                ]);
              }
              let mismatches = 0;
              const differences: unknown[] = [];
              for (let frame = 0; frame < 10; frame++) {
                const family = frame < 6 ? 'monospace' : 'Consolas, monospace';
                const size = frame < 7 ? 14 : 17;
                const shift = frame < 5 ? frame : 9 - frame;
                for (const [index, grid] of grids.entries()) {
                  drawing = index;
                  if (frame === 8) {
                    grid.background = '#101112';
                  }
                  grid.apply([
                    ['nido_scroll', [1, 0, rows - 1, 6, columns, 0, frame < 5 ? 1 : -1]],
                    ...Array.from({ length: rows - 1 }, (_, row) => [
                      'grid_line',
                      [1, row, 0, cells(row, shift)]
                    ]),
                    ...(frame === 9
                      ? [
                          [
                            'grid_line',
                            [
                              1,
                              3,
                              9,
                              [
                                ['日', 2],
                                ['', 2],
                                ['é', 3],
                                ['j', 1]
                              ]
                            ]
                          ]
                        ]
                      : []),
                    ['flush']
                  ]);
                  if (index === 1) {
                    Reflect.get(grid, 'canvas').invalidate();
                  }
                  grid.draw(canvases[index], 860, 308, size, family, false, undefined, 22);
                }
                const pixels = canvases.map(
                  (canvas) =>
                    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
                );
                for (let pixel = 0; pixel < pixels[0].length; pixel++) {
                  if (pixels[0][pixel] !== pixels[1][pixel]) {
                    mismatches++;
                    if (differences.length < 8) {
                      differences.push({
                        frame,
                        pixel,
                        actual: pixels[0][pixel],
                        expected: pixels[1][pixel]
                      });
                    }
                  }
                }
              }
              return { counts, mismatches, differences };
            } finally {
              CanvasRenderingContext2D.prototype.fillText = native;
            }
          },
          { opacity, moduleUrl: '/src/renderer/src/grid.ts' }
        );
        expect(result.mismatches, JSON.stringify(result.differences)).toBe(0);
        expect(result.counts[0], 'unchanged rows must reuse their existing rasters').toBeLessThan(
          result.counts[1]
        );
      } finally {
        await context.close();
      }
    });
  }
}
