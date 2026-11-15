import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './renderer/harness';
import { pauseRendererClock } from './helpers/renderer-lifecycle-shared';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

test('slow startup shows loading through restoration until the first completed editor paint', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,attach`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	// A slow test runner must not advance the renderer's controlled startup clock.
	await delay(300);
	const loading = page.getByRole('status', { name: 'Loading workspaces…' });
	await page.clock.runFor(100);
	await expect(loading).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toHaveCount(0);
	await page.clock.runFor(150);
	await expect(loading).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [{ id: 'alpha', root: '/alpha', name: 'Alpha' }],
			active: 'alpha',
			errors: []
		})
	);
	await page.clock.runFor(50);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'attach')
			)
		)
		.toBe(true);
	await expect(loading).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				['grid_resize', [1, 40, 10]],
				['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 0])]]
			]
		})
	);
	await page.clock.runFor(50);
	await expect(loading).toBeVisible();
	await page.screenshot({ path: 'test-results/workspace-loading.png' });
	await page.evaluate(() => {
		window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['flush']] });
		window.rendererTest.settle('attach', 0, undefined);
	});
	await page.clock.runFor(50);
	await expect(loading).toHaveCount(0);
	await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
});

test('fast startup never flashes a loading indicator', async ({ page }) => {
	await pauseRendererClock(page);
	await page.addInitScript(() => {
		Object.assign(window, { loadingScreens: 0 });
		new MutationObserver((records) => {
			const selector = '[role="status"][aria-label="Loading workspaces…"]';
			for (const record of records)
				for (const node of record.addedNodes) {
					if (
						node instanceof Element &&
						(node.matches(selector) || node.querySelector(selector))
					) {
						(window as unknown as { loadingScreens: number }).loadingScreens++;
					}
				}
		}).observe(document, { childList: true, subtree: true });
	});
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.clock.runFor(100);
	await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /hello/);
	await page.clock.runFor(500);
	expect(
		await page.evaluate(() => (window as unknown as { loadingScreens: number }).loadingScreens)
	).toBe(0);
});

test('failed restoration dismisses Japanese loading and returns to the welcome screen', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.clock.runFor(250);
	const loading = page.getByRole('status', { name: 'ワークスペースを読み込み中…' });
	await expect(loading).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, 'Restore failed', true)
	);
	await page.clock.runFor(50);
	await expect(loading).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'ここから、あなたのコードを。' })).toBeVisible();
	await expect(page.getByText('Restore failed', { exact: true })).toBeVisible();
});

test('failed editor attachment dismisses loading and displays the error', async ({ page }) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app&defer=attach`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.clock.runFor(250);
	const loading = page.getByRole('status', { name: 'Loading workspaces…' });
	await expect(loading).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.settle('attach', 0, 'Editor startup failed', true)
	);
	await page.clock.runFor(50);
	await expect(loading).toHaveCount(0);
	await expect(page.getByText('Editor startup failed', { exact: true })).toBeVisible();
});

