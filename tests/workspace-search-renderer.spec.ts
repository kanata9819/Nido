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
test.afterAll(async () => server?.close());

async function open(page: Page, language = 'en', deferOpenFile = false): Promise<void> {
	await page.addInitScript((language) => {
		localStorage.setItem('nido.language', language);
		localStorage.setItem('nido.animations', 'false');
	}, language);
	await page.goto(
		`${origin}?view=app&defer=searchText,previewReplacement,applyReplacement${deferOpenFile ? ',openFile' : ''}`
	);
	await expect(
		page.getByRole('textbox', {
			name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
			exact: true
		})
	).toBeFocused();
	await page.keyboard.press('Control+Shift+f');
}
async function matches(page: Page, query?: string): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				(query) =>
					window.rendererTest?.pending.some(
						(call) =>
							call.method === 'searchText' &&
							(query === undefined || call.args[1] === query)
					),
				query
			)
		)
		.toBe(true);
	await page.evaluate(() => {
		// Settle the latest request; older requests must not replace it.
		const pending = window.rendererTest.pending.filter((call) => call.method === 'searchText');
		for (let index = 0; index < pending.length; index++)
			window.rendererTest.settle('searchText', 0, {
				token: 'search-1',
				truncated: false,
				matches: [
					{ path: 'src/first.txt', line: 1, column: 1, text: 'joke first' },
					{ path: 'src/second.txt', line: 2, column: 1, text: 'joke second' }
				]
			});
	});
}

test('large search results mount a viewport and keep distant matches reachable', async ({
	page
}) => {
	await open(page, 'en', true);
	await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('large');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some(
					(call) => call.method === 'searchText' && call.args[1] === 'large'
				)
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('searchText', 0, {
			truncated: true,
			matches: Array.from({ length: 200 }, (_, index) => ({
				path: 'src/large.txt',
				line: index + 1,
				column: 1,
				text: `large match ${index + 1}`
			}))
		})
	);
	const list = page.getByRole('listbox', { name: 'Search results', exact: true });
	const first = list.locator('#search-result-0');
	const last = list.locator('#search-result-199');
	await expect(first).toBeInViewport();
	expect(await list.getByRole('option').count()).toBeLessThan(40);
	const scroll = await list.evaluate(async (node) => {
		const nextFrame = (): Promise<void> =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
		const rowHeight = node.querySelector('[role="option"]')!.getBoundingClientRect().height;
		node.scrollTop = rowHeight * 10 + 1;
		// Find two pixel offsets with the same intersecting rows at either edge.
		if ((node.scrollTop + node.clientHeight) % rowHeight === 0) node.scrollTop++;
		await nextFrame();
		const from = Array.from;
		let listsBuilt = 0;
		let scrollEvents = 0;
		const onScroll = (): void => {
			scrollEvents++;
		};
		node.addEventListener('scroll', onScroll);
		Array.from = new Proxy(from, {
			apply(target, receiver, args) {
				if (new Error().stack?.includes('virtualRows')) listsBuilt++;
				return Reflect.apply(target, receiver, args);
			}
		});
		try {
			node.scrollTop++;
			await nextFrame();
			const sameRows = listsBuilt;
			const sameRowsScrolls = scrollEvents;
			node.scrollTop += rowHeight;
			await nextFrame();
			return { sameRows, sameRowsScrolls, crossedRow: listsBuilt > sameRows };
		} finally {
			Array.from = from;
			node.removeEventListener('scroll', onScroll);
		}
	});
	expect(scroll).toEqual({ sameRows: 0, sameRowsScrolls: 1, crossedRow: true });
	await list.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
	await expect(last).toBeInViewport();
	await expect(first).toHaveAttribute('aria-selected', 'true');
	await list.press('Home');
	await list.press('End');
	await expect(list).toHaveAttribute('aria-activedescendant', 'search-result-199');
	await expect(last).toHaveAttribute('aria-posinset', '200');
	await expect(last).toHaveAttribute('aria-setsize', '200');
	await expect(last).toBeInViewport();
	await list.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() => window.rendererTest.pending.find((call) => call.method === 'openFile')?.args
			)
		)
		.toEqual(['alpha', 'src/large.txt', 200, 1]);
});

