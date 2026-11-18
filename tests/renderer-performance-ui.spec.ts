import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import { viteFsUrl } from './helpers/vite-fs-url';
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

test('large completion lists bound DOM work while preserving distant selection, scrolling and refresh', async ({
	page
}) => {
	await page.goto(`${origin}?view=completion`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await input.focus();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				[
					'popupmenu_show',
					[
						Array.from({ length: 5000 }, (_, i) => [
							`candidate_${i}`,
							'Function',
							`detail_${i}`,
							''
						]),
						0,
						1,
						1
					]
				]
			]
		})
	);
	const list = page.getByRole('listbox', { name: 'Code completion' });
	await expect(list).toHaveAttribute('data-row-count', '5000');
	await expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', '5000');
	await expect.poll(() => list.getByRole('option').count()).toBeLessThan(40);
	const select = async (index: number): Promise<void> => {
		await page.evaluate(
			(index) =>
				window.rendererTest.emit({
					type: 'redraw',
					id: 'alpha',
					events: [['popupmenu_select', [index]]]
				}),
			index
		);
	};
	await select(4999);
	await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-4999');
	await expect(page.locator('#completion-alpha-4999')).toBeInViewport();
	await expect(page.locator('#completion-alpha-4999')).toHaveAttribute('aria-posinset', '5000');
	await select(0);
	await expect(page.locator('#completion-alpha-0')).toBeInViewport();
	await list.evaluate((node) => {
		node.scrollTop = 2500 * 22;
	});
	await expect(page.locator('#completion-alpha-2500')).toBeInViewport();
	await expect(page.locator('#completion-alpha-0')).toHaveCount(1);
	await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-0');
	await expect.poll(() => list.getByRole('option').count()).toBeLessThan(40);
	await page.locator('#completion-alpha-2500').click();
	await expect(input).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls.some(
				(call) =>
					call.method === 'input' &&
					String(call.args[1]).includes('nvim_select_popupmenu_item(2500,')
			)
		)
	).toBe(true);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				[
					'popupmenu_show',
					[
						[
							['日本語', 'Text', '説明', ''],
							['emoji_🙂', 'Variable', '', '']
						],
						-1,
						1,
						1
					]
				]
			]
		})
	);
	await expect(list.getByRole('option')).toHaveCount(2);
	await expect(page.locator('#completion-alpha-0')).toBeInViewport();
	await expect(input).not.toHaveAttribute('aria-activedescendant');
	await select(1);
	await expect(input).toHaveAttribute('aria-activedescendant', 'completion-alpha-1');
	await expect(page.locator('#completion-alpha-1')).toContainText('emoji_🙂');
});

test('editor descriptions stay current through Unicode edits and scrolling without rewriting unchanged text', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem('nido.language', 'en');
		localStorage.setItem('nido.animations', 'false');
	});
	await page.goto(`${origin}?view=app`);
	const canvas = page.locator('canvas:visible');
	await expect(canvas).toHaveAttribute('aria-description', /hello/);
	await page.clock.install();
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				['grid_resize', [1, 8, 4]],
				['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 0])]],
				['flush']
			]
		})
	);
	await page.clock.runFor(32);
	await page.evaluate(() => {
		const counter = { writes: 0 };
		Object.assign(window, { descriptionCounter: counter });
		const setAttribute = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function (name, value) {
			if (this instanceof HTMLCanvasElement && name === 'aria-description') counter.writes++;
			setAttribute.call(this, name, value);
		};
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 1])]], ['flush']]
		});
	});
	await page.clock.runFor(32);
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { descriptionCounter: { writes: number } }).descriptionCounter
					.writes
		)
	).toBe(0);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				['grid_line', [1, 2, 0, [['日', 0], [''], ['e\u0301'], ['🙂'], ['']]]],
				['flush']
			]
		})
	);
	await page.clock.runFor(32);
	await expect(canvas).toHaveAttribute('aria-description', /日e\u0301🙂/);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['grid_scroll', [1, 0, 3, 0, 8, 1, 0]], ['flush']]
		})
	);
	await page.clock.runFor(32);
	expect((await canvas.getAttribute('aria-description'))!.split('\n')[1]).toMatch(/^日e\u0301🙂/);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['grid_clear', [1]], ['flush']]
		})
	);
	await page.clock.runFor(32);
	await expect(canvas).not.toHaveAttribute('aria-description', /hello|日|🙂/);
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { descriptionCounter: { writes: number } }).descriptionCounter
					.writes
		)
	).toBe(3);
});

