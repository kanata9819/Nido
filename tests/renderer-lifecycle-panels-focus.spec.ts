import { test, expect } from './helpers/renderer-test';
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

test('Debugger focuses arriving variables, restores focus after stepping and respects focus outside its panel', async ({
	page
}) => {
	await page.goto(`${origin}?view=debug`);
	await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
	const renderVariables = async (id: number): Promise<void> => {
		await page.evaluate(
			(id) =>
				window.rendererTest.render({
					debugState: {
						status: 'paused',
						output: '',
						targets: [],
						variables: [
							{
								id,
								name: 'number',
								value: '21',
								type: 'int',
								scope: 'Locals',
								depth: 0,
								expandable: false,
								expanded: false,
								loading: false,
								changed: false
							}
						]
					}
				}),
			id
		);
	};
	await renderVariables(1);
	const variable = page.getByRole('treeitem', { name: 'number = 21 (int)' });
	await expect(variable).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.render({
			debugState: { status: 'running', output: '', targets: [], variables: [] }
		})
	);
	await expect(variable).toHaveCount(0);
	await renderVariables(2);
	await expect(variable).toBeFocused();
	const outside = page.getByRole('button', { name: 'Outside debugger' });
	await outside.focus();
	await renderVariables(3);
	await expect(outside).toBeFocused();
	await page.reload();
	await expect(page.getByRole('button', { name: /Start F5/ })).toBeFocused();
	await outside.focus();
	await renderVariables(4);
	await expect(outside).toBeFocused();
});

test('Reference selection resets with a new result and old previews cannot replace it', async ({
	page
}) => {
	// React warns about mistakes such as a key passed in a spread; none may appear here.
	const reactErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') reactErrors.push(message.text());
	});
	await page.goto(`${origin}?view=references&defer=previewReference`);
	const list = page.getByRole('listbox', { name: 'Reference results' });
	await expect(list).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await list.press('j');
	await expect(list).toHaveAttribute('aria-activedescendant', 'reference-1');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(2);
	await page.evaluate(() =>
		window.rendererTest.settle('previewReference', 1, {
			first: 1,
			line: 1,
			lines: [[{ text: 'LATEST_PREVIEW', color: '#fff' }]]
		})
	);
	await page.evaluate(() =>
		window.rendererTest.settle('previewReference', 0, {
			first: 1,
			line: 1,
			lines: [[{ text: 'STALE_PREVIEW', color: '#fff' }]]
		})
	);
	await expect(page.getByRole('region', { name: 'Reference preview' })).toContainText(
		'LATEST_PREVIEW'
	);
	await expect(page.getByText('STALE_PREVIEW')).toHaveCount(0);
	await page.evaluate(() =>
		window.rendererTest.render({
			references: {
				version: 2,
				loading: false,
				error: '',
				items: [{ path: '/alpha/new.ts', line: 1, column: 1, text: 'new reference' }]
			}
		})
	);
	await expect(list).toHaveAttribute('aria-activedescendant', 'reference-0');
	await expect
		.poll(() => page.evaluate(() => window.rendererTest?.pending[0]?.args.slice(1)))
		.toEqual([1, 2]);
	expect(reactErrors).toEqual([]);
});