for (const reject of [false, true]) {
	test(`editor resize keeps only the latest dimensions behind a ${reject ? 'failed' : 'slow'} request`, async ({
		page
	}) => {
		await pauseRendererClock(page);
		await page.goto(`${origin}?view=app&defer=resize`);
		await page.clock.runFor(100);
		const paintWidth = async (width: number): Promise<void> => {
			await page.evaluate((width) => {
				const host = document.querySelector(
					'canvas[aria-label="Neovim editor display"]'
				)?.parentElement;
				if (!host) throw new Error('Missing editor host');
				host.style.width = `${width}px`;
				window.rendererTest.emit({ type: 'redraw', id: 'alpha', events: [['flush']] });
			}, width);
			await page.clock.runFor(32);
		};
		await paintWidth(600);
		for (let pass = 0; pass < 3; pass++) {
			await page.evaluate(() => {
				while (window.rendererTest.pending.some((call) => call.method === 'resize')) {
					window.rendererTest.settle('resize', 0, undefined);
				}
			});
			await page.clock.runFor(32);
		}
		const before = await page.evaluate(() => {
			const resizes = window.rendererTest.calls.filter((call) => call.method === 'resize');
			return { count: resizes.length, dimensions: resizes.at(-1)!.args };
		});
		for (let index = 0; index < 20; index++) {
			await paintWidth(index === 19 ? 600 : 800 + index * 10);
		}
		const queued = await page.evaluate(() => ({
			pending: window.rendererTest.pending.filter((call) => call.method === 'resize').length,
			calls: window.rendererTest.calls.filter((call) => call.method === 'resize').length
		}));
		expect(queued.pending).toBe(1);
		expect(queued.calls - before.count).toBe(1);
		await page.evaluate((reject) => {
			window.rendererTest.settle(
				'resize',
				0,
				reject ? 'Resize interrupted' : undefined,
				reject
			);
		}, reject);
		await page.clock.runFor(32);
		const latest = await page.evaluate(() => {
			const resizes = window.rendererTest.calls.filter((call) => call.method === 'resize');
			return {
				pending: window.rendererTest.pending.filter((call) => call.method === 'resize')
					.length,
				calls: resizes.length,
				dimensions: resizes.at(-1)!.args
			};
		});
		expect(latest.pending).toBe(1);
		expect(latest.calls - before.count).toBe(2);
		expect(latest.dimensions).toEqual(before.dimensions);
		await page.evaluate(() => window.rendererTest.settle('resize', 0, undefined));
		await page.clock.runFor(32);
		expect(
			await page.evaluate(
				() => window.rendererTest.pending.filter((call) => call.method === 'resize').length
			)
		).toBe(0);
		if (reject) {
			await expect(page.getByText('Resize interrupted', { exact: true })).toBeVisible();
		}
		await paintWidth(800);
		await paintWidth(900);
		const beforeClose = await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'resize').length
		);
		await page.evaluate(() => window.rendererTest.emit({ type: 'exit', id: 'alpha' }));
		await page.clock.runFor(32);
		await expect(page.locator('canvas[aria-label="Neovim editor display"]')).toHaveCount(0);
		await page.evaluate(() => window.rendererTest.settle('resize', 0, undefined));
		await page.clock.runFor(32);
		expect(
			await page.evaluate(
				() => window.rendererTest.calls.filter((call) => call.method === 'resize').length
			)
		).toBe(beforeClose);
		console.log('editor-resize-backpressure', JSON.stringify({ reject, queued, latest }));
	});
}

test('Favorite toggling permits only one pending request', async ({ page }) => {
	await page.goto(`${origin}?view=favorites&defer=setWorkspaceFavorite`);
	const toggle = page.getByRole('button', { name: 'Toggle favorite' });
	await toggle.click();
	await expect(page.getByRole('status')).toHaveText('busy');
	expect(await page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('setWorkspaceFavorite', 0, [
			{ root: '/alpha', name: 'Alpha', kind: 'editor' }
		])
	);
	await toggle.click();
	expect(await page.evaluate(() => window.rendererTest.pending[0].args)).toEqual([
		'/alpha',
		'editor',
		false
	]);
});

test('workspace changes apply only missing settings and changed values', async ({ page }) => {
	await page.goto(`${origin}?view=settings`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.calls.length)).toBe(5);
	const alpha = { id: 'alpha', name: 'Renamed Alpha', root: '/alpha' };
	const beta = { id: 'beta', name: 'Beta', root: '/beta' };
	await page.evaluate((alpha) => window.rendererTest.render({ workspaces: [alpha] }), alpha);
	await expect(page.getByRole('status')).toHaveText('Ready');
	await page.evaluate(
		([alpha, beta]) => window.rendererTest.render({ workspaces: [beta, alpha] }),
		[alpha, beta]
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.calls.length)).toBe(10);
	expect(
		await page.evaluate(() => window.rendererTest.calls.slice(5).map((call) => call.args[0]))
	).toEqual(['beta', 'beta', 'beta', 'beta', 'beta']);
	await page.evaluate(
		([alpha, beta]) =>
			window.rendererTest.render({
				workspaces: [alpha, beta],
				settings: {
					clipboardSharing: true,
					relativeLineNumbers: true,
					editorConfig: true,
					methodSeparators: false,
					wordWrap: true
				}
			}),
		[alpha, beta]
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.calls.length)).toBe(12);
	expect(await page.evaluate(() => window.rendererTest.calls.slice(10))).toEqual([
		{ method: 'setWordWrap', args: ['alpha', true] },
		{ method: 'setWordWrap', args: ['beta', true] }
	]);
	await page.evaluate(
		([alpha, beta]) =>
			window.rendererTest.render({
				workspaces: [
					{ ...alpha, terminalId: 'shell' },
					beta,
					{ id: 'terminal', root: '/terminal', name: 'Terminal', kind: 'terminal' }
				]
			}),
		[alpha, beta]
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.calls.length)).toBe(14);
	expect(await page.evaluate(() => window.rendererTest.calls.slice(12))).toEqual([
		{ method: 'setClipboardSharing', args: ['shell', true] },
		{ method: 'setClipboardSharing', args: ['terminal', true] }
	]);
});

