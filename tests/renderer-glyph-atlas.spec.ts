import { test, expect } from './helpers/renderer-test';
import { requireWebGLCorrection } from './helpers/row-image-probe';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
	server = await createServer({
		configFile: false,
		root: resolve('src/renderer'),
		// Keep this configuration's dependencies apart from the harness server's cache.
		cacheDir: resolve('node_modules/.vite-renderer'),
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

/** Draw the same buffer with and without the glyph atlas and compare every pixel. */
async function compareAtlas(
	page: import('@playwright/test').Page,
	options: { scrolls: number[]; pixelScroll: boolean }
): Promise<{
	mismatches: number;
	worst: number;
	/** Largest difference away from the pixel lines where two rows meet. */
	interiorWorst: number;
	interiorMismatches: number;
	/** Largest deviation from the bar color along the Git change bar of rows 0 to 3. */
	seams: number[];
	differences: unknown[];
	atlasFillText: number;
	canvasFillText: number;
	rasterizations: number;
	frames: number;
}> {
	return page.evaluate(
		async ({ moduleUrl, atlasUrl, scrolls, pixelScroll }) => {
			const { Grid } = await import(moduleUrl);
			const { GlyphAtlas } = await import(atlasUrl);
			const native = CanvasRenderingContext2D.prototype.fillText;
			const counts = [0, 0];
			let drawing = 0;
			CanvasRenderingContext2D.prototype.fillText = function (...args) {
				counts[drawing]++;
				native.apply(this, args);
			};
			try {
				const columns = 72;
				const rows = 18;
				const info = (name: string): { hi_name: string }[] => [{ hi_name: name }];
				const lines: [string, number][][] = [];
				const code = [
					'    const value = example(argument); // WM[]()lI|\\/fox_09',
					'    if (value) { return Console::trace(args); }',
					'日本語のコメント e\u0301 😀 👩‍💻 ひらがな カタカナ',
					'  │ fn main() { println!("{}", 42); }',
					'        nested.call(a, b, c).then((x) => x * 2);'
				];
				for (let row = 0; row < rows - 1; row++) {
					const cells: [string, number][] = Array.from(
						`${String(row + 1).padStart(4)} `,
						(text) => [text, 1]
					);
					// Consecutive change bars show whether row boundaries leave a seam while scrolling.
					cells.unshift(row < 4 || row % 4 === 0 ? ['▎', 9] : [' ', 0]);
					const source = Array.from(code[row % code.length]);
					for (const [index, text] of source.entries()) {
						if (cells.length >= columns) break;
						const wide = /[\u3000-\u9fff]|\p{Extended_Pictographic}/u.test(text);
						if (wide && cells.length + 2 > columns) break;
						const highlight =
							text === '│'
								? 10
								: row === 5 && index >= 10 && index < 15
									? 4
									: row === 6 && index >= 4 && index < 9
										? 5
										: row === 7 && index === 16
											? 6
											: row === 8 && index < 20
												? 7
												: row === 9 && index >= 6
													? 8
													: index % 9 < 3
														? 2
														: index % 9 < 5
															? 3
															: 0;
						cells.push([text, highlight]);
						if (wide) cells.push(['', highlight]);
					}
					if (row === 11) {
						cells.splice(6, 0, ['▏', 11], [' ', 0], [' ', 0], [' ', 0]);
					}
					if (row === 12)
						cells.push(
							...Array.from('  2 references', (t) => [t, 12] as [string, number])
						);
					if (row === 13)
						cells.push(...Array.from('  ■ unused', (t) => [t, 13] as [string, number]));
					lines.push(cells.slice(0, columns));
				}
				const grids = [new Grid(), new Grid()];
				const canvases = grids.map(() => document.createElement('canvas'));
				for (const [index, grid] of grids.entries()) {
					grid.cursorVisible = false;
					grid.busy = true;
					grid.pixelScrollEnabled = pixelScroll;
					grid.glyphAtlasEnabled = index === 0;
					grid.apply([
						['grid_resize', [1, columns, rows]],
						['hl_attr_define', [1, { foreground: 0x858585 }, {}, []]],
						['hl_attr_define', [2, { foreground: 0x81c784 }, {}, []]],
						['hl_attr_define', [3, { foreground: 0xf0ae81, bold: true }, {}, []]],
						['hl_attr_define', [4, { background: 0x264f78 }, {}, []]],
						[
							'hl_attr_define',
							[5, { background: 0xffffff, blend: 88 }, {}, info('LspReferenceText')]
						],
						[
							'hl_attr_define',
							[6, { foreground: 0xffd700 }, {}, info('NidoBracketMatch')]
						],
						['hl_attr_define', [7, { underline: true, special: 0x5599ff }, {}, []]],
						[
							'hl_attr_define',
							[8, { undercurl: true, special: 0xff5555, italic: true }, {}, []]
						],
						['hl_attr_define', [9, { foreground: 0x4caf50 }, {}, info('NidoGitAdded')]],
						['hl_attr_define', [10, { foreground: 0x5a5a5a }, {}, []]],
						['hl_attr_define', [11, { foreground: 0x404040 }, {}, info('NidoIndent1')]],
						[
							'hl_attr_define',
							[12, { foreground: 0x999999 }, {}, info('NidoCodeLens')]
						],
						[
							'hl_attr_define',
							[
								13,
								{ foreground: 0xff5555, background: 0x3a1f1f },
								{},
								info('DiagnosticVirtualTextError')
							]
						],
						...lines.map((cells, row) => ['grid_line', [1, row, 0, cells]]),
						['flush']
					]);
				}
				let mismatches = 0;
				let worst = 0;
				let interiorWorst = 0;
				let interiorMismatches = 0;
				const seams = [0, 0];
				const differences: unknown[] = [];
				for (const [frame, scroll] of scrolls.entries()) {
					for (const [index, grid] of grids.entries()) {
						drawing = index;
						grid.scrollFraction = scroll;
						grid.invalidatePaint();
						grid.draw(
							canvases[index],
							640,
							18 * 22,
							14,
							'Consolas, "Yu Gothic UI", monospace',
							false,
							undefined,
							22
						);
					}
					const pixels = canvases.map(
						(canvas) =>
							canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
								.data
					);
					for (const [index, data] of pixels.entries()) {
						const width = canvases[index].width;
						for (
							let y = Math.round(11 * devicePixelRatio);
							y < Math.round(77 * devicePixelRatio);
							y++
						) {
							const at = y * width * 4;
							seams[index] = Math.max(
								seams[index],
								Math.abs(data[at] - 0x4c),
								Math.abs(data[at + 1] - 0xaf),
								Math.abs(data[at + 2] - 0x50)
							);
						}
					}
					const boundaries = new Set<number>();
					for (let row = -1; row <= rows; row++) {
						boundaries.add(
							Math.floor(
								Math.round(row * 22 * devicePixelRatio) -
									scroll * 22 * devicePixelRatio
							)
						);
					}
					for (let pixel = 0; pixel < pixels[0].length; pixel++) {
						const difference = Math.abs(pixels[0][pixel] - pixels[1][pixel]);
						if (difference) {
							mismatches++;
							worst = Math.max(worst, difference);
							if (!boundaries.has(Math.floor((pixel >> 2) / canvases[0].width))) {
								interiorMismatches++;
								interiorWorst = Math.max(interiorWorst, difference);
							}
							if (differences.length < 6) {
								const at = pixel >> 2;
								differences.push({
									frame,
									x: at % canvases[0].width,
									y: Math.floor(at / canvases[0].width),
									atlas: pixels[0][pixel],
									canvas: pixels[1][pixel]
								});
							}
						}
					}
				}
				return {
					mismatches,
					worst,
					interiorWorst,
					interiorMismatches,
					seams,
					differences,
					atlasFillText: counts[0],
					canvasFillText: counts[1],
					rasterizations: GlyphAtlas.forDocument(document).rasterizations,
					frames: scrolls.length
				};
			} finally {
				CanvasRenderingContext2D.prototype.fillText = native;
			}
		},
		{
			moduleUrl: '/src/grid/grid.ts',
			atlasUrl: '/src/grid/glyphAtlas.ts',
			...options
		}
	);
}

for (const scale of [1, 1.25, 1.5, 2]) {
	test(`glyph atlas rows match row images exactly at rest at ${scale * 100}% scale`, async ({
		browser
	}) => {
		const context = await browser.newContext({ deviceScaleFactor: scale });
		try {
			const page = await context.newPage();
			await page.route('**/atlas-probe', (route) =>
				route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
			);
			await page.goto(`${origin}/atlas-probe`);
			await requireWebGLCorrection(page);
			const result = await compareAtlas(page, { scrolls: [0, 0, 0], pixelScroll: false });
			expect(result.mismatches, JSON.stringify(result.differences)).toBe(0);
			expect(result.rasterizations).toBeGreaterThan(0);
		} finally {
			await context.close();
		}
	});
}

for (const scale of [1, 1.25, 1.5, 2]) {
	test(`glyph atlas rows stay close to row images at fractional scroll positions at ${scale * 100}% scale`, async ({
		browser
	}) => {
		const context = await browser.newContext({ deviceScaleFactor: scale });
		try {
			const page = await context.newPage();
			await page.route('**/atlas-scroll-probe', (route) =>
				route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
			);
			await page.goto(`${origin}/atlas-scroll-probe`);
			await requireWebGLCorrection(page);
			const result = await compareAtlas(page, {
				scrolls: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1],
				pixelScroll: true
			});
			// Rows meet in linear light, so only the shared boundary lines may differ from row
			// images, which composite those lines twice and leave a darker seam.
			// The shader decodes sRGB itself, which may round one step away from the hardware.
			expect(result.interiorWorst, JSON.stringify(result.differences)).toBeLessThanOrEqual(1);
			expect(result.seams[0]).toBeLessThanOrEqual(1);
			console.log('scroll', scale, JSON.stringify({ ...result, differences: undefined }));
		} finally {
			await context.close();
		}
	});
}

test('glyph atlas rows share tiles by appearance across grids', async ({ page }) => {
	await page.route('**/atlas-shared-probe', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
	);
	await page.goto(`${origin}/atlas-shared-probe`);
	await requireWebGLCorrection(page);
	const result = await page.evaluate(
		async ({ gridUrl, atlasUrl }) => {
			const { Grid } = (await import(
				gridUrl
			)) as typeof import('../src/renderer/src/grid/grid');
			const { GlyphAtlas } = (await import(
				atlasUrl
			)) as typeof import('../src/renderer/src/grid/glyphAtlas');
			const atlas = GlyphAtlas.forDocument(document);

			function paint(
				text: string,
				background: number,
				enabled: boolean,
				highlight = 1
			): Uint8ClampedArray {
				const grid = new Grid();
				grid.busy = true;
				grid.pixelScrollEnabled = true;
				grid.glyphAtlasEnabled = enabled;
				grid.apply([
					['grid_resize', [1, 16, 3]],
					['hl_attr_define', [highlight, { background }, {}, []]],
					['grid_line', [1, 0, 0, [[text, highlight]]]],
					['flush']
				]);
				const canvas = document.createElement('canvas');
				grid.draw(canvas, 144, 66, 14, 'Consolas, monospace', false, undefined, 22);
				return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
					.data;
			}

			const red = paint('W', 0xff0000, true);
			const redRasterizations = atlas.rasterizations;
			const green = paint('I', 0x00ff00, true);
			const greenRasterizations = atlas.rasterizations;
			const sameGreen = paint('I', 0x00ff00, true, 2);
			const sharedRasterizations = atlas.rasterizations;
			const redReference = paint('W', 0xff0000, false);
			const greenReference = paint('I', 0x00ff00, false);
			return {
				redMatches: red.every((byte, index) => byte === redReference[index]),
				greenMatches: green.every((byte, index) => byte === greenReference[index]),
				sharedMatches: sameGreen.every((byte, index) => byte === greenReference[index]),
				redRasterizations,
				greenRasterizations,
				sharedRasterizations
			};
		},
		{ gridUrl: '/src/grid/grid.ts', atlasUrl: '/src/grid/glyphAtlas.ts' }
	);
	expect(result.redRasterizations).toBeGreaterThan(0);
	expect(result.redMatches).toBe(true);
	expect(result.greenMatches).toBe(true);
	expect(result.greenRasterizations).toBeGreaterThan(result.redRasterizations);
	expect(result.sharedMatches).toBe(true);
	expect(result.sharedRasterizations).toBe(result.greenRasterizations);
});

// Measurement only: NIDO_MEASURE_ATLAS=1 pnpm exec playwright test --config
// playwright.renderer.config.ts tests/renderer-glyph-atlas.spec.ts -g "scroll replay"
test('glyph atlas scroll replay timing', async ({ browser }) => {
	test.skip(process.env.NIDO_MEASURE_ATLAS !== '1', 'Measurement only');
	test.setTimeout(120000);
	const { readFileSync } = await import('node:fs');
	const source = ['src/renderer/src/grid/grid.ts', 'src/renderer/src/grid/gridCanvas.ts']
		.map((path) => readFileSync(path, 'utf8'))
		.join('\n')
		.replace(/\t/g, '    ')
		.split('\n');
	const context = await browser.newContext({ deviceScaleFactor: 1.25 });
	try {
		const page = await context.newPage();
		await page.route('**/atlas-replay', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
		);
		await page.goto(`${origin}/atlas-replay`);
		await requireWebGLCorrection(page);
		const result = await page.evaluate(
			async ({ moduleUrl, atlasUrl, source }) => {
				const { Grid } = await import(moduleUrl);
				const { GlyphAtlas } = await import(atlasUrl);
				const columns = 160;
				const rows = 49;
				const keywords =
					/^(const|let|if|else|return|for|while|this|new|private|readonly|import|from|export|class|function|true|false|undefined)$/;
				const line = (index: number): [string, number][] => {
					const text = source[index] ?? '';
					const cells: [string, number][] = Array.from(
						`${String(index + 1).padStart(5)} `,
						(char) => [char, 1]
					);
					const comment = text.indexOf('//');
					for (const match of text.matchAll(/[A-Za-z_]\w*|'[^']*'|\s+|./g)) {
						const word = match[0];
						const highlight =
							comment >= 0 && match.index >= comment
								? 1
								: word.startsWith("'")
									? 3
									: keywords.test(word)
										? 2
										: /^[A-Z]/.test(word)
											? 4
											: 0;
						for (const char of word) cells.push([char, highlight]);
					}
					return cells
						.slice(0, columns)
						.concat(
							Array.from({ length: Math.max(0, columns - cells.length) }, () => [
								' ',
								0
							])
						);
				};
				const modes = ['canvas', 'atlas'] as const;
				const grids = modes.map((mode) => {
					const grid = new Grid();
					grid.cursorVisible = false;
					grid.busy = true;
					grid.glyphAtlasEnabled = mode === 'atlas';
					grid.apply([
						['grid_resize', [1, columns, rows + 1]],
						['hl_attr_define', [1, { foreground: 0x6a9955 }, {}, []]],
						['hl_attr_define', [2, { foreground: 0x569cd6 }, {}, []]],
						['hl_attr_define', [3, { foreground: 0xce9178 }, {}, []]],
						['hl_attr_define', [4, { foreground: 0x4ec9b0 }, {}, []]],
						...Array.from({ length: rows }, (_, row) => [
							'grid_line',
							[1, row, 0, line(row)]
						]),
						['flush']
					]);
					return grid;
				});
				const canvases = grids.map(() => document.createElement('canvas'));
				const times: Record<string, number[]> = {};
				const totals: Record<string, number> = {};
				const step = 3;
				const frames = Math.floor((source.length - rows) / step);
				// Each mode replays alone, so GPU work queued by one never delays the other.
				const run = (
					index: number,
					phase: string,
					direction: 1 | -1,
					from: number
				): void => {
					const grid = grids[index];
					const key = `${phase}:${modes[index]}`;
					let topLine = from;
					const begin = performance.now();
					for (let frame = 0; frame < frames; frame++) {
						const next = topLine + direction * step;
						const redraw = [
							['grid_scroll', [1, 0, rows, 0, columns, direction * step, 0]],
							...Array.from({ length: step }, (_, i) => {
								const row = direction > 0 ? rows - step + i : i;
								return ['grid_line', [1, row, 0, line(next + row)]];
							}),
							['flush']
						];
						const start = performance.now();
						grid.apply(redraw);
						grid.draw(
							canvases[index],
							1700,
							49 * 22 + 22,
							14,
							'Consolas, "Yu Gothic UI", monospace',
							false,
							undefined,
							22
						);
						(times[key] ??= []).push(performance.now() - start);
						topLine = next;
					}
					// One read at the end waits for all queued GPU work without stalling each frame.
					canvases[index].getContext('2d')!.getImageData(0, 0, 1, 1);
					totals[key] = Math.round(((performance.now() - begin) / frames) * 100) / 100;
				};
				// Jumps replace every row, as a search or a page motion does, within the file.
				const jump = (index: number): void => {
					const key = `jump (every row):${modes[index]}`;
					const begin = performance.now();
					for (let frame = 0; frame < 120; frame++) {
						const top = (frame * 337) % (source.length - rows);
						const start = performance.now();
						grids[index].apply([
							...Array.from({ length: rows }, (_, row) => [
								'grid_line',
								[1, row, 0, line(top + row)]
							]),
							['flush']
						]);
						grids[index].draw(
							canvases[index],
							1700,
							49 * 22 + 22,
							14,
							'Consolas, "Yu Gothic UI", monospace',
							false,
							undefined,
							22
						);
						(times[key] ??= []).push(performance.now() - start);
					}
					canvases[index].getContext('2d')!.getImageData(0, 0, 1, 1);
					totals[key] = Math.round(((performance.now() - begin) / 120) * 100) / 100;
				};
				// Smooth scrolling between Neovim redraws moves every row by a fraction of a line
				// without changing any cell.
				const smooth = (index: number): void => {
					const key = `smooth (offset only):${modes[index]}`;
					const grid = grids[index];
					grid.pixelScrollEnabled = true;
					const begin = performance.now();
					for (let frame = 0; frame < 240; frame++) {
						grid.scrollFraction = (frame % 16) / 16;
						const start = performance.now();
						grid.draw(
							canvases[index],
							1700,
							49 * 22 + 22,
							14,
							'Consolas, "Yu Gothic UI", monospace',
							false,
							undefined,
							22
						);
						(times[key] ??= []).push(performance.now() - start);
					}
					canvases[index].getContext('2d')!.getImageData(0, 0, 1, 1);
					totals[key] = Math.round(((performance.now() - begin) / 240) * 100) / 100;
					grid.scrollFraction = 0;
					grid.pixelScrollEnabled = false;
				};
				// The cursor moves a line per frame, as held j does, or blinks; no cell changes.
				const cursor = (index: number, phase: 'move' | 'blink'): void => {
					const key = `cursor ${phase}:${modes[index]}`;
					const grid = grids[index];
					grid.busy = false;
					grid.cursorVisible = true;
					const begin = performance.now();
					for (let frame = 0; frame < 240; frame++) {
						const start = performance.now();
						if (phase === 'move') {
							grid.apply([
								['grid_cursor_goto', [1, frame % (rows - 1), 12]],
								['flush']
							]);
						} else {
							grid.cursorVisible = frame % 2 === 0;
						}
						grid.draw(
							canvases[index],
							1700,
							49 * 22 + 22,
							14,
							'Consolas, "Yu Gothic UI", monospace',
							true,
							undefined,
							22
						);
						(times[key] ??= []).push(performance.now() - start);
					}
					canvases[index].getContext('2d')!.getImageData(0, 0, 1, 1);
					totals[key] = Math.round(((performance.now() - begin) / 240) * 100) / 100;
					grid.busy = true;
				};
				for (const index of [0, 1]) {
					cursor(index, 'move');
					cursor(index, 'blink');
					run(index, 'down (new lines)', 1, 0);
					run(index, 'up (revisited lines)', -1, frames * step);
					jump(index);
					smooth(index);
				}
				const stats = Object.fromEntries(
					Object.entries(times).map(([key, values]) => {
						const sorted = values.slice(1).sort((a, b) => a - b);
						const at = (q: number): number =>
							Math.round(sorted[Math.floor(q * (sorted.length - 1))] * 100) / 100;
						return [
							key,
							{
								median: at(0.5),
								p95: at(0.95),
								perFrame: totals[key],
								frames: sorted.length
							}
						];
					})
				);
				return { stats, tiles: GlyphAtlas.forDocument(document).rasterizations };
			},
			{ moduleUrl: '/src/grid/grid.ts', atlasUrl: '/src/grid/glyphAtlas.ts', source }
		);
		console.log(JSON.stringify(result, null, 1));
	} finally {
		await context.close();
	}
});