for (const dismiss of ['button', 'Escape', 'toggle', 'jump'] as const) {
	test(`closed reference searches stay closed across workspace switches after ${dismiss}`, async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const deferred =
			dismiss === 'jump' ? 'restoreWorkspaces,openReference' : 'restoreWorkspaces';
		await page.goto(`${origin}?view=app&defer=${deferred}`);
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
		const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
		const panel = page.locator('[data-references-panel]');
		const list = page.getByRole('listbox', { name: 'Reference results' });
		const toggle = page.getByRole('button', { name: 'Toggle references', exact: true });
		const references = async (id: string, search: number, version: number): Promise<void> => {
			await page.evaluate(
				({ id, search, version }) =>
					window.rendererTest.emit({
						type: 'statePatch',
						id,
						state: {
							references: {
								search,
								version,
								loading: false,
								error: '',
								items: [
									{
										path: `/${id}/result.ts`,
										line: 1,
										column: 1,
										text: `${id}-${search}-${version}`
									}
								]
							}
						}
					}),
				{ id, search, version }
			);
			await page.evaluate(
				() =>
					new Promise((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(resolve))
					)
			);
		};
		const switchTo = async (name: 'Alpha' | 'Beta'): Promise<void> => {
			await page.keyboard.press(name === 'Alpha' ? 'Alt+1' : 'Alt+2');
			await expect(
				page.getByRole('tab', { name: `Workspace ${name}`, exact: true })
			).toHaveAttribute('aria-selected', 'true');
		};
		await expect(editor).toBeFocused();
		await references('alpha', 1, 1);
		await expect(list).toBeFocused();
		if (dismiss === 'button') {
			await page.getByRole('button', { name: 'Hide references', exact: true }).click();
		} else if (dismiss === 'toggle') {
			await toggle.click();
		} else if (dismiss === 'jump') {
			await list.press('Enter');
			await expect(panel).toBeVisible();
			await page.evaluate(() => window.rendererTest.settle('openReference', 0, undefined));
		} else {
			await page.keyboard.press('Escape');
		}
		await expect(panel).toBeHidden();
		await switchTo('Beta');
		await references('beta', 1, 1);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('beta-1-1');
		for (let index = 0; index < 3; index++) {
			await switchTo('Alpha');
			await expect(panel).toBeHidden();
			await expect(editor).toBeFocused();
			await switchTo('Beta');
			await expect(panel).toBeVisible();
		}
		await switchTo('Alpha');
		await references('alpha', 1, 2);
		await expect(panel).toContainText('alpha-1-2');
		await expect(panel).toBeHidden();
		await expect(editor).toBeFocused();
		await references('alpha', 2, 3);
		await expect(panel).toBeVisible();
		await expect(list).toBeFocused();
		await page.keyboard.press('Escape');
		await switchTo('Beta');
		await references('alpha', 3, 4);
		await expect(panel).toContainText('beta-1-1');
		await switchTo('Alpha');
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('alpha-3-4');
		await page.keyboard.press('Escape');
		for (const reopen of ['toggle', 'Control+j']) {
			if (reopen === 'toggle') {
				await toggle.click();
			} else {
				await page.keyboard.press(reopen);
			}
			await expect(list).toBeFocused();
			await switchTo('Beta');
			await switchTo('Alpha');
			await expect(panel).toBeVisible();
			await page.keyboard.press('Escape');
		}
		expect(errors).toEqual([]);
	});
}

test('App opens references and debugger on new events while respecting a closed panel', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [],
				current: 0,
				mode: 'n',
				line: 1,
				column: 1,
				filetype: '',
				references: { version: 1, loading: false, error: '', items: [] }
			}
		})
	);
	await expect(page.getByRole('region', { name: 'References', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Hide references' }).click();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [],
				current: 0,
				mode: 'n',
				line: 2,
				column: 1,
				filetype: '',
				references: { version: 1, loading: false, error: '', items: [] }
			}
		})
	);
	await expect(page.getByRole('region', { name: 'References', exact: true })).toBeHidden();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [],
				current: 0,
				mode: 'n',
				line: 2,
				column: 1,
				filetype: '',
				debug: { status: 'running', output: '', variables: [], targets: [] }
			}
		})
	);
	await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
	const debugStatus = async (status: 'paused' | 'running' | 'building'): Promise<void> => {
		await page.evaluate(
			(nextStatus) =>
				window.rendererTest.emit({
					type: 'state',
					id: 'alpha',
					state: {
						buffers: [],
						current: 0,
						mode: 'n',
						line: 2,
						column: 1,
						filetype: '',
						debug: { status: nextStatus, output: '', variables: [], targets: [] }
					}
				}),
			status
		);
	};
	await debugStatus('paused');
	await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
		'Debug · paused'
	);
	await page.getByRole('button', { name: 'Hide debugger' }).click();
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	await debugStatus('running');
	await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
	await debugStatus('paused');
	await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toHaveCount(0);
	await expect(input).toBeFocused();
	await debugStatus('building');
	await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test('opening a file cannot dismiss a newer command palette', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=findFiles,openFile`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.getByRole('button', { name: 'Find file', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('findFiles', 0, [
			{ name: 'main.rs', path: 'main.rs', directory: false }
		])
	);
	await page.keyboard.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'openFile')
			)
		)
		.toBe(true);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Control+Shift+p');
	await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
	const filter = page.getByRole('textbox', { name: 'Filter items' });
	await filter.fill('Open debug');
	await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
	await expect(filter).toBeFocused();
	await expect(filter).toHaveValue('Open debug');
	await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
});

test('only the latest file opening returns focus, while normal file opening still closes the picker', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=findFiles,openFile`);
	await page.getByRole('button', { name: 'Find file', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('findFiles', 0, [
			{ name: 'first.rs', path: 'first.rs', directory: false },
			{ name: 'second.rs', path: 'second.rs', directory: false }
		])
	);
	const list = page.getByRole('group', { name: 'Palette results' });
	await expect(list).toBeFocused();
	await page.keyboard.press('Enter');
	await page.keyboard.press('j');
	await page.keyboard.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending
					.filter((call) => call.method === 'openFile')
					.map((call) => call.args)
			)
		)
		.toEqual([
			['alpha', 'first.rs'],
			['alpha', 'second.rs']
		]);
	await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(list).toBeFocused();
	await page.evaluate(() => window.rendererTest.settle('openFile', 0, undefined));
	await expect(page.getByRole('dialog', { name: 'files palette' })).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
});