test('selecting another replacement file starts its preview at the top left', async ({ page }) => {
	await open(page);
	await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('joke');
	await matches(page, 'joke');
	await page.getByRole('button', { name: 'Replace', exact: true }).click();
	await page.getByRole('button', { name: 'Preview replacement' }).click();
	await page.evaluate(() => {
		const files = ['first', 'second'].map((name) => {
			const lines = Array.from(
				{ length: 120 },
				(_, index) => `${name} line ${index + 1} ${'long text '.repeat(24)}`
			).join('\n');
			return { path: `src/${name}.txt`, count: 1, before: lines, after: lines };
		});
		window.rendererTest.settle('previewReplacement', 0, { token: 'preview', count: 2, files });
	});
	const diff = page.getByRole('region', { name: 'Replacement diff' });
	const files = page.getByRole('listbox', { name: 'Replacement files' });
	const scroll = (): Promise<number[]> =>
		diff.evaluate((node) => [node.scrollTop, node.scrollLeft]);
	await expect(diff.getByLabel('Before replacement')).toContainText('first line 1');
	await diff.evaluate((node) => node.scrollTo({ top: 600, left: 300, behavior: 'instant' }));
	await expect.poll(scroll).toEqual([600, 300]);

	await files.press('j');
	await expect(diff.getByLabel('Before replacement')).toContainText('second line 1');
	await expect(files).toBeFocused();
	await expect.poll(scroll).toEqual([0, 0]);
});

test('double-clicking a result opens it once in both search modes', async ({ page }) => {
	await open(page, 'en', true);
	await page.keyboard.press('i');
	await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('joke');
	await matches(page, 'joke');
	const row = page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first();
	const opens = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'openFile')
				.map((call) => call.args)
		);
	await row.dblclick();
	await expect.poll(opens).toEqual([['alpha', 'src/first.txt', 1, 1]]);

	// Run the same gesture in replace mode, where a single click just selects the row.
	await page.getByRole('button', { name: 'Replace', exact: true }).click();
	await row.click();
	expect(await opens()).toHaveLength(1);
	await row.dblclick();
	await expect.poll(opens).toEqual([
		['alpha', 'src/first.txt', 1, 1],
		['alpha', 'src/first.txt', 1, 1]
	]);
});

