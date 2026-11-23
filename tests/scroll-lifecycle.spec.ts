import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRowImageProbe, useRowImages } from './helpers/row-image-probe';
import { launchEnv } from './helpers/launch-env';

test('wheel scrolling resumes after a pending Neovim command and across file tabs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-pending-key-'));
	const profile = join(root, 'profile');
	const file = join(root, 'rows.txt');
	await mkdir(profile);
	await writeFile(file, Array.from({ length: 300 }, (_, i) => `ROW_${i + 1}`).join('\n'));
	await writeFile(
		join(root, 'other.txt'),
		Array.from({ length: 300 }, (_, i) => `OTHER_${i + 1}`).join('\n')
	);
	await writeFile(
		join(profile, 'workspaces.json'),
		JSON.stringify({
			version: 1,
			active: 0,
			workspaces: [{ root, current: file, files: [{ path: file, line: 100, column: 0 }] }]
		})
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const display = page.locator('canvas:visible');
		await expect(display).toHaveAttribute('aria-description', /ROW_100\b/);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		const id = await page.evaluate(
			async () => (await window.nido.restoreWorkspaces()).workspaces[0].id
		);
		const mode = (): Promise<string> => page.evaluate((id) => window.nido.inputMode(id), id);
		const wheel = (): Promise<void> =>
			display.evaluate((node) => {
				node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 2 }));
			});
		const top = async (): Promise<number> =>
			Number(
				(await display.getAttribute('aria-description'))?.match(/(?:ROW|OTHER)_(\d+)/)?.[1]
			);
		await running.evaluate(({ ipcMain }) => {
			const handlers = (
				ipcMain as unknown as {
					_invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
				}
			)._invokeHandlers;
			const scroll = handlers.get('nido:scroll')!;
			const probe = {
				replies: 0,
				holdNext: false,
				release: undefined as (() => void) | undefined
			};
			Object.assign(globalThis, { wheelProbe: probe });
			handlers.set('nido:scroll', async (...args) => {
				const hold = probe.holdNext;
				probe.holdNext = false;
				try {
					const result = await scroll(...args);
					if (hold) {
						await new Promise<void>((resolve) => {
							probe.release = resolve;
						});
						probe.release = undefined;
					}
					return result;
				} finally {
					probe.replies++;
				}
			});
		});
		const replies = (): Promise<number> =>
			running.evaluate(() => Number(Reflect.get(globalThis, 'wheelProbe').replies));
		for (const [key, next] of [
			['f', 'Escape'],
			['g', 'g']
		]) {
			await test.step(`the next gesture scrolls after ${key} then ${next}`, async () => {
				const beforeRequest = await replies();
				await page.keyboard.press(key);
				await expect.poll(mode).toBe('pending');
				await wheel();
				await expect.poll(replies).toBeGreaterThan(beforeRequest);
				await page.keyboard.press(next);
				await expect.poll(mode).toBe('n');
				if (key === 'g') {
					await expect.poll(top).toBe(1);
				}
				const before = await top();
				await display.hover();
				await page.mouse.wheel(0, 240);
				await expect.poll(top).toBeGreaterThan(before);
			});
		}
		await test.step('a delayed reply from the old file does not block the first gesture in another tab', async () => {
			await page.evaluate((id) => window.nido.openFile(id, 'other.txt'), id);
			await expect(display).toHaveAttribute('aria-description', /OTHER_1\b/);
			await page.mouse.wheel(0, 240);
			await expect.poll(top).toBeGreaterThan(1);
			await running.evaluate(() => {
				Reflect.get(globalThis, 'wheelProbe').holdNext = true;
			});
			await page.mouse.wheel(0, 240);
			await expect
				.poll(() =>
					running.evaluate(() => Boolean(Reflect.get(globalThis, 'wheelProbe').release))
				)
				.toBe(true);
			await page.getByRole('tab', { name: 'rows.txt', exact: true }).click();
			await expect(display).toHaveAttribute('aria-description', /ROW_\d+/);
			const before = await top();
			await display.hover();
			await page.mouse.wheel(0, -240);
			await expect.poll(top).toBeLessThan(before);
			await running.evaluate(() => Reflect.get(globalThis, 'wheelProbe').release());
			await page.getByRole('tab', { name: 'other.txt', exact: true }).click();
			await expect(display).toHaveAttribute('aria-description', /OTHER_\d+/);
			const restored = await top();
			await display.hover();
			await page.mouse.wheel(0, 240);
			await expect.poll(top).toBeGreaterThan(restored);
		});
	} finally {
		await running.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.destroy();
		});
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('an old scroll failure cannot reset the preview after changing editor settings', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-lifecycle-'));
	const profile = join(root, 'profile');
	const file = join(root, 'rows.txt');
	await mkdir(profile);
	await writeFile(file, Array.from({ length: 300 }, (_, i) => `ROW_${i + 1}`).join('\n'));
	await writeFile(
		join(profile, 'workspaces.json'),
		JSON.stringify({
			version: 1,
			active: 0,
			window: { width: 1100, height: 850, maximized: false },
			workspaces: [{ root, current: file, files: [{ path: file, line: 1, column: 0 }] }]
		})
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await useRowImages(page);
		await page.addInitScript(installRowImageProbe);
		// The IPC gates below hold individual requests, so use one request per gesture.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.reload();
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /ROW_1/);
		await running.evaluate(({ ipcMain }) => {
			const handlers = (
				ipcMain as unknown as {
					_invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
				}
			)._invokeHandlers;
			const original = handlers.get('nido:scroll')!;
			const probe = { calls: 0, completed: 0, failOld: () => {}, releaseCurrent: () => {} };
			Object.assign(globalThis, { scrollLifecycle: probe });
			handlers.set('nido:scroll', async (...args) => {
				probe.calls++;
				try {
					if (probe.calls === 1) {
						await new Promise<void>((_, reject) => {
							probe.failOld = () => reject(new Error('Old scroll failed'));
						});
					} else if (probe.calls === 2) {
						await new Promise<void>((resolve) => {
							probe.releaseCurrent = resolve;
						});
					}
					return await original(...args);
				} finally {
					probe.completed++;
				}
			});
		});
		await canvas.evaluate((node: HTMLCanvasElement) => {
			const context = node.getContext('2d')!;
			const fill = context.fillRect.bind(context);
			const draw = context.drawImage.bind(context);
			let first = true;
			context.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height > 100) first = true;
				fill(x, y, width, height);
			};
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				if (first && (args as unknown[]).length === 5) {
					const baseline = Number(
						(args[0] as HTMLCanvasElement).dataset.rowBaseline ?? 0
					);
					const phase = (baseline - Math.floor(baseline)) / devicePixelRatio;
					node.dataset.firstY = String(Number(args[2]) + phase);
					first = false;
				}
				draw(...args);
			}) as typeof draw;
			node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 3 }));
		});
		const calls = (): Promise<number> =>
			running.evaluate(
				() =>
					(globalThis as unknown as { scrollLifecycle: { calls: number } })
						.scrollLifecycle.calls
			);
		await expect.poll(calls).toBe(1);

		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('spinbutton', { name: 'Editor font size' }).fill('16');
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.fontSize')))
			.toBe('16');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
		await expect(
			page.getByRole('textbox', { name: 'Neovim input', exact: true })
		).toBeFocused();
		await expect
			.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.getContext('2d')!.font))
			.toMatch(/^(?:\d+ )?16px /);
		// Let the setting's resize redraw settle before starting the next gesture.
		await canvas.evaluate(async () => {
			for (let frame = 0; frame < 2; frame++) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			}
		});
		await canvas.evaluate((node) =>
			node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 8 }))
		);
		await expect.poll(calls).toBe(2);
		const expectedY = -4;
		await expect
			.poll(async () => Number(await canvas.getAttribute('data-first-y')))
			.toBe(expectedY);

		await running.evaluate(() => {
			(
				globalThis as unknown as {
					scrollLifecycle: { failOld: () => void };
				}
			).scrollLifecycle.failOld();
		});
		// Paint repeatedly while the old rejection arrives, keeping the new request paused.
		const positions = await canvas.evaluate(async (node: HTMLCanvasElement) => {
			const positions: number[] = [];
			for (let i = 0; i < 30; i++) {
				window.dispatchEvent(new Event('focus'));
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				positions.push(Number(node.dataset.firstY));
			}
			return positions;
		});
		expect(
			positions.every((y) => y === expectedY),
			JSON.stringify(positions)
		).toBe(true);
		await running.evaluate(() => {
			(
				globalThis as unknown as {
					scrollLifecycle: { releaseCurrent: () => void };
				}
			).scrollLifecycle.releaseCurrent();
		});
		const completed = (): Promise<number> =>
			running.evaluate(
				() =>
					(globalThis as unknown as { scrollLifecycle: { completed: number } })
						.scrollLifecycle.completed
			);
		await expect.poll(completed).toBe(2);
		await canvas.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(canvas).toHaveAttribute('data-first-y', String(expectedY));
		await canvas.evaluate((node) =>
			node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 2 }))
		);
		await expect.poll(completed).toBe(3);
		const finalY = -5;
		await expect(canvas).toHaveAttribute('data-first-y', String(finalY));
		await expect(page.getByText('Old scroll failed', { exact: false })).toHaveCount(0);
	} finally {
		await running.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.destroy();
		});
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
