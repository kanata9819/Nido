import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import { viteFsUrl } from './helpers/vite-fs-url';
import type { Grid as EditorGrid } from '../src/renderer/src/grid/grid';
import type { FrameMotion } from '../src/renderer/src/editor/editorMotion';
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

test('Ctrl+@ terminal input places the cursor at its new cell on the first frame', async ({
	page
}) => {
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
	await page.addInitScript(() => {
		localStorage.setItem('nido.language', 'en');
		localStorage.setItem('nido.smoothCursor', 'true');
	});
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [{ id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'shell' }],
			active: 'alpha',
			errors: []
		})
	);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Control+@');
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
	await page.clock.runFor(32);
	await page.evaluate(async (url) => {
		const { Grid } = (await import(url)) as { Grid: typeof EditorGrid };
		const original = Grid.prototype.draw;
		const columns: number[] = [];
		Object.assign(window, { terminalCursorColumns: columns });
		Grid.prototype.draw = function (...args) {
			const position = args[6];
			if (position && args[0].closest('section[aria-label="Terminal"]')) {
				columns.push(position.column);
			}
			return original.apply(this, args);
		};
		window.rendererTest.emit({
			type: 'redraw',
			id: 'shell',
			events: [['grid_cursor_goto', [1, 0, 8]], ['flush']]
		});
	}, viteFsUrl('src/renderer/src/grid/grid.ts'));
	await page.clock.runFor(16);
	const columns = await page.evaluate(
		() => (window as unknown as { terminalCursorColumns: number[] }).terminalCursorColumns
	);
	expect(columns[0]).toBe(8);
});

test('held motion keys show the new cursor and viewport without waiting for animation', async ({
	page
}) => {
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
	await page.addInitScript(() => {
		localStorage.setItem('nido.animations', 'true');
		localStorage.setItem('nido.smoothCursor', 'true');
	});
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	await page.evaluate(async (url) => {
		const { Grid } = await import(url);
		const original = Grid.prototype.draw;
		const probe = {
			draws: 0,
			composites: 0,
			cursorRow: -1,
			grid: undefined as EditorGrid | undefined
		};
		Object.assign(window, { viewportProbe: probe });
		const context = document.querySelector('canvas')!.getContext('2d')!;
		const drawImage = context.drawImage;
		context.drawImage = ((...args: Parameters<typeof drawImage>) => {
			if (args.length === 9) probe.composites++;
			drawImage.apply(context, args);
		}) as typeof drawImage;
		Grid.prototype.draw = function (...args) {
			probe.draws++;
			probe.cursorRow = args[6]?.row ?? -1;
			probe.grid = this;
			return original.apply(this, args);
		};
	}, viteFsUrl('src/renderer/src/grid/grid.ts'));
	await page.clock.runFor(32);
	const scroll = async (rows = 1, columns = 0): Promise<void> => {
		await page.evaluate(
			({ rows, columns }) => {
				const { grid } = (window as unknown as { viewportProbe: { grid: EditorGrid } })
					.viewportProbe;
				const args = [1, 0, grid.rows - 1, 0, grid.columns, rows, columns];
				window.rendererTest.emit({
					type: 'redraw',
					id: 'alpha',
					events: [
						['nido_scroll', args],
						['grid_scroll', args],
						['grid_line', [1, rows > 0 ? grid.rows - 2 : 0, 0, [['new row', 0]]]],
						['flush']
					]
				});
			},
			{ rows, columns }
		);
	};
	const sample = (field: 'draws' | 'composites' | 'cursorRow' = 'draws'): Promise<number> =>
		page.evaluate((key) => {
			return (window as unknown as { viewportProbe: Record<typeof key, number> })
				.viewportProbe[key];
		}, field);
	await page.keyboard.down('j');
	await page.keyboard.down('j');
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['grid_cursor_goto', [1, 3, 0]], ['flush']]
		})
	);
	await page.clock.runFor(16);
	expect(await sample('cursorRow'), 'the cursor reaches its new row on the first paint').toBe(3);
	await page.keyboard.up('j');
	await scroll();
	await page.clock.runFor(16);
	const firstTarget = await sample();
	await page.clock.runFor(32);
	expect(await sample(), 'animation frames reuse the rendered target').toBe(firstTarget);
	await page.keyboard.press('j');
	await page.clock.runFor(16);
	expect(await sample(), 'tapping j preserves the current visible animation').toBe(firstTarget);
	await page.keyboard.down('j');
	await page.keyboard.down('j');
	await page.clock.runFor(16);
	expect(await sample(), 'repeating j preserves the current visible animation').toBe(firstTarget);
	for (const key of ['j', 'k']) {
		if (key === 'k') {
			await page.keyboard.down('k');
			await page.keyboard.down('k');
		}
		const before = await sample('composites');
		await scroll(key === 'j' ? 1 : -1);
		await page.clock.runFor(16);
		expect(await sample('composites'), `holding ${key} skips the slide`).toBe(before);
		await page.keyboard.up(key);
	}
	expect(await sample(), 'native redraws still paint the new position').toBeGreaterThan(
		firstTarget
	);
	const released = await sample('composites');
	await scroll();
	await page.clock.runFor(16);
	expect(await sample('composites'), 'releasing the key restores animation').toBeGreaterThan(
		released
	);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['mode_change', ['insert', 0]], ['flush']]
		})
	);
	await page.clock.runFor(16);
	const beforeEdit = await sample();
	await page.keyboard.press('j');
	await page.clock.runFor(16);
	expect(await sample(), 'Insert-mode text interrupts the viewport animation').toBeGreaterThan(
		beforeEdit
	);
	await page.keyboard.down('ArrowDown');
	await page.keyboard.down('ArrowDown');
	const beforeArrow = await sample('composites');
	await scroll();
	await page.clock.runFor(16);
	expect(await sample('composites'), 'holding an Insert-mode arrow skips the slide').toBe(
		beforeArrow
	);
	await page.keyboard.up('ArrowDown');
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['mode_change', ['normal', 0]], ['flush']]
		})
	);
	for (const [key, rows, columns] of [
		['h', 0, -1],
		['l', 0, 1],
		['ArrowUp', -1, 0],
		['ArrowRight', 0, 1]
	] as const) {
		await page.keyboard.down(key);
		await page.keyboard.down(key);
		const before = await sample('composites');
		await scroll(rows, columns);
		await page.clock.runFor(16);
		expect(await sample('composites'), `holding ${key} skips the slide`).toBe(before);
		await page.keyboard.up(key);
	}
});