test('search and replacement complete using Vim keys without arrows or mouse', async ({ page }) => {
	await open(page);
	const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
	const results = page.getByRole('listbox', { name: 'Search results', exact: true });
	// The search opens on its results, as in Vim's Normal mode; i starts typing.
	await expect(results).toBeFocused();
	await page.keyboard.press('i');
	await expect(query).toBeFocused();
	await page.keyboard.type('joke');
	await expect(query).toHaveValue('joke');
	await page.waitForTimeout(180);
	await matches(page);
	await expect(results.getByRole('option')).toHaveCount(2);
	await page.keyboard.press('Escape');
	await expect(results).toBeFocused();
	await page.keyboard.press('j');
	await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('k');
	await page.keyboard.press('/');
	await expect(query).toBeFocused();
	// Ctrl+C leaves the field like Escape, keeping the query.
	await page.keyboard.press('Control+c');
	await expect(results).toBeFocused();
	await expect(query).toHaveValue('joke');
	await page.keyboard.press('a');
	await expect(query).toBeFocused();
	await page.keyboard.press('Escape');
	await page.keyboard.press('r');
	const replacement = page.getByRole('textbox', { name: 'Replace with', exact: true });
	await expect(replacement).toBeFocused();
	await page.keyboard.type('j$1k');
	await expect(replacement).toHaveValue('j$1k');
	await page.keyboard.press('Enter');
	await expect(results).toBeFocused();
	await page.keyboard.press('Space');
	await expect(
		results.getByRole('option').first().getByLabel('Excluded', { exact: true })
	).toBeVisible();
	await page.keyboard.press('j');
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'previewReplacement')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 'search-1', 'j$1k', [1]]]);
	await page.evaluate(() =>
		window.rendererTest.settle('previewReplacement', 0, {
			token: 'preview-1',
			count: 1,
			files: [
				{
					path: 'src/second.txt',
					count: 1,
					before: '1  joke first\n2  joke second',
					after: '1  joke first\n2  j$1k second'
				}
			]
		})
	);
	const files = page.getByRole('listbox', { name: 'Replacement files', exact: true });
	const diff = page.getByRole('region', { name: 'Replacement diff', exact: true });
	await expect(files).toBeFocused();
	const panel = page.getByRole('dialog', { name: 'search palette', exact: true });
	const footer = panel.getByText(
		'Saved UTF-8 files up to 1 MiB · Git ignores respected · Replacements stay unsaved',
		{ exact: true }
	);
	const footerBounds = await footer.boundingBox();
	const panelBounds = await panel.boundingBox();
	expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(
		panelBounds!.y + panelBounds!.height
	);
	await page.screenshot({ path: test.info().outputPath('replacement-preview.png') });
	await page.keyboard.press('Enter');
	await expect(diff).toBeFocused();
	await expect(diff.getByLabel('After replacement', { exact: true })).toContainText(
		'j$1k second'
	);
	await page.keyboard.press('j');
	await page.keyboard.press('h');
	await expect(files).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls.filter((call) => call.method === 'applyReplacement')
		)
	).toHaveLength(0);
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('button', { name: /Apply replacement/ })).toBeFocused();
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'applyReplacement')
						.length
			)
		)
		.toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('applyReplacement', 0, { count: 1, files: 1 })
	);
	await expect(results).toBeFocused();
	await expect(
		page.getByRole('dialog', { name: 'search palette' }).getByRole('status')
	).toContainText('Unsaved edits');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('search options, folder and focus trap are keyboard accessible, and stale responses stay hidden', async ({
	page
}) => {
	await open(page);
	const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
	await page.keyboard.press('i');
	await page.keyboard.type('joke');
	await page.keyboard.press('Alt+c');
	await page.keyboard.press('Alt+r');
	await page.keyboard.press('Alt+w');
	await expect(page.getByRole('button', { name: /Match case/ })).toHaveAttribute(
		'aria-pressed',
		'false'
	);
	await page.keyboard.press('Escape');
	await page.keyboard.press('f');
	const folder = page.getByRole('textbox', { name: 'Search folder', exact: true });
	await expect(folder).toBeFocused();
	await page.keyboard.type('src');
	await page.waitForTimeout(180);
	const last = await page.evaluate(
		() => window.rendererTest.calls.filter((call) => call.method === 'searchText').at(-1)?.args
	);
	expect(last).toEqual([
		'alpha',
		'joke',
		{ caseSensitive: false, regex: true, wholeWord: true, folder: 'src' }
	]);
	for (let index = 0; index < 18; index++) {
		await page.keyboard.press(index < 9 ? 'Tab' : 'Shift+Tab');
		expect(
			await page.evaluate(() => !!document.activeElement?.closest('[data-panel="search"]'))
		).toBe(true);
	}
	await page.keyboard.press('Escape');
	await page.keyboard.press('/');
	await expect(query).toBeFocused();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await matches(page);
	await expect(page.getByRole('dialog', { name: 'search palette' })).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('Japanese search shows translated controls and regex errors within a small viewport', async ({
	page
}) => {
	await page.setViewportSize({ width: 960, height: 720 });
	await open(page, 'ja');
	await page.keyboard.press('i');
	await page.keyboard.type('[');
	await page.keyboard.press('Alt+r');
	await page.waitForTimeout(180);
	await page.evaluate(() => {
		const count = window.rendererTest.pending.filter(
			(call) => call.method === 'searchText'
		).length;
		for (let index = 0; index < count; index++)
			window.rendererTest.settle(
				'searchText',
				0,
				new Error('Invalid regular expression.').message,
				true
			);
	});
	await expect(page.getByRole('alert')).toHaveText('正規表現が正しくありません。');
	await expect(page.getByRole('button', { name: /正規表現/ })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	const dialog = page.getByRole('dialog', { name: 'ファイル内を検索', exact: true });
	const bounds = await dialog.boundingBox();
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(960);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
	await page.screenshot({ path: test.info().outputPath('search-japanese.png') });
});

test('reopening the search continues it: the query, and j goes on from the result opened', async ({
	page
}) => {
	await open(page);
	const query = page.getByRole('textbox', { name: 'Search in files', exact: true });
	const results = page.getByRole('listbox', { name: 'Search results', exact: true });
	await page.keyboard.press('i');
	await page.keyboard.type('joke');
	await page.waitForTimeout(180);
	await matches(page);
	await page.keyboard.press('Escape');
	await page.keyboard.press('j');
	await page.keyboard.press('Enter');
	await expect(results).toHaveCount(0);
	const opened = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'openFile')
				.map((call) => call.args.slice(1))
		);
	await expect.poll(opened).toEqual([['src/second.txt', 2, 1]]);

	// The search reopens with its query and searches again, on the result opened last.
	await page.keyboard.press('Control+Shift+f');
	await expect(query).toHaveValue('joke');
	await matches(page);
	await expect(results).toBeFocused();
	await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('k');
	await page.keyboard.press('Enter');
	await expect.poll(opened).toEqual([
		['src/second.txt', 2, 1],
		['src/first.txt', 1, 1]
	]);
});

test('Space s opens Search in files, and the Space menu lists it', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(editor).toBeFocused();
	await page.keyboard.press('Space');
	await expect(page.getByRole('button', { name: /^s\s*Search in files$/ })).toBeVisible();
	await page.keyboard.press('s');
	const search = page.getByRole('dialog', { name: 'search palette', exact: true });
	await expect(search).toBeVisible();
	// Space s no longer saves; Ctrl+S and :w do.
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'save').length
		)
	).toBe(0);
});
