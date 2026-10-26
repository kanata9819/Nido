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
  for (const opacity of [1, 0.5]) {
    test(`horizontal log rasters match native glyphs at ${scale * 100}% scale and ${opacity} opacity`, async ({
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
              Reflect.set(Reflect.get(grids[1], 'canvas'), 'glyphImage', () => undefined);
              const columns = 88;
              const rows = 14;
              const source =
                '2026-10-25T23:25:43.824Z INFO rows=[42, 227, 32] message="debug params" '.repeat(
                  4
                );
              const cells = (row: number, shift: number): [string, number][] =>
                Array.from({ length: columns }, (_, col) => [
                  col < 6 ? `${row}`.padStart(5).concat(' ')[col] : source[col - 6 + shift],
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
                  grid.draw(canvases[index], 860, 308, size, family, false, undefined, 22);
                }
                const pixels = canvases.map(
                  (canvas) =>
                    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
                );
                for (let pixel = 0; pixel < pixels[0].length; pixel++) {
                  if (pixels[0][pixel] !== pixels[1][pixel]) {
                    mismatches++;
                  }
                }
              }
              return { counts, mismatches };
            } finally {
              CanvasRenderingContext2D.prototype.fillText = native;
            }
          },
          { opacity, moduleUrl: '/src/renderer/src/grid.ts' }
        );
        expect(result.mismatches).toBe(0);
        if (opacity === 1) {
          expect(result.counts[0]).toBeLessThan(result.counts[1] / 2);
        }
      } finally {
        await context.close();
      }
    });
  }
}
