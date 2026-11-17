import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchEnv } from './helpers/launch-env';
import { installRowImageProbe } from './helpers/row-image-probe';

test('after a jump the scroll caches fill while idle, so the next flick does not stall', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-warm-'));
	const profile = join(root, 'profile');
	const file = join(root, 'rows.txt');
	await mkdir(profile);
	await writeFile(
		file,
		Array.from({ length: 4000 }, (_, i) => `ROW_${i + 1} const value = compute(${i});`).join(
			'\n'
		)
	);
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
		await page.addInitScript(installRowImageProbe);
		await page.reload();
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /ROW_1 /);
		// Record where each full paint draws its first row, preview offset included.
		await canvas.evaluate((node: HTMLCanvasElement) => {
			const paints: { at: number; position: string }[] = [];
			Object.assign(window, { paints });
			const context = node.getContext('2d')!;
			const fill = context.fillRect.bind(context);
			const draw = context.drawImage.bind(context);
			let first = true;
			context.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height > 100) first = true;
				fill(x, y, width, height);
			};
			context.drawImage = ((...args: Parameters<typeof draw>) => {
				const row = (args[0] as HTMLCanvasElement).dataset?.rowText?.match(/ROW_\d+/);
				if (first && row && (args as unknown[]).length === 5) {
					first = false;
					paints.push({
						at: performance.now(),
						position: `${row[0]} ${Number(args[2])}`
					});
				}
				draw(...args);
			}) as typeof draw;
		});
		await running.evaluate(({ ipcMain }) => {
			const handlers = (
				ipcMain as unknown as {
					_invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
				}
			)._invokeHandlers;
			const prefetches: boolean[] = [];
			Object.assign(globalThis, { prefetches });
			const prefetch = handlers.get('nido:prefetchScroll')!;
			handlers.set('nido:prefetchScroll', (...args) => {
				prefetches.push(args[2] as boolean);
				return prefetch(...args);
			});
		});
		const prefetches = (): Promise<boolean[]> =>
			running.evaluate(() => (globalThis as unknown as { prefetches: boolean[] }).prefetches);
		const resetPrefetches = (): Promise<void> =>
			running.evaluate(() => {
				(globalThis as unknown as { prefetches: boolean[] }).prefetches.length = 0;
			});
		const box = (await canvas.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await canvas.click();
		// Make each refill strip as slow as a large file on a slow machine, so a wheel
		// gesture that has to wait for one visibly stalls.
		await page.keyboard.type(
			':lua do local m = require("nido_scroll"); local p = m.prefetch; m.prefetch = function(...) local t = vim.uv.hrtime(); while vim.uv.hrtime() - t < 3e8 do end; return p(...) end end'
		);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
		await resetPrefetches();

		// Typing does not refill: the strips would hold up the next keystroke.
		await page.keyboard.type('ityped');
		await page.waitForTimeout(600);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(600);
		expect(await prefetches()).toEqual([]);

		// A far jump empties both caches; they fill without any wheel input.
		await page.keyboard.type('2000Gzt');
		await expect(canvas).toHaveAttribute('aria-description', /ROW_2000 /);
		await expect.poll(prefetches, { timeout: 8000 }).toEqual([true, false]);
		// Eight slow strips refill both sides.
		await page.waitForTimeout(3000);

		const stall = await canvas.evaluate(async (node) => {
			const paints = (window as unknown as { paints: { at: number; position: string }[] })
				.paints;
			paints.length = 0;
			const start = performance.now();
			for (let i = 0; i < 24; i++) {
				node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 60 }));
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			}
			const end = performance.now();
			// The longest time the painted position stood still while wheel input continued.
			let longest = 0;
			let since = start;
			let position = '';
			for (const paint of paints.filter((paint) => paint.at <= end)) {
				if (paint.position !== position) {
					longest = Math.max(longest, paint.at - since);
					position = paint.position;
					since = paint.at;
				}
			}
			return Math.max(longest, end - since);
		});
		// Without warm caches the preview stops after one row until a refill strip returns.
		expect(stall).toBeLessThan(150);
	} finally {
		await running.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.destroy();
		});
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