test('closing a terminal during startup keeps it closed and reuses the finished session', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=openTerminal`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
	await expect(editor).toBeFocused();
	await page.keyboard.press('Control+`');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.keyboard.press('Control+`');
	await page.evaluate(() =>
		window.rendererTest.settle('openTerminal', 0, {
			id: 'alpha-shell',
			root: '/alpha',
			name: 'Terminal Alpha',
			kind: 'terminal'
		})
	);
	// The session stays mounted but need not attach its hidden editor until it is opened.
	await expect(page.locator('section[aria-label="Terminal"]')).toHaveCount(1);
	await expect(terminal).toBeHidden();
	await expect(editor).toBeFocused();
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'openTerminal').length
		)
	).toBe(1);
	await page.keyboard.press('Control+`');
	await expect(terminal).toBeVisible();
	await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
});

for (const existingTerminal of [false, true]) {
	test(`terminal toggle after switching workspaces ${existingTerminal ? 'reuses the visible terminal' : 'opens a missing terminal on the first press'}`, async ({
		page
	}) => {
		await page.goto(`${origin}?view=app&defer=restoreWorkspaces,openTerminal`);
		await page.evaluate(
			(existing) =>
				window.rendererTest.settle('restoreWorkspaces', 0, {
					workspaces: [
						{ id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'alpha-shell' },
						{
							id: 'beta',
							root: '/beta',
							name: 'Beta',
							...(existing ? { terminalId: 'beta-shell' } : {})
						}
					],
					active: 'alpha',
					errors: []
				}),
			existingTerminal
		);
		await expect(
			page.getByRole('textbox', { name: 'Neovim input', exact: true })
		).toBeFocused();
		await page.keyboard.press('Control+`');
		await expect(
			page.getByRole('textbox', { name: 'Terminal input', exact: true })
		).toBeFocused();
		await page.keyboard.press('Alt+2');
		await expect(
			page.getByRole('tab', { name: 'Workspace Beta', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		const visibleTerminal = page.locator('section[aria-label="Terminal"]:visible');
		if (existingTerminal) {
			await expect(visibleTerminal).toHaveCount(1);
			await expect(visibleTerminal).toContainText('Beta');
			await page.keyboard.press('Control+`');
			await expect(visibleTerminal).toHaveCount(0);
			await page.keyboard.press('Control+`');
		} else {
			await expect(visibleTerminal).toHaveCount(0);
			await page.keyboard.press('Control+`');
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							window.rendererTest.calls.filter(
								(call) => call.method === 'openTerminal'
							).length
					)
				)
				.toBe(1);
			await page.evaluate(() =>
				window.rendererTest.settle('openTerminal', 0, {
					id: 'beta-shell',
					root: '/beta',
					name: 'Terminal Beta',
					kind: 'terminal'
				})
			);
		}
		await expect(visibleTerminal).toHaveCount(1);
		await expect(visibleTerminal).toContainText('Beta');
		await expect(
			visibleTerminal.getByRole('textbox', { name: 'Terminal input' })
		).toBeFocused();
		await page.keyboard.press('Control+`');
		await expect(visibleTerminal).toHaveCount(0);
		await page.keyboard.press('Control+`');
		await expect(visibleTerminal).toHaveCount(1);
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'openTerminal')
					.map((call) => call.args[0])
			)
		).toEqual(existingTerminal ? [] : ['beta']);
	});
}

