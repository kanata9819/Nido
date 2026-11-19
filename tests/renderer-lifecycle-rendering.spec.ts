import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import { viteFsUrl } from './helpers/vite-fs-url';
import { pauseRendererClock } from './helpers/renderer-lifecycle-shared';
import type { Grid as EditorGrid } from '../src/renderer/src/grid/grid';
import type {} from './renderer/harness';
import { requireWebGLCorrection } from './helpers/row-image-probe';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

for (const scale of [1, 1.25, 1.5, 2]) {
	test(`Git change bars cover the line spacing at ${scale * 100}% scale`, async ({ browser }) => {
		const context = await browser.newContext({ deviceScaleFactor: scale });
		try {
			const page = await context.newPage();
			await page.route('**/git-sign-probe', (route) =>
				route.fulfill({ contentType: 'text/html', body: '<body></body>' })
			);
			await page.goto(`${origin}git-sign-probe`);
			const results = await page.evaluate(async (url) => {
				const { Grid } = await import(url);
				return [18, 23].map((lineHeight) => {
					const grid = new Grid();
					grid.background = '#121212';
					grid.busy = true;
					grid.apply([
						['grid_resize', [1, 20, 8]],
						[
							'hl_attr_define',
							[1, { foreground: 0x2ea043 }, {}, [{ hi_name: 'NidoGitAdded' }]],
							[2, { foreground: 0x0078d4 }, {}, [{ hi_name: 'NidoGitChanged' }]],
							[3, { foreground: 0xf85149 }, {}, [{ hi_name: 'NidoGitDeleted' }]]
						],
						[
							'grid_line',
							...[1, 1, 1, 2, 2, 3].map((id, row) => [
								1,
								row,
								0,
								[
									[' ', 0, 2],
									[id === 3 ? '▸' : '▎', id]
								]
							])
						],
						['flush']
					]);
					const canvas = document.createElement('canvas');
					const { cellWidth } = grid.draw(
						canvas,
						200,
						lineHeight * 8,
						14,
						'monospace',
						true,
						undefined,
						lineHeight
					);
					const ctx = canvas.getContext('2d')!;
					const x = Math.round(2 * cellWidth * devicePixelRatio);
					const pixels = ctx.getImageData(
						x,
						0,
						1,
						Math.round(lineHeight * 7 * devicePixelRatio)
					).data;
					const rgb = (y: number): number[] => Array.from(pixels.slice(y * 4, y * 4 + 3));
					const boundary = Math.round(lineHeight * 3 * devicePixelRatio);
					const blueEnd = Math.round(lineHeight * 5 * devicePixelRatio);
					return {
						added: Array.from({ length: boundary }, (_, y) => rgb(y)),
						changed: Array.from({ length: blueEnd - boundary }, (_, y) =>
							rgb(boundary + y)
						),
						deletedTop: rgb(blueEnd),
						blank: rgb(Math.round(lineHeight * 6.5 * devicePixelRatio))
					};
				});
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
			for (const result of results) {
				expect(result.added.every((pixel) => pixel.join() === '46,160,67')).toBe(true);
				expect(result.changed.every((pixel) => pixel.join() === '0,120,212')).toBe(true);
				expect(result.deletedTop).toEqual([18, 18, 18]);
				expect(result.blank).toEqual([18, 18, 18]);
			}
		} finally {
			await context.close();
		}
	});
}

test('Sticky Scroll skips unchanged cursor frames and follows the vertical offset', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.addInitScript(() => {
		localStorage.setItem('nido.language', 'en');
		localStorage.setItem('nido.animations', 'false');
		localStorage.setItem('nido.smoothCursor', 'false');
	});
	await page.goto(`${origin}?view=app`);
	await page.clock.runFor(200);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.evaluate(async (url) => {
		const { Grid } = (await import(url)) as { Grid: typeof EditorGrid };
		const original = Grid.prototype.rowY;
		const probe = { scopeReads: 0 };
		Object.assign(window, { stickyProbe: probe });
		Grid.prototype.rowY = function (row) {
			if (row === 14) {
				probe.scopeReads++;
			}
			return original.call(this, row);
		};
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
							scopes: [
								{
									line: 27,
									ending: 90,
									top: 0,
									bottom: 14,
									text: [{ text: 'scope', color: '#ffffff', cells: 5 }],
									endText: []
								}
							]
						}
					]
				],
				['nido_pixel_scroll', [0.5, false]],
				['flush']
			]
		});
	}, viteFsUrl('src/renderer/src/grid/grid.ts'));
	await page.clock.runFor(32);
	const header = page.getByRole('button', { name: 'Go to line 27' });
	await expect(header).toBeVisible();
	const scopeReads = (): Promise<number> =>
		page.evaluate(
			() =>
				(window as unknown as { stickyProbe: { scopeReads: number } }).stickyProbe
					.scopeReads
		);
	const initial = await scopeReads();
	expect(initial).toBeGreaterThan(0);
	for (let column = 1; column <= 20; column++) {
		await page.evaluate(
			(nextColumn) =>
				window.rendererTest.emit({
					type: 'redraw',
					id: 'alpha',
					events: [['grid_cursor_goto', [1, 0, nextColumn]], ['flush']]
				}),
			column
		);
		await page.clock.runFor(20);
	}
	expect(await scopeReads()).toBe(initial);
	await expect(header).toBeVisible();

	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['nido_pixel_scroll', [0, false]], ['flush']]
		})
	);
	await page.clock.runFor(32);
	await expect(header).toHaveCount(0);
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
				{ url: viteFsUrl('src/renderer/src/grid/grid.ts'), size, family }
			);
			const columns = [
				0,
				1,
				2,
				4,
				5,
				...Array.from({ length: 201 }, (_, index) => index + 8)
			];
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
			const result = await page.evaluate(async (moduleUrl) => {
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
				// Keep the current-line indicator out of the initial glyph-color samples.
				const draw = (position?: {
					row: number;
					column: number;
					width?: number;
				}): { cellWidth: number; cellHeight: number } =>
					grid.draw(canvas, 400, 150, 14, 'monospace', !grid.busy, position, 24);
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
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
			const results = await page.evaluate(async (url) => {
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
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

test('diagnostic undercurls stay continuous across spaces and wide characters', async ({
	browser
}) => {
	const context = await browser.newContext({ deviceScaleFactor: 1.25 });
	try {
		const page = await context.newPage();
		await page.route('**/undercurl-probe', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<body></body>' })
		);
		await page.goto(`${origin}undercurl-probe`);
		const { before, span, after } = await page.evaluate(async (url) => {
			const { Grid } = await import(url);
			const grid = new Grid();
			grid.busy = true;
			grid.apply([
				['grid_resize', [1, 8, 2]],
				[
					'hl_attr_define',
					[1, { undercurl: true, special: 0xff0000 }, {}, []],
					[2, { undercurl: true, special: 0xff0000, bold: true }, {}, []]
				],
				[
					'grid_line',
					[
						1,
						0,
						0,
						[
							['x', 0],
							['a', 1],
							[' ', 1],
							['日', 2],
							['', 2],
							['b', 1],
							['z', 0]
						]
					]
				],
				['flush']
			]);
			const canvas = document.createElement('canvas');
			const { cellWidth } = grid.draw(canvas, 120, 48, 14, 'monospace', true, undefined, 24);
			const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
			const width = Math.round(cellWidth * devicePixelRatio);
			// LCD text antialiasing can tint neutral glyph edges above the undercurl.
			const waveTop = Math.floor(19 * devicePixelRatio);
			const waveBottom = Math.round(24 * devicePixelRatio);
			const red = Array.from({ length: 7 * width }, (_, x) => {
				let strongest = 16;
				let peak = -1;
				for (let y = waveTop; y < waveBottom; y++) {
					const offset = (y * pixels.width + x) * 4;
					const contrast = pixels.data[offset] - pixels.data[offset + 1];
					if (contrast > strongest) {
						strongest = contrast;
						peak = y;
					}
				}
				return peak;
			});
			return {
				before: red.slice(0, width),
				span: red.slice(width, 6 * width),
				after: red.slice(6 * width)
			};
		}, viteFsUrl('src/renderer/src/grid/grid.ts'));
		expect(before.every((y) => y === -1)).toBe(true);
		expect(span.every((y) => y >= 0)).toBe(true);
		expect(new Set(span).size).toBeGreaterThan(1);
		expect(after.every((y) => y === -1)).toBe(true);
	} finally {
		await context.close();
	}
});

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
						const textStyles: Record<string, { font: string; baseline: number }> = {};
						const fillText = CanvasRenderingContext2D.prototype.fillText;
						CanvasRenderingContext2D.prototype.fillText = function (...args) {
							const [text, , y] = args;
							if (text === 'f' || text === 'E') {
								textStyles[text] = { font: this.font, baseline: y };
							}
							fillText.apply(this, args);
						};
						const roundRect = CanvasRenderingContext2D.prototype.roundRect;
						CanvasRenderingContext2D.prototype.roundRect = function (
							this: CanvasRenderingContext2D,
							...args: Parameters<typeof roundRect>
						) {
							roundedShapes++;
							roundRect.apply(this, args);
						};
						const canvas = document.createElement('canvas');
						document.body.append(canvas);
						const draw = (): { cellWidth: number } =>
							grid.draw(canvas, 600, 96, 14, 'monospace', true, undefined, 24);
						const { cellWidth } = draw();
						const left =
							Math.round(code.length * cellWidth * devicePixelRatio) /
							devicePixelRatio;
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
						return {
							corner,
							background,
							accent,
							firstShapes,
							cachedShapes,
							erased,
							textStyles
						};
					},
					{
						moduleUrl: viteFsUrl('src/renderer/src/grid/grid.ts'),
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
				expect(result.textStyles.E.font).toBe(result.textStyles.f.font);
				expect(result.textStyles.E.baseline).toBe(result.textStyles.f.baseline);
			} finally {
				await context.close();
			}
		});
	}
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
			const samples = await page.evaluate(async (moduleUrl) => {
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
			}, viteFsUrl('src/renderer/src/editor/canvasSurface.ts'));
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
			const result = await page.evaluate(async (moduleUrl) => {
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
						canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
							.data;
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
			expect(result.lighter).toEqual(result.initial);
			expect(result.lighterCalls.map(({ text, x, y }) => ({ text, x, y }))).toEqual(
				result.initialCalls.map(({ text, x, y }) => ({ text, x, y }))
			);
			expect(result.lighterCalls.find(({ text }) => text === 'n')?.font).toContain('350 ');
			expect(result.lighterCalls.find(({ text }) => text === '日')?.font).toContain('350 ');
			expect(result.lighterCalls.find(({ text }) => text === 'b')?.font).toContain('bold ');
			expect(result.lighterCalls.find(({ text }) => text === 'i')?.font).toContain(
				'italic 350 '
			);
			expect(result.repeatedGlyphs).toBe(0);
			expect(result.restoredPixels).toBe(0);
		} finally {
			await context.close();
		}
	});

	test(`editor text reuses native opaque rasters at ${scale * 100}% scale`, async ({
		browser
	}) => {
		const context = await browser.newContext({ deviceScaleFactor: scale });
		try {
			const page = await context.newPage();
			await page.route('**/canvas-probe', (route) =>
				route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
			);
			await page.goto(`${origin}canvas-probe`);
			const samples = await page.evaluate(async (moduleUrl) => {
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
			expect(samples.copies).toBe(10);
			expect(
				samples.nativeRows,
				'settled fractional scrolling must reuse the native glyph images'
			).toBe(true);
			expect(samples.opaqueRows, 'opaque themes must allow the native LCD text raster').toBe(
				true
			);
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
			const samples = await page.evaluate(async (moduleUrl) => {
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
								(count, value, index) => count + Number(value !== expected[index]),
								0
							);
						}
						const top = Math.floor(40 * dpr);
						const width = Math.floor(120 * dpr);
						const pixels = ctx.getImageData(0, top, width, Math.ceil(48 * dpr)).data;
						const light = (value: number): number => {
							const encoded = value / 255;
							return encoded <= 0.04045
								? encoded / 12.92
								: ((encoded + 0.055) / 1.055) ** 2.4;
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
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
			await requireWebGLCorrection(page);
			const samples = await page.evaluate(async (moduleUrl) => {
				const { Grid } = await import(moduleUrl);
				const dpr = devicePixelRatio;
				const light = (value: number): number => {
					const encoded = value / 255;
					return encoded <= 0.04045
						? encoded / 12.92
						: ((encoded + 0.055) / 1.055) ** 2.4;
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
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
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
			const results = await page.evaluate(async (moduleUrl) => {
				const { Grid } = await import(moduleUrl);
				const light = Array.from({ length: 256 }, (_, value) => {
					const encoded = value / 255;
					return encoded <= 0.04045
						? encoded / 12.92
						: ((encoded + 0.055) / 1.055) ** 2.4;
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
						[
							'grid_line',
							[1, 2, 0, Array.from('Il1|[](){}MWmw __ fn(value)', (c) => [c, 0])]
						],
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
								const weight = Math.abs(
									luminance(data[i], data[i + 1], data[i + 2]) - base
								);
								total += weight;
								moment += weight * (top + Math.floor(i / 4 / width));
							}
							samples.push({ light: total, center: moment / total });
							const before = work;
							grid.scrolling = false;
							paint();
							repeatWork += work - before;
							const repeated = pixels();
							paused += data.reduce(
								(n, value, i) => n + Number(value !== repeated[i]),
								0
							);
						}
					} finally {
						CanvasRenderingContext2D.prototype.getImageData = read;
						CanvasRenderingContext2D.prototype.putImageData = write;
					}
					const levels = samples.map((sample) => sample.light);
					const steps = samples
						.slice(1)
						.map((sample, i) => samples[i].center - sample.center);
					results.push({
						variation:
							(Math.max(...levels) - Math.min(...levels)) / Math.max(...levels),
						minStep: Math.min(...steps),
						maxStep: Math.max(...steps),
						paused,
						repeatWork
					});
				}
				return results;
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
			console.log('fractional-text-light', JSON.stringify({ scale, results }));
			for (const result of results) {
				expect(
					result.variation,
					'subpixel translation must retain text brightness'
				).toBeLessThan(0.01);
				expect(result.minStep, 'each input must visibly advance the glyph').toBeGreaterThan(
					0.015
				);
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
				HTMLCanvasElement.prototype.getContext = function (
					this: HTMLCanvasElement,
					...args: unknown[]
				) {
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
					[
						'grid_line',
						[1, 2, 0, Array.from('Native text Il1|[]()', (text) => [text, 0])]
					],
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
				moduleUrl: viteFsUrl('src/renderer/src/grid/grid.ts'),
				failure
			}
		);
		expect(result.ink, 'fallback keeps visible text').toBeGreaterThan(100);
		expect(result.fallback, 'GPU failure must retain native scrolling pixels').toBe(0);
		if (failure === 'lost') {
			expect(
				result.corrected,
				'the initial viewport receives light correction'
			).toBeGreaterThan(0);
			expect(result.restored, 'restored GPU rebuilds the same corrected image').toBe(0);
		}
	});
}
