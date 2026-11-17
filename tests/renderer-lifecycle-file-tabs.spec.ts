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

const fileTabBuffers = [11, 22, 33].map((id, index) => ({
	id,
	name: `/alpha/${['first', 'second', 'third'][index]}.ts`,
	modified: false
}));

async function showFileTabs(page: Page): Promise<void> {
	await page.goto(`${origin}?view=app&defer=gitStatus`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers, current: 22 }
		});
	}, fileTabBuffers);
	await expect(
		page.getByRole('tablist', { name: 'Files', exact: true }).getByRole('tab')
	).toHaveCount(3);
}

test('saving an overflowing file tab preserves its width and scroll position', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const buffers = Array.from({ length: 8 }, (_, index) => ({
		id: index + 1,
		name: `/alpha/source-file-${index + 1}.rs`,
		modified: index === 7
	}));
	const publish = async (modified: boolean): Promise<void> => {
		await page.evaluate(
			(buffers) =>
				window.rendererTest.emit({
					type: 'state',
					id: 'alpha',
					state: { buffers, current: 8, mode: 'n', line: 1, column: 1, filetype: 'rust' }
				}),
			buffers.map((buffer) => ({ ...buffer, modified: buffer.id === 8 && modified }))
		);
	};
	const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
	const selected = tabs.getByRole('tab', { name: 'source-file-8.rs', exact: false });
	await publish(true);
	await expect(selected).toHaveAttribute('aria-selected', 'true');
	await expect(selected.getByLabel('Unsaved')).toBeVisible();
	const layout = (): Promise<unknown> =>
		tabs.evaluate((list) => ({
			scrollLeft: list.scrollLeft,
			tabs: Array.from(list.children, (tab) => {
				const { x, width } = tab.getBoundingClientRect();
				return { x, width };
			})
		}));
	const before = await layout();
	await publish(false);
	await expect(selected.getByLabel('Unsaved')).not.toBeVisible();
	expect(await layout()).toEqual(before);
});

test('file palette reorders the highlighted buffer and follows its published position', async ({
	page
}) => {
	await showFileTabs(page);
	await page.keyboard.press('Space');
	await page.keyboard.press('b');
	const palette = page.getByRole('dialog', { name: 'buffers palette' });
	const list = palette.getByRole('group', { name: 'Palette results' });
	const selected = list.locator('button[class*="selectedItem"]');
	const bufferCalls = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => ['moveBuffer', 'selectBuffer'].includes(call.method))
				.map((call) => [call.method, ...call.args])
		);
	await expect(list).toBeFocused();
	await expect(selected).toContainText('first.ts');
	await page.keyboard.press('Shift+J');
	await expect.poll(bufferCalls).toEqual([['moveBuffer', 'alpha', 11, 22]]);
	await page.keyboard.press('Shift+J');
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [buffers[1], buffers[0], buffers[2]] }
		});
	}, fileTabBuffers);
	await expect(list.getByRole('button')).toHaveText([/second\.ts/, /first\.ts/, /third\.ts/]);
	await expect(selected).toContainText('first.ts');
	await expect(list).toBeFocused();
	await expect(
		page
			.getByRole('tablist', { name: 'Files', exact: true })
			.getByRole('tab', { selected: true })
	).toHaveText('second.ts');
	await page.keyboard.press('Shift+K');
	await expect.poll(bufferCalls).toEqual([
		['moveBuffer', 'alpha', 11, 22],
		['moveBuffer', 'alpha', 11, 22]
	]);
});

test('file tabs drag to another position and buffer navigation follows the published order', async ({
	page
}) => {
	await showFileTabs(page);
	const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
	await tabs
		.getByRole('tab', { name: 'first.ts', exact: true })
		.dragTo(tabs.getByRole('tab', { name: 'third.ts', exact: true }));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'moveBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 11, 33]]);
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [buffers[1], buffers[2], buffers[0]] }
		});
	}, fileTabBuffers);
	await expect(tabs.getByRole('tab')).toHaveText(['second.ts', 'third.ts', 'first.ts']);
	await expect(tabs.getByRole('tab', { selected: true })).toHaveText('second.ts');
	await page.getByRole('textbox', { name: 'Neovim input' }).focus();
	await page.keyboard.press('Shift+L');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'selectBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 33]]);
	await tabs
		.getByRole('tab', { name: 'first.ts', exact: true })
		.dragTo(tabs.getByRole('tab', { name: 'second.ts', exact: true }));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'moveBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([
			['alpha', 11, 33],
			['alpha', 11, 22]
		]);
	await page.evaluate((buffers) => {
		window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { buffers } });
	}, fileTabBuffers);
	await expect(tabs.getByRole('tab')).toHaveText(['first.ts', 'second.ts', 'third.ts']);
});