test('terminal startup in another workspace cannot take focus from the current editor', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,openTerminal`);
	// Settle only once the app has asked for its workspaces.
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'restoreWorkspaces')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta', terminalId: 'beta-shell' }
			],
			active: 'alpha',
			errors: []
		})
	);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Control+`');
	await page.keyboard.press('Alt+2');
	await page.keyboard.press('Control+`');
	const betaTerminal = page.getByRole('region', { name: 'Terminal', exact: true });
	await expect(betaTerminal).toBeVisible();
	await page.keyboard.press('Control+k');
	const editor = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(editor).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.settle('openTerminal', 0, {
			id: 'alpha-shell',
			root: '/alpha',
			name: 'Terminal Alpha',
			kind: 'terminal'
		})
	);
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(editor).toBeFocused();
	await expect(betaTerminal).toBeVisible();
});

test('terminal startup honors the latest toggle and a failed startup can be retried', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=openTerminal`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Control+`');
	await page.evaluate(() => window.rendererTest.settle('openTerminal', 0, 'Shell failed', true));
	await expect(page.getByRole('alert')).toContainText('Shell failed');
	await page.keyboard.press('Escape');
	for (let index = 0; index < 3; index++) {
		await page.keyboard.press('Control+`');
	}
	expect(
		await page.evaluate(
			() =>
				window.rendererTest.pending.filter((call) => call.method === 'openTerminal').length
		)
	).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('openTerminal', 0, {
			id: 'shell',
			root: '/alpha',
			name: 'Terminal Alpha',
			kind: 'terminal'
		})
	);
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
});

test('a delayed shell restart cannot take focus after returning to the editor', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,restartTerminal`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [{ id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'shell' }],
			active: 'alpha',
			errors: []
		})
	);
	const editor = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(editor).toBeFocused();
	await page.keyboard.press('Control+`');
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
	await page.keyboard.press('Control+Shift+r');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.keyboard.press('Control+k');
	await expect(editor).toBeFocused();
	await page.evaluate(() => window.rendererTest.settle('restartTerminal', 0, undefined));
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(editor).toBeFocused();
});

test('workspace tabs move by keyboard and drag while keeping their colors and selection', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta' },
				{ id: 'gamma', root: '/gamma', name: 'Gamma' }
			],
			active: 'beta',
			errors: []
		})
	);
	const tabs = page.getByRole('tablist', { name: 'Workspaces', exact: true });
	const [alpha, beta, gamma] = ['Alpha', 'Beta', 'Gamma'].map((name) =>
		tabs.getByRole('tab', { name: `Workspace ${name}`, exact: true })
	);
	const colors = (): Promise<string[]> =>
		Promise.all(
			[alpha, beta, gamma].map((tab) =>
				tab
					.locator('span')
					.first()
					.evaluate((dot) => getComputedStyle(dot).backgroundColor)
			)
		);
	const layout = (): Promise<unknown[] | undefined> =>
		page.evaluate(
			() =>
				window.rendererTest.calls.filter((call) => call.method === 'workspaceLayout').at(-1)
					?.args
		);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	const initialColors = await colors();
	expect(new Set(initialColors).size).toBe(3);

	await page.keyboard.press('Alt+Shift+PageUp');
	await expect(tabs.getByRole('tab')).toHaveText([/Beta/, /Alpha/, /Gamma/]);
	expect(await colors()).toEqual(initialColors);
	await page.keyboard.press('Alt+Shift+PageDown');
	await expect(tabs.getByRole('tab')).toHaveText([/Alpha/, /Beta/, /Gamma/]);
	await gamma.dragTo(alpha);
	await expect(tabs.getByRole('tab')).toHaveText([/Gamma/, /Alpha/, /Beta/]);
	await expect(beta).toHaveAttribute('aria-selected', 'true');
	expect(await colors()).toEqual(initialColors);
	await expect.poll(layout).toEqual([['gamma', 'alpha', 'beta'], 'beta']);
});

