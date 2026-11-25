import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import { installRowImageProbe, useRowImages } from './helpers/row-image-probe';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorkspace } from './helpers/electron-shared';
import { launchEnv } from './helpers/launch-env';

test('typing hides the pointer and moving or clicking restores it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-pointer-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
		env
	});
	try {
		const page = await running.firstWindow();
		const settings = page.getByRole('button', { name: 'Settings', exact: true });
		await settings.click();
		const slider = page.getByRole('spinbutton', { name: 'Editor font size' });
		await slider.focus();
		await page.keyboard.press('ArrowRight');
		await expect(slider).toHaveCSS('cursor', 'none');
		await expect(settings).toHaveCSS('cursor', 'none');
		await page.mouse.move(600, 400);
		await expect(slider).not.toHaveCSS('cursor', 'none');
		await page.keyboard.press('ArrowLeft');
		await expect(slider).toHaveCSS('cursor', 'none');
		await page.mouse.down();
		await page.mouse.up();
		await expect(settings).not.toHaveCSS('cursor', 'none');
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('relative line numbers update immediately and persist after restarting', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-line-numbers-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'lines.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		running = await electron.launch(options);
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('lines.txt');
		await expect(page.getByRole('button', { name: /lines.txt/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /line 1/);
		await page.keyboard.type('3G');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const setting = page.getByRole('checkbox', { name: 'Relative line numbers' });
		await expect(setting).not.toBeChecked();
		const editorConfig = page.getByRole('checkbox', { name: 'Use EditorConfig' });
		await expect(editorConfig).toBeChecked();
		await editorConfig.uncheck();
		await setting.check();
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/^\s*2\s+line 1/
		);
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/\n\s*3\s+line 3/
		);
		await setting.uncheck();
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/^\s*1\s+line 1/
		);
		await setting.check();
		await page.keyboard.press('Escape');
		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/^\s*2\s+line 1/
		);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(page.getByRole('checkbox', { name: 'Relative line numbers' })).toBeChecked();
		await expect(page.getByRole('checkbox', { name: 'Use EditorConfig' })).not.toBeChecked();
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('word wrap updates long lines immediately and persists after restarting', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-word-wrap-ui-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'long.txt'), `${'x'.repeat(400)}WRAP_END\nnext line\n`);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		running = await electron.launch(options);
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('long.txt');
		await expect(page.getByRole('button', { name: /long.txt/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/WRAP_END/
		);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const setting = page.getByRole('checkbox', { name: 'Word wrap', exact: true });
		await expect(setting).toBeChecked();
		await setting.uncheck();
		await expect(page.locator('canvas:visible')).not.toHaveAttribute(
			'aria-description',
			/WRAP_END/
		);
		await setting.focus();
		await page.keyboard.press('Enter');
		await expect(setting).toBeChecked();
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/WRAP_END/
		);
		await setting.uncheck();
		await page.keyboard.press('Escape');
		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/next line/
		);
		await expect(page.locator('canvas:visible')).not.toHaveAttribute(
			'aria-description',
			/WRAP_END/
		);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(
			page.getByRole('checkbox', { name: 'Word wrap', exact: true })
		).not.toBeChecked();
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('touchpad horizontal scrolling reveals long lines and preserves ordinary editing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-horizontal-scroll-ui-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	const file = join(workspace, 'wide.log');
	await writeFile(
		file,
		[
			'short',
			...Array.from(
				{ length: 99 },
				(_, index) =>
					`LEFT_${index} 2026-10-25T12:29:10Z INFO params=[${'42, '.repeat(40)}0] message="日本語" RIGHT_${index}`
			)
		].join('\n') + '\n'
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.setViewportSize({ width: 1000, height: 700 });
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('wide.log');
		await expect(page.getByRole('button', { name: /wide.log/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Word wrap', exact: true }).uncheck();
		await page
			.getByRole('checkbox', { name: 'Cursor follows scrolling', exact: true })
			.uncheck();
		await page.keyboard.press('Escape');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /LEFT_0/);
		await expect(canvas).not.toHaveAttribute('aria-description', /RIGHT_0/);
		const startFractional = (): Promise<{ width: number; gutter: number; pixels: number[] }> =>
			canvas.evaluate(async (surface: HTMLCanvasElement) => {
				const ctx = surface.getContext('2d')!;
				const width =
					Math.ceil(ctx.measureText('M').width * devicePixelRatio) / devicePixelRatio;
				const pixels = Array.from(
					ctx.getImageData(
						100 * devicePixelRatio,
						80 * devicePixelRatio,
						200 * devicePixelRatio,
						18 * devicePixelRatio
					).data
				);
				return new Promise<{ width: number; gutter: number; pixels: number[] }>(
					(resolve) => {
						const unsubscribe = window.nido.onEvent((event) => {
							if (event.type !== 'redraw') return;
							const scroll = event.events.find(
								([name]) => name === 'nido_scroll'
							)?.[1];
							if (!(Number(scroll?.[8]) > 0)) return;
							unsubscribe();
							requestAnimationFrame(() =>
								requestAnimationFrame(() =>
									resolve({ width, gutter: Number(scroll![3]), pixels })
								)
							);
						});
						surface.dispatchEvent(
							new WheelEvent('wheel', {
								bubbles: true,
								deltaX: width / 2,
								deltaY: 0.1
							})
						);
					}
				);
			});
		const fractional = await startFractional();
		const pausedPixels = await canvas.evaluate(async (surface: HTMLCanvasElement) => {
			const input = document.querySelector<HTMLTextAreaElement>(
				'[aria-label="Neovim input"]'
			)!;
			const ctx = surface.getContext('2d')!;
			const pixels = (): Uint8ClampedArray =>
				ctx.getImageData(
					100 * devicePixelRatio,
					80 * devicePixelRatio,
					200 * devicePixelRatio,
					18 * devicePixelRatio
				).data;
			const before = pixels();
			input.blur();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			const paused = pixels();
			input.focus();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			const resumed = pixels();
			return {
				paused: before.reduce((count, value, i) => count + Number(value !== paused[i]), 0),
				resumed: before.reduce((count, value, i) => count + Number(value !== resumed[i]), 0)
			};
		});
		expect(pausedPixels).toEqual({ paused: 0, resumed: 0 });
		const centered = await canvas.evaluate((surface: HTMLCanvasElement, initial) => {
			const pixels = Array.from(
				surface
					.getContext('2d')!
					.getImageData(
						100 * devicePixelRatio,
						80 * devicePixelRatio,
						200 * devicePixelRatio,
						18 * devicePixelRatio
					).data
			);
			return new Promise<{ column: number; pixels: number[] }>((resolve) => {
				const unsubscribe = window.nido.onEvent((event) => {
					if (event.type !== 'redraw') return;
					// An idle gesture is already aligned; a click then publishes a non-pixel restore.
					const offset = event.events
						.flatMap(([name, ...calls]) => (name === 'nido_pixel_scroll' ? calls : []))
						.at(-1);
					if (!offset) return;
					unsubscribe();
					resolve({ column: Number(offset[4]), pixels });
				});
				const bounds = surface.getBoundingClientRect();
				const point = {
					bubbles: true,
					cancelable: true,
					button: 0,
					pointerId: 1,
					pointerType: 'mouse',
					clientX: bounds.left + (initial.gutter + 20.5) * initial.width,
					clientY: bounds.top + 27
				};
				surface.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1 }));
				surface.dispatchEvent(new PointerEvent('pointerup', { ...point, buttons: 0 }));
			});
		}, fractional);
		expect(centered.column).toBeGreaterThanOrEqual(0);
		expect(centered.column).toBeLessThanOrEqual(1);
		await expect(page.getByText('Ln 2, Col 21', { exact: true })).toBeVisible();
		await expect
			.poll(() =>
				canvas.evaluate(
					(surface: HTMLCanvasElement, before) => {
						const pixels = surface
							.getContext('2d')!
							.getImageData(
								100 * devicePixelRatio,
								80 * devicePixelRatio,
								200 * devicePixelRatio,
								18 * devicePixelRatio
							).data;
						// A click aligns active lookahead or preserves an already settled fractional frame.
						return Math.min(
							...before.map((frame) =>
								frame.reduce(
									(count, value, i) => count + Number(value !== pixels[i]),
									0
								)
							)
						);
					},
					[fractional.pixels, centered.pixels]
				)
			)
			.toBe(0);
		await canvas.evaluate(async (surface: HTMLCanvasElement, width) => {
			// Cached horizontal frames can preview the next gesture without another native redraw.
			surface.dispatchEvent(
				new WheelEvent('wheel', { bubbles: true, deltaX: width / 2, deltaY: 0.1 })
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
		}, fractional.width);
		await canvas.click({
			position: { x: (fractional.gutter + 0.1) * fractional.width, y: 27 }
		});
		await expect(page.getByText('Ln 2, Col 1', { exact: true })).toBeVisible();
		await page.keyboard.type('iQ');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect.poll(() => readSavedFile(file)).toMatch(/^short\r?\nQLEFT_0 /);
		await page.keyboard.type('ugg0');
		await page.keyboard.press('Control+s');
		const axisSwitch = await canvas.evaluate(
			(surface: HTMLCanvasElement, width) =>
				new Promise<{ column: number; overscan: number; inputInterval: number }>(
					(resolve) => {
						let overscan = -1;
						let inputInterval = 0;
						const unsubscribe = window.nido.onEvent((event) => {
							if (event.type !== 'redraw') return;
							for (const [name, ...calls] of event.events) {
								if (name !== 'nido_pixel_scroll') continue;
								for (const args of calls) {
									if (args[1] !== true) continue;
									const column = Number(args[4]);
									overscan = Math.max(overscan, column);
									if (!(Number(args[0]) > 0)) continue;
									unsubscribe();
									requestAnimationFrame(() =>
										requestAnimationFrame(() =>
											resolve({ column, overscan, inputInterval })
										)
									);
									return;
								}
							}
						});
						const started = performance.now();
						surface.dispatchEvent(
							new WheelEvent('wheel', { bubbles: true, deltaX: width })
						);
						surface.dispatchEvent(
							new WheelEvent('wheel', { bubbles: true, deltaY: 12 })
						);
						inputInterval = performance.now() - started;
					}
				),
			fractional.width
		);
		expect(axisSwitch.overscan).toBeGreaterThan(1);
		expect(axisSwitch.inputInterval).toBeLessThan(160);
		expect(axisSwitch.column).toBeGreaterThanOrEqual(0);
		expect(axisSwitch.column).toBeLessThanOrEqual(1);
		await expect(canvas).toHaveAttribute('aria-description', /LEFT_/);
		await canvas.hover();
		await page.mouse.wheel(3000, 0);
		await expect(canvas).toHaveAttribute('aria-description', /RIGHT_0/);
		await expect(canvas).not.toHaveAttribute('aria-description', /LEFT_0/);
		await page.mouse.wheel(-3000, 0);
		await expect(canvas).toHaveAttribute('aria-description', /LEFT_0/);
		await page.mouse.wheel(3000, 0);
		await expect(canvas).toHaveAttribute('aria-description', /RIGHT_0/);
		await page.keyboard.type('iX');
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /Xshort/);
		await page.keyboard.press('Control+s');
		await expect.poll(() => readSavedFile(file)).toMatch(/^Xshort\r?\nLEFT_0 /);
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('font family and line height update the canvas and survive restarting', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-font-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(
		join(workspace, 'sample.rs'),
		[
			'/// 構築されたCell(apply_text)から、描画処理に渡す文字列を取得する',
			'pub fn get_text(&mut self) -> &str {',
			'    let cells = self.cells.get_cells().iter().enumerate();',
			'}',
			''
		].join('\n')
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const options = {
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
		env
	};
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		running = await electron.launch(options);
		let page = await running.firstWindow();
		await useRowImages(page);
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type(':edit sample.rs');
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/get_text/
		);
		const canvasFont = (): Promise<string> =>
			page
				.locator('canvas:visible')
				.evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.font);
		await page.locator('canvas:visible').evaluate((canvas: HTMLCanvasElement) => {
			const context = canvas.getContext('2d')!;
			const draw = context.drawImage.bind(context);
			const fill = context.fillRect.bind(context);
			let firstY: number | undefined;
			context.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height > 100) {
					firstY = undefined;
				}
				fill(x, y, width, height);
			};
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				if ((args as unknown[]).length === 5) {
					const y = Number(args[2]);
					if (firstY === undefined) {
						firstY = y;
					} else if (y > firstY) {
						canvas.dataset.lineHeight = String(y - firstY);
						firstY = Infinity;
					}
				}
				draw(...args);
			}) as typeof draw;
		});
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const heightInput = page.getByRole('spinbutton', { name: 'Editor line height' });
		await expect(heightInput).toHaveValue('18');
		const weightInput = page.getByRole('spinbutton', { name: 'Editor font weight' });
		await expect(weightInput).toHaveValue('350');
		await page.keyboard.press('Escape');
		await page
			.locator('canvas:visible')
			.screenshot({ path: 'test-results/nido-font-weight-350.png' });
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await weightInput.fill('400');
		await expect.poll(canvasFont).not.toContain('350 ');
		await page.keyboard.press('Escape');
		await page
			.locator('canvas:visible')
			.screenshot({ path: 'test-results/nido-font-weight-400.png' });
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await weightInput.fill('350');
		// Row images snap to physical pixels, so fractional DPI can round their spacing.
		const physicalPixel = await page.evaluate(() => 1 / window.devicePixelRatio);
		const heightError = (height: number): Promise<number> =>
			page
				.locator('canvas:visible')
				.getAttribute('data-line-height')
				.then((value) => Math.abs(Number(value) - height));
		await expect.poll(() => heightError(18)).toBeLessThanOrEqual(physicalPixel + 0.001);
		await heightInput.fill('28');
		await expect.poll(() => heightError(28)).toBeLessThanOrEqual(physicalPixel + 0.001);
		let input = page.getByRole('textbox', { name: 'Font family', exact: true });
		const defaultFamily = await input.inputValue();
		expect(defaultFamily).toContain('Cascadia Code');
		await input.fill('monospace');
		await expect.poll(canvasFont).toBe('350 15px monospace');
		await weightInput.fill('400');
		await expect.poll(canvasFont).toBe('15px monospace');
		await weightInput.fill('450');
		await expect.poll(canvasFont).toBe('450 15px monospace');
		await weightInput.fill('');
		await weightInput.blur();
		await expect(weightInput).toHaveValue('450');
		await weightInput.fill('950');
		await weightInput.blur();
		await expect(weightInput).toHaveValue('450');
		await input.fill('   ');
		await expect.poll(canvasFont).toContain('Cascadia Code');
		await input.fill('Consolas');
		await expect.poll(canvasFont).toBe('450 15px Consolas');
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(input).toHaveValue('Consolas');
		await expect(page.getByRole('spinbutton', { name: 'Editor line height' })).toHaveValue(
			'28'
		);
		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		input = page.getByRole('textbox', { name: 'Font family', exact: true });
		await expect(input).toHaveValue('Consolas');
		await expect(page.getByRole('spinbutton', { name: 'Editor line height' })).toHaveValue(
			'28'
		);
		await expect(page.getByRole('spinbutton', { name: 'Editor font weight' })).toHaveValue(
			'450'
		);
		await expect.poll(canvasFont).toBe('450 15px Consolas');
		await expect(input).toHaveCSS('background-color', 'rgb(18, 20, 22)');
		await input.focus();
		await page.screenshot({ path: 'test-results/nido-font-settings.png' });
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Japanese editor text stays legible at fractional display scales', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-legibility-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(
		join(workspace, 'sample.ts'),
		[
			'// カーソルから画面末尾まで消去する',
			'// 日本語の描画位置・文字の明るさを確認',
			'export function setCursor(row: number, col: number) {',
			'    const message = "画面の表示を更新します";',
			'    const index = (row - 1) * 80 + col;',
			'    return { index, message };',
			'}',
			''
		].join('\n')
	);
	await writeFile(join(workspace, 'tsconfig.json'), '{}');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`, '--force-device-scale-factor=1.25'],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.ts');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /日本語の描画位置/);
		await canvas.evaluate((element: HTMLCanvasElement) => {
			const fillText = CanvasRenderingContext2D.prototype.fillText;
			element.dataset.aligned = 'true';
			CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
				const dpr = window.devicePixelRatio;
				if (
					Math.abs(x * dpr - Math.round(x * dpr)) > 0.001 ||
					Math.abs(y * dpr - Math.round(y * dpr)) > 0.001
				) {
					element.dataset.aligned = 'false';
				}
				if (text === '語') element.dataset.japaneseInk = String(this.fillStyle);
				if (this.fillStyle === '#ffb300')
					element.dataset.parameterInk = String(this.fillStyle);
				fillText.call(this, text, x, y);
			};
			const ctx = element.getContext('2d')!;
			const draw = ctx.drawImage.bind(ctx);
			ctx.drawImage = ((...args: Parameters<typeof draw>) => {
				if (
					(args as unknown[]).length === 5 &&
					Math.abs(
						Number(args[2]) * window.devicePixelRatio -
							Math.round(Number(args[2]) * window.devicePixelRatio)
					) > 0.001
				) {
					element.dataset.aligned = 'false';
				}
				draw(...args);
			}) as typeof draw;
		});
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'UI animations' }).uncheck();
		await page.getByRole('button', { name: 'Close palette' }).click();
		await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
		await expect(canvas).toHaveAttribute('data-japanese-ink', '#6a9955');
		await expect(canvas).toHaveAttribute('data-parameter-ink', '#ffb300');
		await expect(canvas).toHaveAttribute('data-aligned', 'true');
		expect(
			await canvas.evaluate(
				(element: HTMLCanvasElement) =>
					element.getContext('2d')!.getContextAttributes().alpha
			)
		).toBe(false);
		const bounds = (await canvas.boundingBox())!;
		await page.screenshot({
			path: 'test-results/nido-reference-colors.png',
			clip: { ...bounds, height: 240 }
		});
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('clicking editor glyphs moves the cursor, including wide text and detached pixel scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-click-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
	lines[1] = 'ab日本語xyz';
	lines[29] = '\tΩtarget';
	await writeFile(join(root, 'click.txt'), lines.join('\n'));
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	let failed = false;
	try {
		const page = await running.firstWindow();
		await useRowImages(page);
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(
			page.getByRole('textbox', { name: 'Neovim input', exact: true })
		).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('click.txt');
		await expect(
			page.getByRole('button', { name: 'click.txt click.txt', exact: true })
		).toBeVisible();
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		const waitForScroll = async (attribute: string): Promise<void> => {
			await expect
				.poll(() =>
					canvas.evaluate(async (node, pointAttribute) => {
						const before = node.getAttribute(pointAttribute);
						for (let frame = 0; frame < 2; frame++) {
							await new Promise<void>((resolve) =>
								requestAnimationFrame(() => resolve())
							);
							if (node.getAttribute('data-pending-scrolls') !== '0') return false;
						}
						return before === node.getAttribute(pointAttribute);
					}, attribute)
				)
				.toBe(true);
		};
		await expect(canvas).toHaveAttribute('aria-description', /ab日本語xyz/);
		await canvas.evaluate((node: HTMLCanvasElement) => {
			let pendingScrolls = 0;
			node.dataset.pendingScrolls = '0';
			const scroll = window.nido.scroll;
			window.nido.scroll = async (...args) => {
				node.dataset.pendingScrolls = String(++pendingScrolls);
				try {
					return await scroll(...args);
				} finally {
					node.dataset.pendingScrolls = String(--pendingScrolls);
				}
			};
			const ctx = node.getContext('2d')!;
			let row = 0;
			const fill = ctx.fillRect.bind(ctx);
			ctx.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height > 100) {
					row = 0;
				}
				fill(x, y, width, height);
			};
			const draw = ctx.drawImage.bind(ctx);
			ctx.drawImage = ((...args: Parameters<typeof draw>) => {
				draw(...args);
				if ((args as unknown[]).length !== 5) return;
				if (
					(args[0] as HTMLCanvasElement).height >
					Math.ceil(Number(localStorage.getItem('nido.lineHeight')) * devicePixelRatio)
				) {
					// The GPU light-correction pass composites a viewport, not another row.
					return;
				}
				const index = row++;
				const y = Number(args[2]) + Number(args[4]) / 2;
				queueMicrotask(() => {
					const line = node.getAttribute('aria-description')!.split('\n')[index] || '';
					const wide = line.indexOf('ab日本語');
					const tab = line.indexOf('Ω');
					const column = wide >= 0 ? wide + 4 + 1.25 : tab + 0.5;
					if (wide < 0 && tab < 0) return;
					node.setAttribute(
						wide >= 0 ? 'data-wide-point' : 'data-tab-point',
						JSON.stringify({
							x:
								column *
								(Math.ceil(ctx.measureText('M').width * devicePixelRatio) /
									devicePixelRatio),
							y
						})
					);
				});
			}) as typeof draw;
		});
		await canvas.hover();
		await page.mouse.wheel(0, 3);
		await expect(canvas).toHaveAttribute('data-wide-point', /x/);
		await waitForScroll('data-wide-point');
		const point = JSON.parse((await canvas.getAttribute('data-wide-point'))!);
		const bounds = (await canvas.boundingBox())!;
		await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
		await page.mouse.down();
		try {
			await expect(page.getByText('Ln 2, Col 6', { exact: true })).toBeVisible({
				timeout: 1000
			});
			await expect
				.poll(async () => JSON.parse((await canvas.getAttribute('data-wide-point'))!).y)
				.toBe(point.y);
		} finally {
			await page.mouse.up();
		}
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).uncheck();
		await page.keyboard.press('Escape');
		await canvas.hover();
		await canvas.evaluate((node) => node.removeAttribute('data-tab-point'));
		await page.mouse.wheel(0, 507);
		await expect(canvas).toHaveAttribute('data-tab-point', /x/);
		await waitForScroll('data-tab-point');
		await expect(page.getByText('Ln 2, Col 6', { exact: true })).toBeVisible();
		const tabPoint = JSON.parse((await canvas.getAttribute('data-tab-point'))!);
		await canvas.click({ position: tabPoint });
		await expect(page.getByText('Ln 30, Col 2', { exact: true })).toBeVisible();
		await expect
			.poll(async () => JSON.parse((await canvas.getAttribute('data-tab-point'))!).y)
			.toBe(tabPoint.y);
		// Separate the next click from Neovim's double-click selection interval.
		await page.waitForTimeout(600);
		await page.keyboard.press('i');
		await canvas.click({
			position: JSON.parse((await canvas.getAttribute('data-tab-point'))!)
		});
		await page.keyboard.type('X');
		await page.keyboard.press('Escape');
		await page.keyboard.type(':w');
		await page.keyboard.press('Enter');
		await expect.poll(() => readSavedFile(join(root, 'click.txt'))).toContain('\tXΩtarget');
	} catch (error) {
		failed = true;
		running.process().kill();
		throw error;
	} finally {
		if (failed) await running.close().catch(() => {});
		else await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('activity bar placement switches live and survives restart with editing and navigation intact', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-activity-bar-'));
	const workspace = join(root, 'Project');
	await mkdir(workspace);
	await writeFile(join(workspace, 'notes.txt'), 'hello\n');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
	let running = await electron.launch(options);
	try {
		let page = await running.firstWindow();
		let navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Command palette', exact: true })
			.click();
		const commands = page.getByRole('dialog', { name: 'commands palette', exact: true });
		await expect(commands).toBeVisible();
		await commands.getByRole('button', { name: 'Close palette' }).click();
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Settings', exact: true })
			.click();
		await page.getByRole('combobox', { name: 'Activity bar position' }).selectOption('top');
		await page.keyboard.press('Escape');
		await expect(navigation).toHaveAttribute('data-position', 'top');
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(
			page.getByRole('textbox', { name: 'Neovim input', exact: true })
		).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('notes.txt');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
		await page.keyboard.type('A unsaved');
		await page.keyboard.press('Escape');
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Settings', exact: true })
			.click();
		const position = page.getByRole('combobox', { name: 'Activity bar position' });
		await position.selectOption('left');
		await expect(navigation).toHaveAttribute('data-position', 'left');
		await position.selectOption('top');
		await page.keyboard.press('Escape');
		await expect(
			page.getByRole('tab', { name: 'notes.txt Unsaved', exact: true })
		).toBeVisible();
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(workspace, 'notes.txt')))
			.toBe('hello unsaved\n');
		const explorer = page.getByRole('complementary', { name: 'File explorer' });
		const bar = (await navigation.boundingBox())!;
		const side = (await explorer.boundingBox())!;
		assert.equal(bar.x, side.x);
		assert.equal(bar.width, side.width);
		assert.ok(bar.y + bar.height <= side.y);
		await navigation.getByRole('button', { name: 'Source control', exact: true }).click();
		const git = page.getByRole('dialog', { name: 'git palette', exact: true });
		await expect(git).toBeVisible();
		await git.getByRole('button', { name: 'Close palette' }).click();
		await expect(git).not.toBeVisible();
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Settings', exact: true })
			.click();
		await page.getByRole('checkbox', { name: 'Show file explorer' }).uncheck();
		await page.keyboard.press('Escape');
		await expect(explorer).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Explorer', exact: true }).click();
		await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
		await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
		await page.screenshot({
			path: 'test-results/activity-bar-top.png',
			animations: 'disabled'
		});
		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
		await expect(navigation).toHaveAttribute('data-position', 'top');
		await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Settings', exact: true })
			.click();
		await expect(page.getByRole('combobox', { name: 'Activity bar position' })).toHaveValue(
			'top'
		);
		await page.screenshot({
			path: 'test-results/activity-bar-settings.png',
			animations: 'disabled'
		});
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('settings can be navigated and changed entirely with the keyboard', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-settings-keys-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env });
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(
			page.getByRole('textbox', { name: 'Neovim input', exact: true })
		).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press(',');
		const language = page.getByRole('combobox', { name: 'Language', exact: true });
		await expect(language).toBeFocused();
		await page.screenshot({
			path: 'test-results/settings-general.png',
			animations: 'disabled'
		});
		await page.keyboard.press('Tab');
		await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeFocused();
		await page.keyboard.press('Control+j');
		const explorer = page.getByRole('checkbox', { name: 'Show file explorer' });
		await expect(explorer).toBeFocused();
		await page.keyboard.press('Space');
		await expect(explorer).not.toBeChecked();
		await page.keyboard.press('Enter');
		await expect(explorer).toBeChecked();
		await page.keyboard.press('ArrowDown');
		const activityBarPosition = page.getByRole('combobox', { name: 'Activity bar position' });
		await expect(activityBarPosition).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(activityBarPosition).toHaveValue('top');
		await page.keyboard.press('Control+j');
		const compactMode = page.getByRole('checkbox', {
			name: 'Compact mode'
		});
		await expect(compactMode).toBeFocused();
		await page.keyboard.press('Space');
		await expect(compactMode).toBeChecked();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
			.toBe('true');
		await page.keyboard.press('Control+j');
		await expect(page.getByRole('checkbox', { name: 'UI animations' })).toBeFocused();
		await page.keyboard.press('j');
		const family = page.getByRole('textbox', { name: 'Font family' });
		await expect(family).toBeFocused();
		await page.keyboard.press('Control+a');
		await page.keyboard.type('jk monospace');
		await expect(family).toHaveValue('jk monospace');
		await page.keyboard.press('Control+j');
		const size = page.getByRole('spinbutton', { name: 'Editor font size' });
		await expect(size).toBeFocused();
		await size.fill('18');
		await expect(size).toHaveValue('18');
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.fontSize')))
			.toBe('18');
		await size.fill('100');
		await page.keyboard.press('Tab');
		await expect(size).toHaveValue('18');
		await page.keyboard.press('Shift+Tab');
		await expect(size).toBeFocused();
		const initial = Number(await size.inputValue());
		// The font size steps by half pixels.
		await page.keyboard.press('ArrowUp');
		await expect(size).toHaveValue(String(initial + 0.5));
		await page.keyboard.press('j');
		const weight = page.getByRole('spinbutton', { name: 'Editor font weight' });
		await expect(weight).toBeFocused();
		await expect(weight).toHaveValue('350');
		await page.keyboard.press('ArrowUp');
		await expect(weight).toHaveValue('400');
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.fontWeight')))
			.toBe('400');
		await page.keyboard.press('j');
		await expect(page.getByRole('spinbutton', { name: 'Editor line height' })).toBeFocused();
		for (const name of [
			'Relative line numbers',
			'Word wrap',
			'Method separators',
			'Sticky Scroll'
		]) {
			await page.keyboard.press('j');
			await expect(page.getByRole('checkbox', { name, exact: true })).toBeFocused();
		}
		await page.keyboard.press('j');
		await expect(
			page.getByRole('spinbutton', { name: 'Sticky Scroll maximum lines' })
		).toBeFocused();
		await page.screenshot({
			path: 'test-results/settings-editor-appearance.png',
			animations: 'disabled'
		});
		for (const name of [
			'Smooth cursor movement',
			'Smooth cursor blink',
			'Cursor follows scrolling',
			'Share system clipboard',
			'Format on save',
			'Use EditorConfig'
		]) {
			await page.keyboard.press('j');
			await expect(page.getByRole('checkbox', { name })).toBeFocused();
		}
		await page.keyboard.press('j');
		const history = page.getByRole('checkbox', { name: 'Automatic edit history' });
		await expect(history).toBeFocused();
		await expect(history).toBeChecked();
		await page.keyboard.press('Space');
		await expect(history).not.toBeChecked();
		await page.keyboard.press('Enter');
		await expect(history).toBeChecked();
		const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
		await expect(shell).toBeEnabled();
		await page.keyboard.press('ArrowDown');
		await expect(shell).toBeFocused();
		await page.keyboard.press('Control+k');
		await expect(history).toBeFocused();
		await page.keyboard.press('k');
		await expect(page.getByRole('checkbox', { name: 'Use EditorConfig' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(history).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(shell).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(language).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
		await expect(page.getByRole('combobox', { name: '言語', exact: true })).toBeFocused();
		await page.screenshot({
			path: 'test-results/settings-japanese.png',
			animations: 'disabled'
		});
		await page.keyboard.press('ArrowUp');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(language).toBeFocused();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.language')))
			.toBe('en');
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByRole('button', { name: 'Close palette' })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(shell).toBeFocused();
		await page.screenshot({ path: 'test-results/settings-keyboard.png' });
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Settings' })).not.toBeVisible();
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('smooth cursor movement and blink animate and persist their settings', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-cursor-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
	let running = await electron.launch(options);
	try {
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
		await expect(editor).toBeFocused();
		await page.keyboard.type('iabcdefghijklmnopqrstuvwxyz');
		await page.keyboard.press('Escape');
		await page.keyboard.type(':w cursor.txt');
		await page.keyboard.press('Enter');
		await expect
			.poll(() => readFile(join(root, 'cursor.txt'), 'utf8').catch(() => ''))
			.toContain('abcdefghijklmnopqrstuvwxyz');
		await page.keyboard.press('Home');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const setting = page.getByRole('checkbox', { name: 'Smooth cursor movement' });
		const blinkSetting = page.getByRole('checkbox', { name: 'Smooth cursor blink' });
		const clipboardSetting = page.getByRole('checkbox', { name: 'Share system clipboard' });
		await expect(clipboardSetting).not.toBeChecked();
		await clipboardSetting.check();
		await expect(blinkSetting).not.toBeChecked();
		await expect(setting).not.toBeChecked();
		await setting.check();
		await page.getByRole('checkbox', { name: 'UI animations', exact: true }).uncheck();
		await page.getByRole('button', { name: 'Close palette' }).click();
		await expect(editor).toBeFocused();
		const canvas = page.locator('canvas:visible');
		await canvas.evaluate((node: HTMLCanvasElement) => {
			const ctx = node.getContext('2d')!;
			const fill = ctx.fillRect.bind(ctx);
			node.dataset.cursorXs = '[]';
			node.dataset.cursorAlphas = '[]';
			node.dataset.cursorYs = '[]';
			ctx.fillRect = (x, y, w, h) => {
				if (ctx.fillStyle === '#f5f5f5') {
					const xs = JSON.parse(node.dataset.cursorXs!) as number[];
					// The textarea uses host coordinates, including the canvas's DPI alignment.
					node.dataset.cursorXs = JSON.stringify([
						...xs.slice(-99),
						x + parseFloat(node.style.left)
					]);
					const ys = JSON.parse(node.dataset.cursorYs!) as number[];
					node.dataset.cursorYs = JSON.stringify([
						...ys.slice(-99),
						y + parseFloat(node.style.top)
					]);
					const alphas = JSON.parse(node.dataset.cursorAlphas!) as number[];
					node.dataset.cursorAlphas = JSON.stringify([
						...alphas.slice(-99),
						ctx.globalAlpha
					]);
				}
				fill(x, y, w, h);
			};
		});
		const move = async (keys: string): Promise<number[]> => {
			const before = await editor.evaluate((node) => node.style.left);
			await canvas.evaluate((node: HTMLCanvasElement) => {
				node.dataset.cursorXs = '[]';
			});
			await page.keyboard.type(keys);
			await expect.poll(() => editor.evaluate((node) => node.style.left)).not.toBe(before);
			await expect
				.poll(async () => {
					const xs = JSON.parse(
						(await canvas.getAttribute('data-cursor-xs'))!
					) as number[];
					const target = await editor.evaluate((node) => parseFloat(node.style.left));
					return Math.abs((xs.at(-1) ?? -1000) - target);
				})
				.toBeLessThan(0.01);
			return JSON.parse((await canvas.getAttribute('data-cursor-xs'))!);
		};
		expect(new Set((await move('10l')).map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
		const previous = await editor.evaluate((node) => parseFloat(node.style.left));
		const clickPoint = await canvas.evaluate((node: HTMLCanvasElement) => {
			node.dataset.cursorXs = '[]';
			const input = document.querySelector<HTMLTextAreaElement>(
				'[aria-label="Neovim input"]'
			)!;
			return {
				x:
					parseFloat(input.style.left) -
					parseFloat(node.style.left) +
					(Math.ceil(node.getContext('2d')!.measureText('M').width * devicePixelRatio) /
						devicePixelRatio) *
						8.5,
				y: parseFloat(input.style.top) - parseFloat(node.style.top) + 8
			};
		});
		const bounds = (await canvas.boundingBox())!;
		await page.mouse.move(bounds.x + clickPoint.x, bounds.y + clickPoint.y);
		await page.mouse.down();
		try {
			await expect
				.poll(() => editor.evaluate((node) => parseFloat(node.style.left)))
				.not.toBe(previous);
			await expect
				.poll(async () => {
					const xs = JSON.parse(
						(await canvas.getAttribute('data-cursor-xs'))!
					) as number[];
					const target = await editor.evaluate((node) => parseFloat(node.style.left));
					return Math.abs((xs.at(-1) ?? -1000) - target);
				})
				.toBeLessThan(0.01);
			const xs = JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[];
			expect(new Set(xs.map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
		} finally {
			await page.mouse.up();
		}
		expect(new Set((await move('10h')).map((x) => x.toFixed(2))).size).toBeGreaterThan(2);
		await canvas.evaluate((node: HTMLCanvasElement) => {
			node.dataset.cursorXs = '[]';
			node.dataset.cursorYs = '[]';
		});
		await page.keyboard.press('Control+s');
		await page.waitForTimeout(200);
		expect(
			new Set(JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[]).size
		).toBeLessThanOrEqual(1);
		expect(
			new Set(JSON.parse((await canvas.getAttribute('data-cursor-ys'))!) as number[]).size
		).toBeLessThanOrEqual(1);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		expect(new Set((await move('10h')).map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await setting.uncheck();
		await page.getByRole('button', { name: 'Close palette' }).click();
		expect(new Set((await move('10l')).map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
		await canvas.evaluate((node) => {
			node.dataset.cursorXs = '[]';
		});
		await canvas.click({ position: clickPoint });
		await expect
			.poll(() => editor.evaluate((node) => parseFloat(node.style.left)))
			.not.toBe(previous);
		const clickXs = JSON.parse((await canvas.getAttribute('data-cursor-xs'))!) as number[];
		expect(new Set(clickXs.map((x) => x.toFixed(2))).size).toBeLessThanOrEqual(2);
		const hasFade = async (): Promise<boolean> => {
			const alphas = JSON.parse(
				(await canvas.getAttribute('data-cursor-alphas'))!
			) as number[];
			return alphas.some((alpha) => alpha > 0.01 && alpha < 0.54);
		};
		await page.waitForTimeout(1200);
		expect(await hasFade()).toBe(false);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await setting.check();
		await blinkSetting.check();
		await page.getByRole('button', { name: 'Close palette' }).click();
		await expect.poll(hasFade).toBe(true);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await canvas.evaluate((node: HTMLCanvasElement) => {
			node.dataset.cursorAlphas = '[]';
		});
		await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(1200);
		expect(await hasFade()).toBe(false);
		await expect
			.poll(async () => JSON.parse((await canvas.getAttribute('data-cursor-alphas'))!).length)
			.toBeGreaterThan(0);
		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(page.getByRole('checkbox', { name: 'Smooth cursor movement' })).toBeChecked();
		await expect(page.getByRole('checkbox', { name: 'Smooth cursor blink' })).toBeChecked();
		await expect(page.getByRole('checkbox', { name: 'Share system clipboard' })).toBeChecked();
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('line deletion and undo stay still while viewport navigation animates', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-delete-motion-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	await writeFile(
		join(root, 'lines.txt'),
		Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
	);
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await useRowImages(page);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await expect(page.getByRole('treeitem', { name: 'lines.txt', exact: true })).toBeVisible();
		await page.keyboard.type(':edit lines.txt');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /line 10\s/);
		await page.keyboard.press('Escape');
		await canvas.evaluate((surface) => {
			const context = (surface as HTMLCanvasElement).getContext('2d')!;
			const draw = context.drawImage.bind(context);
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				if (args.length === 9) {
					surface.setAttribute(
						'data-motion-frames',
						String(Number(surface.getAttribute('data-motion-frames')) + 1)
					);
				}
				draw(...args);
			}) as typeof draw;
		});
		for (const [navigation, line] of [
			['10G', 10],
			['gg', 1],
			['G', 100]
		] as const) {
			const removed = new RegExp(`line ${line}\\s`);
			await page.keyboard.type(navigation);
			await expect(canvas).toHaveAttribute('aria-description', removed);
			await page.waitForTimeout(150);
			const before = Number(await canvas.getAttribute('data-motion-frames'));
			await page.keyboard.type('dd');
			await expect(canvas).not.toHaveAttribute('aria-description', removed);
			await page.waitForTimeout(150);
			expect(Number(await canvas.getAttribute('data-motion-frames'))).toBe(before);
			await page.keyboard.type('u');
			await expect(canvas).toHaveAttribute('aria-description', removed);
			await page.waitForTimeout(150);
			expect(Number(await canvas.getAttribute('data-motion-frames'))).toBe(before);
		}
		await page.keyboard.type('gg');
		await page.waitForTimeout(150);
		const beforeUndo = Number(await canvas.getAttribute('data-motion-frames'));
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'UI animations', exact: true }).uncheck();
		await page.keyboard.press('Escape');
		await page.keyboard.type('dd');
		await expect(canvas).not.toHaveAttribute('aria-description', /line 1\s/);
		await page.waitForTimeout(150);
		expect(Number(await canvas.getAttribute('data-motion-frames'))).toBe(beforeUndo);
		await page.keyboard.type('u');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'UI animations', exact: true }).check();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+d');
		await expect
			.poll(async () => Number(await canvas.getAttribute('data-motion-frames')))
			.toBeGreaterThan(beforeUndo);
		await page.waitForTimeout(150);
		const frames = Number(await canvas.getAttribute('data-motion-frames'));
		await page.keyboard.type('G');
		await expect
			.poll(async () => Number(await canvas.getAttribute('data-motion-frames')))
			.toBeGreaterThan(frames);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('viewport movement uses pixel wheel deltas and animates keyboard scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-motion-'));
	const content = Array.from(
		{ length: 200 },
		(_, index) => `line ${index + 1} ${'text '.repeat(60)}`
	).join('\n');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		await writeFile(join(root, 'scroll.txt'), content);
		const executablePath = process.env.NIDO_PACKAGED_EXE;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const page = await running.firstWindow();
		await page.addInitScript(installRowImageProbe);
		await page.evaluate(installRowImageProbe);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('treeitem', { name: 'scroll.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('scroll.txt');
		await expect(page.getByRole('button', { name: /scroll.txt/ })).toBeVisible();
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /line 1 /);
		await expect(page.getByLabel('File position 0%', { exact: true })).toBeVisible();
		await page.keyboard.type(':set nowrap');
		await page.keyboard.press('Enter');
		await expect(canvas).toHaveAttribute('aria-description', /line 20/);
		await canvas.evaluate((surface) => {
			const context = (surface as HTMLCanvasElement).getContext('2d')!;
			let row = 0;
			const fill = context.fillRect.bind(context);
			context.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height > 100) row = 0;
				fill(x, y, width, height);
			};
			const draw = context.drawImage.bind(context);
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				if ((args as unknown[]).length === 5 && row++ === 0) {
					surface.setAttribute(
						'data-first-line-y',
						String(
							Number(args[2]) +
								Number((args[0] as HTMLCanvasElement).dataset.rowBaseline) /
									devicePixelRatio
						)
					);
				}
				if (args.length === 9) {
					// Cropping or moving a cached frame must still be a one-to-one pixel copy.
					const physical = [
						...args.slice(1, 5).map(Number),
						...args.slice(5).map((value) => Number(value) * devicePixelRatio)
					];
					if (physical.some((value) => Math.abs(value - Math.round(value)) > 0.001)) {
						surface.setAttribute('data-resampled-animation', 'true');
					}
					surface.setAttribute(
						'data-animation-frames',
						String(Number(surface.getAttribute('data-animation-frames') || 0) + 1)
					);
				}
				draw(...args);
			}) as typeof draw;
		});
		await canvas.hover();
		await page.mouse.wheel(0, 3);
		await expect
			.poll(async () => Number(await canvas.getAttribute('data-first-line-y')))
			.toBeGreaterThan(0);
		await page.waitForTimeout(300);
		const firstY = Number(await canvas.getAttribute('data-first-line-y'));
		const pixel = await page.evaluate(() => 1 / devicePixelRatio);
		const nearBaseline = async (expected: number): Promise<void> => {
			// Final positions snap to physical pixels after the wheel gesture settles.
			await expect
				.poll(async () =>
					Math.abs(Number(await canvas.getAttribute('data-first-line-y')) - expected)
				)
				.toBeLessThanOrEqual(pixel + 0.01);
		};
		await page.mouse.wheel(0, 2);
		await nearBaseline(firstY - 1);
		await page.screenshot({ path: 'test-results/pixel-scroll.png' });
		await page.mouse.wheel(0, -2);
		await nearBaseline(firstY);
		await page.mouse.wheel(0, -100);
		await nearBaseline(firstY + 1.5);
		await page.mouse.wheel(0, 100);
		await expect(canvas).not.toHaveAttribute('aria-description', /^.*line 1 /);
		await page.waitForTimeout(250);
		let frames = await canvas.getAttribute('data-animation-frames');
		await page.waitForTimeout(150);
		expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Smooth cursor movement' }).check();
		await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).uncheck();
		await page.keyboard.press('Escape');
		await page.keyboard.type('80Gzz');
		await page.waitForTimeout(200);
		await expect(page.locator('[aria-label^="File position "]')).toHaveAttribute(
			'aria-label',
			/File position [1-9]\d*%/
		);
		expect(await canvas.getAttribute('aria-description')).not.toContain(
			join(root, 'scroll.txt')
		);
		const center = await canvas.evaluate((node) => {
			const input = document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Neovim input"]'
			)!;
			const rows = node.getAttribute('aria-description')!.split('\n').length;
			const height = Number(localStorage.getItem('nido.lineHeight'));
			const offset =
				node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top;
			return {
				actual: parseFloat(input.style.top) - offset + height / 2,
				expected: ((rows - 2) * height) / 2
			};
		});
		expect(center.actual).toBeCloseTo(center.expected, 1);
		await page.keyboard.type('gg');
		await expect
			.poll(() =>
				page
					.locator('textarea[aria-label="Neovim input"]')
					.evaluate(
						(input) =>
							parseFloat(input.style.top) -
							parseFloat(input.parentElement!.querySelector('canvas')!.style.top)
					)
			)
			.toBe(0);
		await page.keyboard.type('80Gzz');
		await page.waitForTimeout(200);
		await canvas.evaluate((node: HTMLCanvasElement) => {
			const ctx = node.getContext('2d')!;
			const fill = ctx.fillRect.bind(ctx);
			let expected: number | undefined;
			let anchorRow: number | undefined;
			let firstRow = true;
			const draw = ctx.drawImage.bind(ctx);
			ctx.drawImage = ((...args: Parameters<typeof draw>) => {
				if (firstRow && (args as unknown[]).length === 5) {
					const source = args[0] as HTMLCanvasElement;
					const baseline = Number(source.dataset.rowBaseline);
					const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
					const y = Number(args[2]);
					queueMicrotask(() => {
						// Preview scrolling can clip row zero completely; use the row actually painted.
						const row = node
							.getAttribute('aria-description')!
							.split('\n')
							.findIndex(
								(line) => line.replaceAll(' ', '') === source.dataset.rowText
							);
						expected =
							anchorRow === undefined || row < 0
								? undefined
								: (anchorRow - row) *
										Number(localStorage.getItem('nido.lineHeight')) +
									1 +
									y +
									phase;
					});
					firstRow = false;
				}
				draw(...args);
			}) as typeof draw;
			node.dataset.cursorErrors = '[]';
			window.nido.onEvent((event) => {
				if (event.type !== 'redraw') return;
				for (const [name, ...calls] of event.events) {
					if (name !== 'nido_pixel_scroll') continue;
					for (const [, direct, cursor] of calls) {
						const anchor = cursor as { row: number } | undefined;
						anchorRow = direct && anchor ? anchor.row : undefined;
					}
				}
			});
			ctx.fillRect = (x, y, w, h) => {
				if (x === 0 && y === 0 && h > 100) firstRow = true;
				if (ctx.fillStyle === '#f5f5f5') {
					const actual = y + ctx.getTransform().f / window.devicePixelRatio;
					queueMicrotask(() => {
						if (expected === undefined || expected <= 0) return;
						const errors = JSON.parse(node.dataset.cursorErrors!) as number[];
						if (Math.abs(actual - expected) > 1 / devicePixelRatio + 0.01)
							errors.push(actual - expected);
						node.dataset.cursorErrors = JSON.stringify(errors);
						node.dataset.checkedCursor = 'true';
					});
				}
				fill(x, y, w, h);
			};
		});
		await canvas.hover();
		for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 3.1);
		await expect(canvas).toHaveAttribute('data-checked-cursor', 'true');
		await page.waitForTimeout(150);
		expect(await canvas.getAttribute('data-cursor-errors')).toBe('[]');
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Cursor follows scrolling' }).check();
		await page.keyboard.press('Escape');
		frames = await canvas.getAttribute('data-animation-frames');
		for (const key of [
			'Control+d',
			'Control+u',
			'Control+e',
			'Control+y',
			'Control+f',
			'Control+b'
		]) {
			await page.keyboard.press(key);
			await expect
				.poll(async () => Number(await canvas.getAttribute('data-animation-frames')), {
					message: key
				})
				.toBeGreaterThan(Number(frames));
			await page.waitForTimeout(150);
			frames = await canvas.getAttribute('data-animation-frames');
		}
		for (const command of ['G', 'gg', '100G', 'zt', 'zb', 'zz', '/line 150\n', 'zL', 'zH']) {
			if (command.endsWith('\n')) {
				await page.keyboard.type(command.slice(0, -1), { delay: 20 });
				await page.keyboard.press('Enter');
				await expect(canvas).toHaveAttribute('aria-description', /line 150 /);
			} else {
				await page.keyboard.type(command);
			}
			await expect
				.poll(async () => Number(await canvas.getAttribute('data-animation-frames')), {
					message: command
				})
				.toBeGreaterThan(Number(frames));
			await page.waitForTimeout(150);
			frames = await canvas.getAttribute('data-animation-frames');
		}
		expect(await canvas.getAttribute('data-resampled-animation')).toBeNull();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const before = await canvas.getAttribute('aria-description');
		await page.mouse.wheel(0, 100);
		await expect(canvas).not.toHaveAttribute('aria-description', before!);
		expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
		expect(await readFile(join(root, 'scroll.txt'), 'utf8')).toBe(content);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const toggle = page.getByRole('checkbox', { name: 'UI animations' });
		await expect(toggle).toBeChecked();
		await toggle.uncheck();
		await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCSS(
			'animation-name',
			'none'
		);
		await page.keyboard.press('Escape');
		const beforeDisabledScroll = await canvas.getAttribute('aria-description');
		await canvas.hover();
		await page.mouse.wheel(0, 100);
		await expect(canvas).not.toHaveAttribute('aria-description', beforeDisabledScroll!);
		expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
		for (const key of ['Control+d', 'Control+u', 'Control+f', 'Control+b']) {
			const beforeKey = await canvas.getAttribute('aria-description');
			await page.keyboard.press(key);
			await expect(canvas).not.toHaveAttribute('aria-description', beforeKey!);
			expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
		}
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await toggle.check();
		await page.keyboard.press('Escape');
		await canvas.hover();
		await page.mouse.wheel(0, 100);
		await page.waitForTimeout(200);
		expect(await canvas.getAttribute('data-animation-frames')).toBe(frames);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await toggle.uncheck();
		const cursorFollow = page.getByRole('checkbox', { name: 'Cursor follows scrolling' });
		await expect(cursorFollow).toBeChecked();
		await cursorFollow.uncheck();
		await page.keyboard.press('Escape');
		await page.keyboard.type('20G0');
		await expect(page.getByText('Ln 20, Col 1', { exact: true })).toBeVisible();
		const anchoredView = await canvas.getAttribute('aria-description');
		await canvas.hover();
		await page.mouse.wheel(0, 1500);
		await expect(canvas).not.toHaveAttribute('aria-description', anchoredView!);
		await expect(page.getByText('Ln 20, Col 1', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByText('Ln 20, Col 2', { exact: true })).toBeVisible();
		await expect(canvas).toHaveAttribute('aria-description', /line 20 /);
		await running.close();
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const restoredPage = await running.firstWindow();
		await restoredPage.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(
			restoredPage.getByRole('checkbox', { name: 'UI animations' })
		).not.toBeChecked();
		await expect(
			restoredPage.getByRole('checkbox', { name: 'Cursor follows scrolling' })
		).not.toBeChecked();
		expect(errors).toEqual([]);
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('settings navigation crosses the shell selector with Ctrl D and Ctrl U', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-settings-navigation-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const shell = page.getByRole('combobox', { name: 'Shell', exact: true });
		// The setting just above the shell selector. What follows it can change as terminal
		// settings are added, so moving down is checked by leaving and coming back.
		const history = page.getByRole('checkbox', { name: 'Automatic edit history' });
		await expect(shell).toBeEnabled();
		const firstInstalled = await shell.locator('option').nth(1).getAttribute('value');
		await shell.focus();
		await page.keyboard.press('Control+u');
		await expect(history).toBeFocused();
		await page.keyboard.press('Control+d');
		await expect(shell).toBeFocused();
		await page.keyboard.press('Control+d');
		await expect(shell).not.toBeFocused();
		await page.keyboard.press('Control+u');
		await expect(shell).toBeFocused();
		await page.keyboard.press('Control+k');
		await expect(history).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(shell).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(shell).not.toBeFocused();
		await page.keyboard.press('Control+k');
		await expect(shell).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(shell).toBeFocused();
		await expect(shell).toHaveValue(firstInstalled!);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('half-page direction changes animate once per press', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-page-direction-'));
	await writeFile(
		join(root, 'scroll.txt'),
		Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('treeitem', { name: 'scroll.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('scroll.txt');
		await expect(page.getByRole('button', { name: /scroll\.txt/ })).toBeVisible();
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /line 1/);
		await page.keyboard.type('80Gzz');
		await page.waitForTimeout(300);
		await canvas.evaluate((node) => {
			node.dataset.frames = '0';
			node.dataset.scrolls = '[]';
			const context = (node as HTMLCanvasElement).getContext('2d')!;
			const draw = context.drawImage.bind(context);
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				node.dataset.frames = String(Number(node.dataset.frames) + 1);
				draw(...args);
			}) as typeof draw;
			window.nido.onEvent((event) => {
				if (event.type !== 'redraw') return;
				for (const [name, ...calls] of event.events) {
					if (name === 'nido_scroll') {
						node.dataset.scrolls = JSON.stringify([
							...JSON.parse(node.dataset.scrolls!),
							...calls.map((args) => Number(args[5]))
						]);
					}
				}
			});
		});
		for (const key of ['Control+d', 'Control+u', 'Control+d', 'Control+u']) {
			const frames = Number(await canvas.getAttribute('data-frames'));
			await canvas.evaluate((node) => {
				node.dataset.scrolls = '[]';
			});
			await page.keyboard.press(key);
			await expect
				.poll(async () => Number(await canvas.getAttribute('data-frames')))
				.toBeGreaterThan(frames);
			await page.waitForTimeout(200);
			const scrolls = JSON.parse((await canvas.getAttribute('data-scrolls'))!) as number[];
			expect(scrolls).toHaveLength(1);
			expect(Math.sign(scrolls[0])).toBe(key === 'Control+d' ? 1 : -1);
		}
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