for (const navigation of ['reference', 'problem', 'search'] as const) {
	test(`a delayed ${navigation} jump cannot dismiss a newer command palette`, async ({
		page
	}) => {
		const method =
			navigation === 'reference'
				? 'openReference'
				: navigation === 'problem'
					? 'openProblem'
					: 'openFile';
		await page.goto(
			`${origin}?view=app&defer=${method}${navigation === 'search' ? ',searchText' : ''}`
		);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		if (navigation === 'search') {
			await page.keyboard.press('Control+Shift+f');
			await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('match');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.rendererTest?.pending.some(
							(call) => call.method === 'searchText' && call.args[1] === 'match'
						)
					)
				)
				.toBe(true);
			await page.evaluate(() => {
				const pending = window.rendererTest.pending.filter(
					(call) => call.method === 'searchText'
				);
				for (let index = 0; index < pending.length; index++) {
					window.rendererTest.settle('searchText', 0, {
						truncated: false,
						matches: [{ path: 'main.rs', line: 2, column: 1, text: 'match' }]
					});
				}
			});
			await expect(
				page.getByRole('listbox', { name: 'Search results' }).getByRole('option')
			).toHaveCount(1);
		} else {
			await page.evaluate(
				(navigation) =>
					window.rendererTest.emit({
						type: 'statePatch',
						id: 'alpha',
						state:
							navigation === 'reference'
								? {
										references: {
											version: 1,
											loading: false,
											error: '',
											items: [
												{
													path: '/alpha/main.rs',
													line: 2,
													column: 1,
													text: 'match'
												}
											]
										}
									}
								: {
										diagnosticsVersion: 1,
										problems: [
											{
												path: '/alpha/main.rs',
												line: 2,
												column: 1,
												severity: 1,
												message: 'match',
												source: 'rustc'
											}
										]
									}
					}),
				navigation
			);
			if (navigation === 'problem') {
				await expect(page.getByRole('contentinfo')).toContainText('1');
				await page.keyboard.press('Control+Shift+m');
				await expect(
					page.getByRole('dialog', { name: 'problems palette' }).getByRole('option')
				).toHaveCount(1);
			} else {
				await expect(
					page.getByRole('listbox', { name: 'Reference results' })
				).toBeFocused();
			}
		}
		await page.keyboard.press('Enter');
		await expect
			.poll(() =>
				page.evaluate(
					(method) => window.rendererTest?.pending.some((call) => call.method === method),
					method
				)
			)
			.toBe(true);
		await page.keyboard.press('Escape');
		if (navigation === 'search') {
			await page.keyboard.press('Escape');
		}
		await page.keyboard.press('Control+Shift+p');
		await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
		const filter = page.getByRole('textbox', { name: 'Filter items' });
		await filter.fill('Open debug');
		await page.evaluate((method) => window.rendererTest.settle(method, 0, undefined), method);
		await expect(filter).toBeFocused();
		await expect(filter).toHaveValue('Open debug');
		await expect(page.getByRole('dialog', { name: 'commands palette' })).toBeVisible();
	});
}