test('workspace palette reorders the highlighted session without switching sessions', async ({
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
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Space');
	await page.keyboard.press('w');
	const palette = page.getByRole('dialog', { name: 'workspaces palette' });
	const list = palette.getByRole('group', { name: 'Palette results' });
	const selected = list.locator('button[class*="selectedItem"]');
	const layout = (): Promise<unknown[] | undefined> =>
		page.evaluate(
			() =>
				window.rendererTest.calls.filter((call) => call.method === 'workspaceLayout').at(-1)
					?.args
		);
	await expect(list).toBeFocused();
	await page.keyboard.press('j');
	await expect(selected).toContainText('Beta');
	await page.keyboard.press('Shift+K');
	await expect(list.getByRole('button').first()).toContainText('Beta');
	await expect(selected).toContainText('Beta');
	await expect.poll(layout).toEqual([['beta', 'alpha'], 'alpha']);
	await expect(list).toBeFocused();

	await page.keyboard.press('Shift+J');
	await expect(list.getByRole('button').first()).toContainText('Alpha');
	await expect(selected).toContainText('Beta');
	await expect.poll(layout).toEqual([['alpha', 'beta'], 'alpha']);
});

test('sleeping workspaces start nothing until selected, then load behind the indicator', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,wakeWorkspace`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta', sleeping: true }
			],
			active: 'alpha',
			errors: []
		})
	);
	const beta = page.getByRole('tab', { name: 'Workspace Beta', exact: true });
	await expect(beta).toHaveAccessibleDescription('Sleeping');
	await page.clock.runFor(1000);
	const betaCalls = (): Promise<string[]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.args[0] === 'beta')
				.map((call) => call.method)
		);
	// No editor, explorer or settings requests reach a workspace without Neovim.
	expect(await betaCalls()).toEqual([]);

	await beta.click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.filter((call) => call.method === 'wakeWorkspace')
			)
		)
		.toHaveLength(1);
	const loading = page.getByRole('status', { name: 'Loading workspaces…' });
	await page.clock.runFor(300);
	await expect(loading).toBeVisible();
	expect(await betaCalls()).toEqual(['wakeWorkspace']);
	await page.evaluate(() =>
		window.rendererTest.settle('wakeWorkspace', 0, {
			workspace: { id: 'beta', root: '/beta', name: 'Beta' },
			errors: []
		})
	);
	await expect(beta).not.toHaveAccessibleDescription('Sleeping');
	await expect
		.poll(async () => {
			await page.clock.runFor(50);
			return betaCalls();
		})
		.toContain('attach');
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'beta',
			events: [
				['grid_resize', [1, 40, 10]],
				['grid_line', [1, 0, 0, Array.from('beta', (text) => [text, 0])]],
				['flush']
			]
		})
	);
	await page.clock.runFor(50);
	await expect(loading).toHaveCount(0);
});

test('background workspaces sleep after five minutes, and a failed wake offers a retry', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,sleepWorkspace,wakeWorkspace`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
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
	const sleeps = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'sleepWorkspace')
				.map((call) => call.args)
		);
	await page.clock.runFor(4 * 60 * 1000);
	expect(await sleeps()).toEqual([]);
	await page.clock.runFor(90 * 1000);
	// Only the background workspace is asked to sleep.
	await expect.poll(sleeps).toEqual([['beta']]);
	await page.evaluate(() => window.rendererTest.settle('sleepWorkspace', 0, true));
	const beta = page.getByRole('tab', { name: 'Workspace Beta', exact: true });
	await expect(beta).toHaveAccessibleDescription('Sleeping');

	await beta.click();
	const loading = page.getByRole('status', { name: 'Loading workspaces…' });
	await page.clock.runFor(300);
	await expect(loading).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.settle(
			'wakeWorkspace',
			0,
			new Error("Error invoking remote method 'nido:wake': Error: Choose a project folder."),
			true
		)
	);
	await page.clock.runFor(50);
	await expect(loading).toHaveCount(0);
	await expect(beta).toHaveAccessibleDescription('Sleeping');
	const failure = page.getByRole('alert', { name: 'Could not reopen Beta' });
	await expect(failure).toContainText('Choose a project folder.');
	await expect(failure).not.toContainText('invoking remote method');
	// Retry is focused, so Enter tries again.
	await expect(failure.getByRole('button', { name: 'Retry' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(failure).toHaveCount(0);
	await page.clock.runFor(300);
	await expect(loading).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'wakeWorkspace')
						.length
			)
		)
		.toBe(2);
	await page.evaluate(() =>
		window.rendererTest.settle('wakeWorkspace', 0, new Error('Still missing'), true)
	);
	await expect(page.getByRole('alert', { name: 'Could not reopen Beta' })).toContainText(
		'Still missing'
	);
	await page
		.getByRole('alert', { name: 'Could not reopen Beta' })
		.getByRole('button', { name: 'Close workspace' })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'closeWorkspace')
					.map((call) => call.args)
			)
		)
		.toEqual([['beta']]);
});