test('large explorer trees mount only the viewport and preserve keyboard navigation and sibling semantics', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=files`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'files')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('files', 0, [
			{ path: 'src', name: 'src', directory: true },
			...Array.from({ length: 10000 }, (_, i) => ({
				path: `file-${String(i).padStart(5, '0')}.txt`,
				name: `file-${String(i).padStart(5, '0')}.txt`,
				directory: false
			}))
		])
	);
	const tree = page.getByRole('tree', { name: 'Project files' });
	await expect(tree).toHaveAttribute('data-row-count', '10001');
	expect(await tree.getByRole('treeitem').count()).toBeLessThan(70);
	await tree.focus();
	const selected = tree.locator('[aria-selected="true"]');
	await tree.press('End');
	await expect(selected).toHaveText('file-09999.txt');
	await expect(selected).toBeInViewport();
	expect(await tree.getByRole('treeitem').count()).toBeLessThan(70);
	await tree.press('Control+u');
	await expect(selected).not.toHaveText('file-09999.txt');
	await expect(selected).toBeInViewport();
	await tree.press('Home');
	await expect(selected).toHaveText('src');
	await tree.press('ArrowRight');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'files')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('files', 0, [
			{ path: 'src/one.ts', name: 'one.ts', directory: false },
			{ path: 'src/two.ts', name: 'two.ts', directory: false }
		])
	);
	await expect(tree).toHaveAttribute('data-row-count', '10003');
	await tree.press('ArrowDown');
	await expect(selected).toHaveText('one.ts');
	await expect(selected).toHaveAttribute('aria-level', '2');
	await expect(selected).toHaveAttribute('aria-posinset', '1');
	await expect(selected).toHaveAttribute('aria-setsize', '2');
	const descendant = await tree.getAttribute('aria-activedescendant');
	expect(await selected.getAttribute('id')).toBe(descendant);
	await tree.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'openFile')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 'src/one.ts']]);
});

test('opening and closing Git does not duplicate badge status reads, and file changes still refresh', async ({
	page
}) => {
	await page.clock.install();
	await page.goto(`${origin}?view=app&defer=gitStatus`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers: [{ id: 1, name: '/alpha/changed.ts', modified: false }], current: 1 }
		})
	);
	await page.clock.runFor(50);
	await expect(page.getByRole('tab', { name: 'changed.ts' })).toBeVisible();
	await page.clock.runFor(300);
	await page.evaluate(() => {
		while (window.rendererTest.pending.some((call) => call.method === 'gitStatus'))
			window.rendererTest.settle('gitStatus', 0, {
				root: '/alpha',
				branch: 'main',
				changes: []
			});
	});
	const before = await page.evaluate(
		() => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
	);
	await page.keyboard.press('Control+Shift+g');
	await page.clock.runFor(300);
	expect(
		await page.evaluate(
			() => window.rendererTest.pending.filter((call) => call.method === 'gitStatus').length
		)
	).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
	);
	await page.keyboard.press('Escape');
	await page.clock.runFor(300);
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
		)
	).toBe(before + 1);
	await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'gitStatus')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'main',
			changes: [{ path: 'changed.ts', status: 'M', staged: false }]
		})
	);
	await expect(
		page.getByRole('tab', { name: 'changed.ts' }).getByLabel('Git: Modified', { exact: true })
	).toBeVisible();
});

test('cursor-only state updates leave file tabs untouched while real tab changes still render', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=gitStatus`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.evaluate(() => {
		const buffers = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: `/alpha/file-${i}.txt`,
			modified: false
		}));
		const map = buffers.map;
		Object.assign(window, { tabMaps: 0, performanceBuffers: buffers });
		buffers.map = function (this: typeof buffers, ...args: Parameters<typeof map>) {
			(window as unknown as { tabMaps: number }).tabMaps++;
			return map.apply(this, args);
		} as typeof map;
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { buffers, current: 1 }
		});
	});
	const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
	await expect(tabs.getByRole('tab')).toHaveCount(100);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'gitStatus')
			)
		)
		.toBe(true);
	await page.evaluate(() => {
		while (window.rendererTest.pending.some((call) => call.method === 'gitStatus')) {
			window.rendererTest.settle('gitStatus', 0, {
				root: '/alpha',
				branch: 'main',
				changes: [{ path: 'file-0.txt', status: 'M', staged: false }]
			});
		}
	});
	await expect(
		tabs.getByRole('tab').first().getByLabel('Git: Modified', { exact: true })
	).toBeVisible();
	await page.evaluate(() => {
		(window as unknown as { tabMaps: number }).tabMaps = 0;
	});
	for (let i = 0; i < 20; i++) {
		await page.evaluate(async (column) => {
			window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { column } });
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
		}, i + 2);
	}
	const maps = await page.evaluate(() => (window as unknown as { tabMaps: number }).tabMaps);
	console.log(`100 file tabs, 20 cursor-only updates: ${maps} tab list maps`);
	expect(maps).toBe(0);
	await page.evaluate(() => {
		const buffers = (
			window as unknown as {
				performanceBuffers: { id: number; name: string; modified: boolean }[];
			}
		).performanceBuffers;
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: {
				current: 2,
				buffers: buffers.map((buffer, i) =>
					i === 1 ? { ...buffer, modified: true } : buffer
				)
			}
		});
	});
	await expect(tabs.getByRole('tab', { selected: true })).toHaveText('file-1.txt');
	await expect(tabs.getByRole('tab', { selected: true }).getByLabel('Unsaved')).toBeVisible();
	await tabs.getByRole('tab').first().click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'selectBuffer')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 1]]);
});