test('palettes open on their list like Normal mode, and i a / start typing until Escape or Ctrl+C', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(editor).toBeFocused();
	await page.keyboard.press('Control+Shift+p');
	const palette = page.getByRole('dialog', { name: 'commands palette' });
	const list = palette.getByRole('group', { name: 'Palette results' });
	const filter = palette.getByRole('textbox', { name: 'Filter items' });
	const selected = palette.locator('button[class*="selectedItem"]');
	await expect(list).toBeFocused();
	// Plain j/k move the selection without typing into the filter.
	const first = await selected.textContent();
	await page.keyboard.press('j');
	await expect(selected).not.toHaveText(first!);
	await page.keyboard.press('k');
	await expect(selected).toHaveText(first!);
	await expect(filter).toHaveValue('');
	await expect(palette.getByText('j/k Move · i / Filter', { exact: true })).toBeVisible();
	// i starts typing; Escape returns to the list and keeps the filter.
	await page.keyboard.press('i');
	await expect(filter).toBeFocused();
	await expect(
		palette.getByText('Typing · ↑ ↓ Move · Esc / Ctrl+C Back to the list', { exact: true })
	).toBeVisible();
	await page.keyboard.type('jk');
	await expect(filter).toHaveValue('jk');
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	await expect(filter).toHaveValue('jk');
	// a and / also start typing; Ctrl+C leaves the field like Escape.
	await page.keyboard.press('a');
	await expect(filter).toBeFocused();
	await page.keyboard.press('Control+a');
	await page.keyboard.press('Backspace');
	await expect(filter).toHaveValue('');
	await page.keyboard.press('Control+c');
	await expect(list).toBeFocused();
	await page.keyboard.press('/');
	await expect(filter).toBeFocused();
	await page.keyboard.type('Open');
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	await expect(filter).toHaveValue('Open');
	// On the list, Ctrl+C closes the palette like Escape.
	await page.keyboard.press('Control+c');
	await expect(palette).toBeHidden();
	await expect(editor).toBeFocused();
	await page.keyboard.press('Control+Shift+p');
	await expect(list).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
	await expect(editor).toBeFocused();
});

test('late reference results keep command palette focus and remain reachable afterwards', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Control+Shift+p');
	const filter = page.getByRole('textbox', { name: 'Filter items' });
	await filter.fill('Open');
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: {
				references: {
					version: 1,
					loading: false,
					error: '',
					items: [{ path: '/alpha/main.rs', line: 2, column: 1, text: 'match' }]
				}
			}
		})
	);
	await expect(page.locator('[data-references-panel]')).toBeVisible();
	await expect(filter).toBeFocused();
	await page.keyboard.type(' debug');
	await expect(filter).toHaveValue('Open debug');
	// Escape leaves the filter for the list, then closes the palette.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('group', { name: 'Palette results' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.press('Control+j');
	await expect(page.getByRole('listbox', { name: 'Reference results' })).toBeFocused();
});

test('Ctrl+D/U move half a palette list, from the list and while typing', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.keyboard.press('Control+Shift+P');
	const list = page.getByRole('group', { name: 'Palette results' });
	await expect(list).toBeFocused();
	const rows = list.getByRole('button');
	const selectedIndex = (): Promise<number> =>
		rows.evaluateAll((buttons) =>
			buttons.findIndex((button) => button.className.includes('selectedItem'))
		);
	const half = await list.evaluate((element) => {
		const row = element.querySelector('button')!.getBoundingClientRect().height;
		return Math.max(1, Math.floor(element.clientHeight / 2 / row));
	});
	expect(await rows.count()).toBeGreaterThan(half * 2);
	expect(await selectedIndex()).toBe(0);
	await page.keyboard.press('Control+d');
	await expect.poll(selectedIndex).toBe(half);
	await page.keyboard.press('Control+d');
	await expect.poll(selectedIndex).toBe(half * 2);
	await page.keyboard.press('Control+u');
	await expect.poll(selectedIndex).toBe(half);
	// The same keys work from the filter field.
	await page.keyboard.press('i');
	await expect(page.getByRole('textbox', { name: 'Filter items' })).toBeFocused();
	await page.keyboard.press('Control+u');
	await expect.poll(selectedIndex).toBe(0);
	await page.keyboard.press('Control+d');
	await expect.poll(selectedIndex).toBe(half);
	await expect(page.getByRole('textbox', { name: 'Filter items' })).toHaveValue('');
});