test('typing while a workspace wakes reaches that workspace, not the previous one', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,wakeWorkspace`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta', sleeping: true }
			],
			active: 'alpha',
			errors: []
		})
	);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	const inputs = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'input')
				.map((call) => call.args)
		);
	await page.keyboard.press('Alt+2');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'wakeWorkspace')
			)
		)
		.toBe(true);
	// Escape belongs to the typing too: it must leave Insert mode in the woken workspace.
	await page.keyboard.type('4Gix');
	await page.keyboard.press('Escape');
	await page.keyboard.type('j');
	expect(await inputs()).toEqual([]);
	await page.evaluate(() =>
		window.rendererTest.settle('wakeWorkspace', 0, {
			workspace: { id: 'beta', root: '/beta', name: 'Beta' },
			errors: []
		})
	);
	await expect.poll(inputs).toEqual([['beta', '4Gix<Esc>j']]);
	const editor = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(editor).toBeFocused();
	await page.keyboard.type('k');
	await expect.poll(inputs).toEqual([
		['beta', '4Gix<Esc>j'],
		['beta', 'k']
	]);
});

test('typing during an abandoned wake is dropped, even after an earlier wake finished in the background', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,sleepWorkspace,wakeWorkspace`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta', sleeping: true }
			],
			active: 'alpha',
			errors: []
		})
	);
	const waking = (): Promise<boolean> =>
		page.evaluate(() =>
			window.rendererTest.pending.some((call) => call.method === 'wakeWorkspace')
		);
	const alpha = page.getByRole('tab', { name: 'Workspace Alpha', exact: true });
	const beta = page.getByRole('tab', { name: 'Workspace Beta', exact: true });
	// The first wake finishes after its workspace is no longer selected.
	await page.keyboard.press('Alt+2');
	await expect.poll(waking).toBe(true);
	await page.keyboard.press('Alt+1');
	await expect(alpha).toHaveAttribute('aria-selected', 'true');
	await page.evaluate(() =>
		window.rendererTest.settle('wakeWorkspace', 0, {
			workspace: { id: 'beta', root: '/beta', name: 'Beta' },
			errors: []
		})
	);
	await expect(beta).not.toHaveAccessibleDescription('Sleeping');
	await page.clock.runFor(6 * 60 * 1000);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'sleepWorkspace')
			)
		)
		.toBe(true);
	await page.evaluate(() => window.rendererTest.settle('sleepWorkspace', 0, true));
	await expect(beta).toHaveAccessibleDescription('Sleeping');

	// The second wake is still running when the user leaves: its typing has no workspace.
	await page.keyboard.press('Alt+2');
	await expect.poll(waking).toBe(true);
	await page.keyboard.type('x');
	await page.keyboard.press('Alt+1');
	await expect(alpha).toHaveAttribute('aria-selected', 'true');
	await page.clock.runFor(300);
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'input')
				.map((call) => call.args)
		)
	).toEqual([]);
});