test('typing reuses the cursor blink timer and gives the cursor a full idle interval', async ({
	page
}) => {
	await page.route('**/cursor-timer-probe', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<main><textarea></textarea></main>' })
	);
	await page.goto(`${origin}cursor-timer-probe`);
	await page.clock.install({ time: new Date(0) });
	await page.clock.pauseAt(new Date(1000));
	await page.evaluate(async (url) => {
		const { EditorCursor } = await import(url);
		const host = document.querySelector('main')!;
		const input = host.querySelector('textarea')!;
		input.focus();
		const probe = { timerStarts: 0, cursorVisible: true, cursorOpacity: 1 };
		const cursor = new EditorCursor(
			probe,
			host,
			input,
			matchMedia('(prefers-reduced-motion: reduce)'),
			false,
			() => {}
		);
		window.setTimeout = new Proxy(window.setTimeout, {
			apply(target, receiver, args) {
				probe.timerStarts++;
				return Reflect.apply(target, receiver, args);
			}
		});
		cursor.listen();
		cursor.resetBlink();
		let keys = 0;
		const typing = window.setInterval(() => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
			if (++keys === 80) {
				window.clearInterval(typing);
			}
		}, 10);
		Object.assign(window, { cursorTimerProbe: probe });
	}, viteFsUrl('src/renderer/src/editor/editorCursor.ts'));
	const state = (): Promise<{ timerStarts: number; cursorVisible: boolean }> =>
		page.evaluate(
			() =>
				(
					window as unknown as {
						cursorTimerProbe: { timerStarts: number; cursorVisible: boolean };
					}
				).cursorTimerProbe
		);
	await page.clock.runFor(800);
	const duringTyping = await state();
	console.log(JSON.stringify({ keys: 80, blinkTimers: duringTyping.timerStarts }));
	expect(duringTyping.cursorVisible).toBe(true);
	await page.clock.runFor(549);
	expect((await state()).cursorVisible).toBe(true);
	await page.clock.runFor(1);
	expect((await state()).cursorVisible).toBe(false);
	await page.locator('textarea').evaluate((input) => input.blur());
	await page.clock.runFor(1100);
	expect((await state()).cursorVisible).toBe(true);
	if (!process.env.NIDO_PERFORMANCE_BASELINE) {
		expect(duringTyping.timerStarts).toBeLessThanOrEqual(3);
	}
});

test('hidden editors keep their state without scheduling paints, and cursor blinking does not rewrite input styles', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta' }
			],
			active: 'alpha',
			errors: []
		})
	);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
	const scheduled = await page.evaluate(() => {
		let frames = 0;
		const request = window.requestAnimationFrame;
		window.requestAnimationFrame = (callback) => {
			frames++;
			return request(callback);
		};
		try {
			for (let i = 0; i < 20; i++)
				window.rendererTest.emit({
					type: 'redraw',
					id: 'beta',
					events: [
						['grid_resize', [1, 40, 6]],
						['grid_line', [1, 1, 0, [['background output', 0]]]],
						['flush']
					]
				});
		} finally {
			window.requestAnimationFrame = request;
		}
		return frames;
	});
	expect(scheduled).toBe(0);
	const writes = await input.evaluate(async (node) => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		let mutations = 0;
		const observer = new MutationObserver((records) => {
			mutations += records.length;
		});
		observer.observe(node, { attributes: true, attributeFilter: ['style'] });
		for (let i = 0; i < 5; i++) {
			window.dispatchEvent(new Event('focus'));
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		observer.disconnect();
		return mutations;
	});
	expect(writes).toBe(0);
	await page.keyboard.press('Alt+2');
	await expect(input).toBeFocused();
	await expect(page.locator('canvas:visible')).toHaveAttribute(
		'aria-description',
		/background output/
	);
});