test('file tab keyboard moves respect the ends and are also available from the command palette', async ({
	page
}) => {
	await showFileTabs(page);
	await page.keyboard.press('Control+Shift+PageUp');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'moveBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 22, 11]]);
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [buffers[1], buffers[0], buffers[2]] }
		});
	}, fileTabBuffers);
	const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
	await expect(tabs.getByRole('tab')).toHaveText(['second.ts', 'first.ts', 'third.ts']);
	await page.keyboard.press('Control+Shift+PageUp');
	await page.keyboard.press('Control+Shift+PageDown');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'moveBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([
			['alpha', 22, 11],
			['alpha', 22, 11]
		]);
	await page.keyboard.press('Control+Shift+p');
	const palette = page.getByRole('dialog', { name: 'commands palette' });
	await palette.getByRole('textbox', { name: 'Filter items' }).fill('Move file tab right');
	await palette.getByRole('button', { name: /Move file tab right/ }).click();
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'moveBuffer').length
			)
		)
		.toBe(3);
});

test('closed file shortcuts work in Insert mode, and the palette can reopen another closed file', async ({
	page
}) => {
	await showFileTabs(page);
	const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
	await page.getByRole('button', { name: 'Close file second.ts', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'closeBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 22]]);
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [buffers[0], buffers[2]], current: 11 }
		});
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['mode_change', ['insert', 1]]]
		});
	}, fileTabBuffers);
	await expect(tabs.getByRole('tab')).toHaveCount(2);
	await page.getByRole('textbox', { name: 'Neovim input' }).focus();
	await page.keyboard.press('Control+Shift+t');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'reopenBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha']]);
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers, current: 22 }
		});
	}, fileTabBuffers);
	await expect(tabs.getByRole('tab', { selected: true })).toHaveText('second.ts');
	await page.getByRole('button', { name: 'Close file first.ts', exact: true }).click();
	await page.evaluate((buffers) => {
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [buffers[1], buffers[2]] }
		});
	}, fileTabBuffers);
	await expect(tabs.getByRole('tab')).toHaveCount(2);
	await page.keyboard.press('Control+Shift+p');
	const palette = page.getByRole('dialog', { name: 'commands palette' });
	await palette.getByRole('textbox', { name: 'Filter items' }).fill('Reopen closed file');
	await page.keyboard.press('Control+Shift+t');
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'reopenBuffer').length
		)
	).toBe(1);
	await expect(palette).toBeVisible();
	await palette.getByRole('button', { name: /Reopen closed file/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'reopenBuffer')
						.length
			)
		)
		.toBe(2);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'input').length
		)
	).toBe(0);
});

test('file tab shortcuts leave a terminal session focused', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'restoreWorkspaces')
			)
		)
		.toBe(true);
	await page.evaluate(() => {
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [{ id: 'shell', root: '/alpha', name: 'Shell', kind: 'terminal' }],
			active: 'shell',
			errors: []
		});
	});
	const terminal = page.getByRole('textbox', { name: 'Terminal input' });
	await expect(terminal).toBeFocused();
	for (const key of ['Control+Shift+t', 'Control+Shift+PageUp', 'Control+Shift+PageDown']) {
		await page.keyboard.press(key);
	}
	await expect(terminal).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls.filter((call) =>
				['moveBuffer', 'reopenBuffer'].includes(call.method)
			)
		)
	).toEqual([]);
});

test("the status bar names the current file's real encoding, with a byte order mark", async ({
	page
}) => {
	await showFileTabs(page);
	const encoding = page.locator('footer').getByTitle('File encoding');
	// Before Neovim reports one, and for UTF-8, the label is UTF-8.
	await expect(encoding).toHaveText('UTF-8');
	for (const [reported, label] of [
		['latin1', 'Latin-1'],
		['utf-8+bom', 'UTF-8 BOM'],
		['cp932', 'Shift_JIS'],
		['euc-kr', 'EUC-KR'],
		['utf-8', 'UTF-8']
	]) {
		await page.evaluate(
			(fileEncoding) =>
				window.rendererTest.emit({
					type: 'statePatch',
					id: 'alpha',
					state: { fileEncoding }
				}),
			reported
		);
		await expect(encoding).toHaveText(label);
	}
});