test('touchpad horizontal scrolling accumulates fine input, coalesces bursts and supports Shift and diagonal gestures', async ({
	page
}) => {
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app`);
	await page.clock.runFor(32);
	await page.evaluate(() => {
		const api = window.nido;
		let fraction = 0;
		let column = 0;
		window.nido = new Proxy(api, {
			get(target, method) {
				if (method !== 'scroll') return Reflect.get(target, method);
				return async (...args: Parameters<typeof api.scroll>) => {
					await api.scroll(...args);
					fraction += args[1];
					column = Math.max(0, column + (args[4] ?? 0));
					window.rendererTest.emit({
						type: 'redraw',
						id: args[0],
						events: [
							['nido_pixel_scroll', [fraction, true, undefined, false, column]],
							['flush']
						]
					});
				};
			}
		});
	});
	const canvas = page.locator('canvas:visible');
	const prefetches = (): Promise<number> =>
		page.evaluate(
			() =>
				window.rendererTest.calls.filter((call) => call.method === 'prefetchScroll').length
		);
	const beforePrefetch = await prefetches();
	const totals = (): Promise<{ lines: number; columns: number; count: number }> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'scroll')
				.reduce(
					(total, call) => ({
						lines: total.lines + Number(call.args[1]),
						columns: total.columns + Number(call.args[4] ?? 0),
						count: total.count + 1
					}),
					{ lines: 0, columns: 0, count: 0 }
				)
		);
	await canvas.dispatchEvent('wheel', { deltaX: 1, deltaMode: 0 });
	await expect.poll(totals).toEqual({ lines: 0, columns: 1, count: 1 });
	await canvas.evaluate((node) => {
		for (let i = 0; i < 119; i++) {
			node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 1 }));
		}
	});
	await expect.poll(async () => (await totals()).columns).toBeGreaterThan(0);
	expect((await totals()).count).toBeLessThanOrEqual(3);
	expect((await totals()).lines).toBe(0);
	await canvas.evaluate((node) => {
		for (let i = 0; i < 120; i++) {
			node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -1 }));
		}
	});
	await expect.poll(async () => (await totals()).columns).toBe(0);
	await canvas.dispatchEvent('wheel', { deltaY: 4, deltaMode: 1, shiftKey: true });
	await expect.poll(async () => (await totals()).columns).toBe(2);
	expect((await totals()).lines).toBe(0);
	await canvas.dispatchEvent('wheel', { deltaX: 4, deltaY: 4, deltaMode: 1, shiftKey: true });
	await expect.poll(async () => (await totals()).columns).toBe(4);
	expect((await totals()).lines).toBe(0);
	expect(await prefetches()).toBe(beforePrefetch);
	await canvas.dispatchEvent('wheel', { deltaX: 4, deltaY: 4, deltaMode: 1 });
	await expect.poll(totals).toMatchObject({ lines: 2, columns: 6 });
	const before = await totals();
	await canvas.dispatchEvent('wheel', { deltaX: 10, ctrlKey: true });
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await input.dispatchEvent('compositionstart');
	await canvas.dispatchEvent('wheel', { deltaX: 10 });
	await input.dispatchEvent('compositionend', { data: '' });
	expect(await totals()).toEqual(before);
	await canvas.dispatchEvent('wheel', { deltaX: 1, deltaMode: 1 });
	await expect.poll(async () => (await totals()).columns).toBe(7);
	await page.clock.runFor(250);
	await canvas.dispatchEvent('wheel', { deltaX: 1, deltaMode: 1 });
	expect((await totals()).columns).toBe(7);
	await canvas.dispatchEvent('wheel', { deltaX: 1, deltaMode: 1 });
	await expect.poll(async () => (await totals()).columns).toBe(8);

	// Pure horizontal input already consumed its fraction; a diagonal gesture
	// must not add that fraction a second time through the integer accumulator.
	await input.dispatchEvent('keydown', { key: 'Escape' });
	await page.clock.runFor(32);
	const beforeDiagonal = await totals();
	await canvas.dispatchEvent('wheel', { deltaX: 1.5, deltaMode: 1 });
	await expect.poll(async () => (await totals()).columns).toBe(beforeDiagonal.columns + 1);
	await canvas.dispatchEvent('wheel', { deltaX: 0.5, deltaY: 2, deltaMode: 1 });
	await expect.poll(totals).toMatchObject({
		lines: beforeDiagonal.lines + 1,
		columns: beforeDiagonal.columns + 1
	});

	// Changing font settings recreates the renderer while the native viewport
	// remains horizontally scrolled. Keep that native origin for the next gesture.
	await page.clock.runFor(32);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('spinbutton', { name: 'Editor font size' }).fill('18');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.fontSize'))).toBe('18');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
	await page.clock.runFor(32);
	const beforeFontGesture = await totals();
	await canvas.dispatchEvent('wheel', { deltaX: 1.5, deltaMode: 1 });
	await expect.poll(async () => (await totals()).columns).toBe(beforeFontGesture.columns + 1);
	await canvas.dispatchEvent('wheel', { deltaX: 0.5, deltaMode: 1 });
	await page.clock.runFor(32);
	expect((await totals()).columns).toBe(beforeFontGesture.columns + 1);
});

test('horizontal touchpad noise retains lookahead without vertical scrolling or prefetch', async ({
	page
}) => {
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
	await page.addInitScript(() => {
		localStorage.setItem('nido.animations', 'false');
		localStorage.setItem('nido.scrollFollowCursor', 'false');
		localStorage.setItem('nido.lineHeight', '18');
	});
	await page.goto(`${origin}?view=app`);
	// The first layout refills both scroll caches once idle; let that finish before counting.
	await page.clock.runFor(300);
	await page.evaluate(() => {
		const api = window.nido;
		let fraction = 0;
		let column = 0;
		window.nido = new Proxy(api, {
			get(target, method) {
				if (method !== 'scroll') return Reflect.get(target, method);
				return async (...args: Parameters<typeof api.scroll>) => {
					await api.scroll(...args);
					fraction += args[1];
					column = Math.max(0, column + (args[4] ?? 0));
					window.rendererTest.emit({
						type: 'redraw',
						id: args[0],
						events: [
							['nido_pixel_scroll', [fraction, true, undefined, false, column]],
							['flush']
						]
					});
				};
			}
		});
	});
	const canvas = page.locator('canvas:visible');
	const totals = (): Promise<{
		lines: number;
		columns: number;
		count: number;
		prefetches: number;
	}> =>
		page.evaluate(() => {
			const calls = window.rendererTest.calls;
			const scrolls = calls.filter((call) => call.method === 'scroll');
			return {
				lines: scrolls.reduce((sum, call) => sum + Number(call.args[1]), 0),
				columns: scrolls.reduce((sum, call) => sum + Number(call.args[4] ?? 0), 0),
				count: scrolls.length,
				prefetches: calls.filter((call) => call.method === 'prefetchScroll').length
			};
		});
	const before = await totals();
	await canvas.dispatchEvent('wheel', { deltaX: 16, deltaY: 0.1 });
	await expect.poll(totals).toMatchObject({ lines: 0, columns: 8, count: before.count + 1 });
	for (const direction of [1, -1]) {
		for (let step = direction > 0 ? 1 : 0; step < 8; step++) {
			await canvas.dispatchEvent('wheel', {
				deltaX: direction * 16,
				deltaY: step % 2 ? 0.1 : -0.1
			});
			await page.clock.runFor(16);
		}
	}
	await page.clock.runFor(200);
	await expect
		.poll(totals)
		.toMatchObject({ lines: 0, columns: 0, prefetches: before.prefetches });
	expect((await totals()).count - before.count).toBeLessThan(8);

	const diagonal = await totals();
	await canvas.dispatchEvent('wheel', { deltaX: 36, deltaY: 36 });
	await page.clock.runFor(64);
	await expect.poll(async () => (await totals()).lines).toBeGreaterThan(diagonal.lines);
	await expect.poll(async () => (await totals()).columns).toBeGreaterThan(diagonal.columns);
	const vertical = await totals();
	await canvas.dispatchEvent('wheel', { deltaY: 36 });
	await page.clock.runFor(64);
	await expect.poll(async () => (await totals()).lines).toBeCloseTo(vertical.lines + 1, 10);
	expect((await totals()).columns).toBe(vertical.columns);

	const shifted = await totals();
	await canvas.dispatchEvent('wheel', { deltaY: 4, deltaMode: 1, shiftKey: true });
	await page.clock.runFor(200);
	await expect.poll(async () => (await totals()).columns).toBe(shifted.columns + 2);
	expect((await totals()).lines).toBe(shifted.lines);
	for (const mode of [1, 2]) {
		const discrete = await totals();
		await canvas.dispatchEvent('wheel', { deltaX: 2, deltaY: 0.01, deltaMode: mode });
		await page.clock.runFor(64);
		await expect.poll(async () => (await totals()).lines).toBeGreaterThan(discrete.lines);
		await expect.poll(async () => (await totals()).columns).toBeGreaterThan(discrete.columns);
	}
});

test('direct horizontal frames retain fractional positions and fixed gutters through pauses and reversals', async ({
	page
}) => {
	await page.route('**/horizontal-frame-probe', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<body></body>' })
	);
	await page.goto(`${origin}horizontal-frame-probe`);
	const results = await page.evaluate(
		async ({ gridUrl, motionUrl }) => {
			const { Grid } = await import(gridUrl);
			const { paintEditorMotion } = await import(motionUrl);
			const results: number[] = [];
			for (const opacity of [1, 0.5]) {
				const grid = new Grid();
				grid.backgroundOpacity = opacity;
				grid.pixelScrollEnabled = true;
				grid.apply([['grid_resize', [1, 8, 3]], ['flush']]);
				grid.prepareLayout(40, 8, 20);
				const raw = (column: number): HTMLCanvasElement => {
					const canvas = document.createElement('canvas');
					canvas.width = 64;
					canvas.height = 40;
					const context = canvas.getContext('2d')!;
					const image = context.createImageData(64, 40);
					for (let y = 0; y < 40; y++) {
						for (let x = 0; x < 64; x++) {
							const at = (y * 64 + x) * 4;
							const value = x < 16 ? 200 : ((x - 16 + column * 8) % 17) * 12;
							image.data.set([value, 100, 60, Math.round(255 * opacity)], at);
						}
					}
					context.putImageData(image, 0, 0);
					return canvas;
				};
				for (const [ahead, direction] of [
					[1, 1],
					[1, -1],
					[4, 1],
					[4, -1]
				]) {
					const previousFrame = raw(direction > 0 ? 0 : ahead);
					const surface = raw(direction > 0 ? ahead : 0);
					const targetFrame = document.createElement('canvas');
					let motion: FrameMotion | undefined = {
						top: 0,
						bottom: 2,
						left: 2,
						right: 8,
						distance: 0,
						distanceX: direction * ahead * 8,
						incomingRows: 0,
						start: performance.now() - 10000,
						duration: 1,
						offsetX: direction > 0 ? 6 : -2
					};
					for (const position of [0.25, 0.5]) {
						motion!.offsetX = ((direction > 0 ? ahead : 0) - position) * 8;
						const painted = paintEditorMotion({
							motion,
							grid,
							surface,
							previousFrame,
							targetFrame,
							cellWidth: 8,
							dpr: 1,
							animate: false,
							backgroundOpacity: opacity,
							reuseTarget: motion!.targetReady === true
						});
						motion = painted.motion;
						const actual = surface.getContext('2d')!.getImageData(0, 0, 64, 40).data;
						const expected = raw(position)
							.getContext('2d')!
							.getImageData(0, 0, 64, 40).data;
						results.push(
							actual.reduce(
								(count, value, index) => count + Number(value !== expected[index]),
								0
							)
						);
						if (!motion) throw new Error('A touchpad fraction must survive a pause');
					}
				}
			}
			return results;
		},
		{
			gridUrl: viteFsUrl('src/renderer/src/grid/grid.ts'),
			motionUrl: viteFsUrl('src/renderer/src/editor/editorMotion.ts')
		}
	);
	expect(results).toEqual(Array(16).fill(0));
});

for (const setting of ['on', 'off', 'reduced'] as const) {
	test(`wheel detents and touchpad input interpolate only with animations enabled (${setting})`, async ({
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
		if (setting === 'on') {
			expect(await distance()).toBe(beforeFineInput);
			await page.clock.runFor(16);
			expect(await distance()).toBeGreaterThan(beforeFineInput);
			expect(await distance()).toBeLessThan(beforeFineInput + 1 / 18);
			await page.clock.runFor(40);
		}
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
			const work = await page.evaluate(async (moduleUrl) => {
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
				const drawRow = gpu.drawArrays;
				const drawBatch = gpu.drawArraysInstanced;
				const work = {
					reads: 0,
					writes: 0,
					glyphs: 0,
					cachedGlyphs: 0,
					editedGlyphs: 0,
					uploads: 0,
					cachedUploads: 0,
					editedUploads: 0,
					drawCalls: 0
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
				gpu.drawArrays = function (...args) {
					work.drawCalls++;
					return drawRow.apply(this, args);
				};
				gpu.drawArraysInstanced = function (...args) {
					work.drawCalls++;
					return drawBatch.apply(this, args);
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
					gpu.drawArrays = drawRow;
					gpu.drawArraysInstanced = drawBatch;
				}
				durations.sort((a, b) => a - b);
				return {
					...work,
					coldMs,
					p95Ms: durations[Math.floor(durations.length * 0.95)]
				};
			}, viteFsUrl('src/renderer/src/grid/grid.ts'));
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
			if (work.uploads > 0) {
				expect(work.drawCalls).toBeGreaterThan(0);
				expect(
					work.drawCalls,
					'49 rows need at most seven batches per frame'
				).toBeLessThanOrEqual(33 * 7);
			}
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
							coldGlyphs: number;
							glyphs: number;
							changedPixels: number;
							uploads: number;
							prefixUploads: number;
							uploadedPixels: number;
							fullUploadPixels: number;
							displayClips: number;
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
						const clip = CanvasRenderingContext2D.prototype.clip;
						const upload = WebGL2RenderingContext.prototype.texImage2D;
						const uploadPrefix = WebGL2RenderingContext.prototype.texSubImage2D;
						const canvases = new WeakSet<HTMLCanvasElement>();
						let canvasCount = 0;
						let glyphs = 0;
						let uploads = 0;
						let prefixUploads = 0;
						let uploadedPixels = 0;
						let displayClips = 0;
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
						CanvasRenderingContext2D.prototype.clip = function (...args) {
							if (this.canvas === canvas) displayClips++;
							return Reflect.apply(clip, this, args);
						};
						WebGL2RenderingContext.prototype.texImage2D = function (...args) {
							uploads++;
							const source = args.at(-1);
							if (source instanceof HTMLCanvasElement) {
								uploadedPixels += source.width * source.height;
							}
							return Reflect.apply(upload, this, args);
						};
						WebGL2RenderingContext.prototype.texSubImage2D = function (...args) {
							prefixUploads++;
							uploadedPixels += args[4] * args[5];
							return Reflect.apply(uploadPrefix, this, args);
						};
						const durations: number[] = [];
						let initialImages = 0;
						let coldGlyphs = 0;
						let changedPixels = 0;
						try {
							paint();
							initialImages = canvasCount;
							coldGlyphs = glyphs;
							const context = canvas.getContext('2d')!;
							const sampleHeight = Math.ceil(19 * devicePixelRatio);
							const initialPixels = context.getImageData(
								0,
								0,
								canvas.width,
								sampleHeight
							).data;
							glyphs = uploads = prefixUploads = uploadedPixels = displayClips = 0;
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
							// Read pixels outside the measured frames. Warm glyph reuse still
							// has to update the visible rows and upload their changed rasters.
							const finalPixels = context.getImageData(
								0,
								0,
								canvas.width,
								sampleHeight
							).data;
							changedPixels = finalPixels.reduce(
								(count, value, index) =>
									count + Number(value !== initialPixels[index]),
								0
							);
						} finally {
							HTMLCanvasElement.prototype.getContext = getContext;
							CanvasRenderingContext2D.prototype.fillText = text;
							CanvasRenderingContext2D.prototype.clip = clip;
							WebGL2RenderingContext.prototype.texImage2D = upload;
							WebGL2RenderingContext.prototype.texSubImage2D = uploadPrefix;
						}
						const slowFrames = durations
							.map((ms, frame) => ({ frame, ms }))
							.filter(({ ms }) => ms > 25);
						durations.sort((a, b) => a - b);
						reports.push({
							rows,
							direction,
							frames: durations.length,
							coldGlyphs,
							glyphs,
							changedPixels,
							uploads,
							prefixUploads,
							uploadedPixels,
							fullUploadPixels:
								durations.length *
								49 *
								canvas.width *
								Math.ceil(19 * devicePixelRatio),
							displayClips,
							canvases: canvasCount - initialImages,
							p50Ms: durations[20],
							p95Ms: durations[38],
							maxMs: durations[39],
							slowFrames
						});
						return reports;
					},
					{
						moduleUrl: viteFsUrl('src/renderer/src/grid/grid.ts'),
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
					expect(
						work.coldGlyphs,
						'initial text must exercise cold rasterization'
					).toBeGreaterThan(0);
					expect(
						work.changedPixels,
						'scrolling must change the visible row pixels'
					).toBeGreaterThan(0);
					expect(work.uploads, 'incoming row rasters must reach WebGL').toBeGreaterThan(
						0
					);
					if (!process.env.NIDO_PERFORMANCE_BASELINE) {
						expect(
							work.glyphs,
							'repaint incoming text and the changed gutter only'
						).toBeLessThanOrEqual(work.frames * (work.rows * 160 + 49 * 8));
						expect(
							work.prefixUploads,
							'changed line numbers upload their prefix'
						).toBeGreaterThan(0);
						expect(
							work.uploads,
							'only incoming rows upload whole textures'
						).toBeLessThanOrEqual(work.frames * work.rows);
						expect(work.uploadedPixels / work.fullUploadPixels).toBeLessThan(0.25);
						expect(work.displayClips).toBeLessThanOrEqual(work.frames * 5);
					}
					expect(work.uploads + work.prefixUploads).toBeLessThanOrEqual(work.frames * 49);
					expect(work.canvases).toBeLessThanOrEqual(work.frames * work.rows);
				}
			} finally {
				await context.close();
			}
		});
	}
}
