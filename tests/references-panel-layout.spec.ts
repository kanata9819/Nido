import { test, expect } from './helpers/renderer-test';
import type { Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

/** The editor's size in CSS pixels, and the Neovim resizes requested so far. */
async function editorLayout(page: Page): Promise<{ height: number; resizes: number }> {
	return page.evaluate(() => {
		const canvas = document.querySelector('canvas[aria-label="Neovim editor display"]')!;
		return {
			height: canvas.parentElement!.getBoundingClientRect().height,
			resizes: window.rendererTest.calls.filter((call) => call.method === 'resize').length
		};
	});
}

test('the references panel covers the editor without resizing it when it opens or jumps', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	// Wait for the first frame, which attaches Neovim at the editor's size.
	await expect
		.poll(() =>
			page.evaluate(() => window.rendererTest.calls.some((call) => call.method === 'attach'))
		)
		.toBe(true);
	const before = await editorLayout(page);
	expect(before.height).toBeGreaterThan(300);

	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: {
				references: {
					version: 1,
					loading: false,
					error: '',
					items: [1, 2, 3].map((line) => ({
						path: '/alpha/main.ts',
						line,
						column: 1,
						text: `reference ${line}`
					}))
				}
			}
		})
	);
	const panel = page.getByRole('region', { name: 'References', exact: true });
	await expect(panel).toBeVisible();
	await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
	// Opening leaves Neovim's rows alone: the panel is drawn over the editor's bottom.
	await page.evaluate(() => new Promise(requestAnimationFrame));
	expect(await editorLayout(page)).toEqual(before);
	const editorBox = (await page.getByLabel('Neovim editor display').boundingBox())!;
	const panelBox = (await panel.boundingBox())!;
	expect(panelBox.y).toBeLessThan(editorBox.y + editorBox.height);
	// The preview stays above the panel instead of reaching under it.
	const preview = page.getByRole('region', { name: 'Reference preview' });
	await expect(preview).toBeVisible();
	const previewBox = (await preview.boundingBox())!;
	expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(panelBox.y);

	// Enter jumps, then closes the panel; Neovim keeps the size it centered the target in.
	await page.keyboard.press('j');
	await page.keyboard.press('Enter');
	await expect(panel).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.evaluate(() => new Promise(requestAnimationFrame));
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'openReference')
				.map((call) => call.args)
		)
	).toEqual([['alpha', 2, 1]]);
	expect(await editorLayout(page)).toEqual(before);
	expect(errors).toEqual([]);
});