test('file search pages through results from the list and the filter', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=findFiles,openFile`);
	await page.getByRole('button', { name: 'Find file', exact: true }).click();
	const list = page.getByRole('group', { name: 'Palette results' });
	const filter = page.getByRole('textbox', { name: 'Filter items' });
	const rows = list.getByRole('button');
	const selectedIndex = (): Promise<number> =>
		rows.evaluateAll((buttons) =>
			buttons.findIndex((button) => button.className.includes('selectedItem'))
		);
	const finishSearch = async (query: string): Promise<void> => {
		await expect
			.poll(() =>
				page.evaluate(
					(value) =>
						window.rendererTest.pending.some(
							(call) => call.method === 'findFiles' && call.args[1] === value
						),
					query
				)
			)
			.toBe(true);
		await page.evaluate(() =>
			window.rendererTest.settle(
				'findFiles',
				0,
				Array.from({ length: 60 }, (_, index) => ({
					name: `file-${index}.rs`,
					path: `file-${index}.rs`,
					directory: false
				}))
			)
		);
	};
	await finishSearch('');
	await expect(rows).toHaveCount(60);
	await expect(list).toBeFocused();
	const { half, full } = await list.evaluate((element) => {
		const height = element.querySelector('button')!.getBoundingClientRect().height;
		const fit = element.clientHeight / height;
		return { half: Math.max(1, Math.floor(fit / 2)), full: Math.max(1, Math.floor(fit)) };
	});
	expect(await rows.count()).toBeGreaterThan(full * 2);
	await page.keyboard.press('Control+d');
	await expect.poll(selectedIndex).toBe(half);
	await page.keyboard.press('Control+u');
	await expect.poll(selectedIndex).toBe(0);
	await page.keyboard.press('Control+f');
	await expect.poll(selectedIndex).toBe(full);
	await page.keyboard.press('Control+u');
	await expect.poll(selectedIndex).toBe(full - half);

	await page.keyboard.press('/');
	await expect(filter).toBeFocused();
	await filter.fill('file');
	await finishSearch('file');
	await expect.poll(selectedIndex).toBe(0);
	await page.keyboard.press('Control+f');
	await expect.poll(selectedIndex).toBe(full);
	await page.keyboard.press('Control+u');
	await expect.poll(selectedIndex).toBe(full - half);
	await page.keyboard.press('Control+b');
	await expect.poll(selectedIndex).toBe(0);
	await expect(filter).toHaveValue('file');
	await expect(filter).toBeFocused();
});

test('the command palette lists the commands run last first and marks them', async ({ page }) => {
	await page.goto(origin);
	await page.evaluate(() => localStorage.clear());
	await page.goto(`${origin}?view=app`);
	const list = page.getByRole('group', { name: 'Palette results' });
	const firstTitle = (): Promise<string | null> =>
		list.getByRole('button').first().locator('strong').textContent();

	await page.keyboard.press('Control+Shift+P');
	await expect(list).toBeFocused();
	await expect.poll(firstTitle).toBe('Connect to WSL');
	await expect(list.getByText('Recent', { exact: true })).toHaveCount(0);

	// Run Settings from the filtered list, then Problems.
	for (const title of ['Settings', 'Problems']) {
		await page.keyboard.press('Control+Shift+P');
		await page.keyboard.press('i');
		await page.keyboard.type(title);
		await page.keyboard.press('Enter');
		await page.keyboard.press('Escape');
	}

	await page.keyboard.press('Control+Shift+P');
	await expect(list).toBeFocused();
	await expect
		.poll(() => list.getByRole('button').locator('strong').allTextContents())
		.toEqual(expect.arrayContaining(['Problems', 'Settings']));
	const titles = await list.getByRole('button').locator('strong').allTextContents();
	expect(titles.slice(0, 3)).toEqual(['Problems', 'Settings', 'Connect to WSL']);
	await expect(list.getByText('Recent', { exact: true })).toHaveCount(2);

	// A query lists the commands in their usual order again.
	await page.keyboard.press('i');
	await page.keyboard.type('s');
	await expect.poll(firstTitle).not.toBe('Problems');
});

for (const kind of ['definitions', 'type definitions', 'implementations'] as const) {
	test(`a ${kind} list closes after jumping to one of them`, async ({ page }) => {
		await page.goto(`${origin}?view=app&defer=openReference`);
		const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
		await expect(editor).toBeFocused();
		await page.evaluate(
			(kind) =>
				window.rendererTest.emit({
					type: 'statePatch',
					id: 'alpha',
					state: {
						references: {
							search: 1,
							version: 1,
							kind,
							loading: false,
							error: '',
							items: [1, 2].map((line) => ({
								path: '/alpha/state.ts',
								line,
								column: 1,
								text: `definition ${line}`
							}))
						}
					}
				}),
			kind
		);
		const panel = page.locator('[data-references-panel]');
		const list = page.getByRole('listbox', { name: 'Reference results' });
		await expect(list).toBeFocused();
		await list.press('j');
		await list.press('Enter');
		// Open until the jump finishes, then closed, with the editor focused.
		await expect(panel).toBeVisible();
		await page.evaluate(() => window.rendererTest.settle('openReference', 0, undefined));
		await expect(panel).toBeHidden();
		await expect(editor).toBeFocused();
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'openReference')
					.map((call) => call.args)
			)
			// The second result, numbered from 1 as in Lua.
		).toEqual([['alpha', 2, 1]]);
	});
}
