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

test('workspace picker reaches connection and folder actions without a session type selector', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.keyboard.press('Control+Shift+n');
	await expect(page.getByRole('listbox', { name: 'Folders', exact: true })).toBeFocused();
	await page.keyboard.press('Control+l');
	await expect(page.getByRole('textbox', { name: 'Folder path', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	const parent = page.getByRole('button', { name: '↑ Parent', exact: true });
	await expect(parent).toBeFocused();
	await expect(page.getByRole('combobox', { name: 'Session type', exact: true })).toHaveCount(0);
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(page.getByRole('combobox', { name: 'Connection', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	await expect(parent).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('confirming IME text in the folder address does not browse or open a workspace', async ({
	page
}) => {
	await page.goto(origin + '?view=app&defer=browseFolders,createWorkspace');
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.keyboard.press('Control+Shift+n');
	const list = page.getByRole('listbox', { name: 'Folders', exact: true });
	const address = page.getByRole('textbox', { name: 'Folder path', exact: true });
	const actions = (): Promise<string[]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter(({ method }) => ['browseFolders', 'createWorkspace'].includes(method))
				.map(({ method }) => method)
		);
	await expect.poll(actions).toEqual(['browseFolders']);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/alpha', parent: '/', folders: [] })
	);
	await expect(list).toHaveAttribute('aria-busy', 'false');
	await address.fill('/日本語');
	for (const event of [
		{ isComposing: true },
		{ keyCode: 229 },
		{ isComposing: true, ctrlKey: true }
	]) {
		await address.dispatchEvent('keydown', { key: 'Enter', ...event });
		expect(await actions()).toEqual(['browseFolders']);
		await expect(address).toBeFocused();
	}
	await address.press('Enter');
	await expect.poll(actions).toEqual(['browseFolders', 'browseFolders']);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/日本語',
			parent: '/',
			folders: []
		})
	);
	await expect(list).toBeFocused();
	await page.keyboard.press('Control+Enter');
	await expect.poll(actions).toEqual(['browseFolders', 'browseFolders', 'createWorkspace']);
});

test('a workspace opened in the background keeps the panel opened after leaving the picker', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=createWorkspace`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	const original = page.getByRole('tab', { name: 'Workspace Alpha', exact: true });
	await page.keyboard.press('Control+Shift+n');
	const list = page.getByRole('listbox', { name: 'Folders', exact: true });
	await expect(list).toHaveAttribute('aria-busy', 'false');
	await list.press('Control+Enter');
	await expect
		.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.method))
		.toBe('createWorkspace');
	await page.keyboard.press('Escape');
	await expect(list).toHaveCount(0);
	await page.keyboard.press('Control+Shift+p');
	const filter = page.getByRole('textbox', { name: 'Filter items', exact: true });
	await expect(filter).toBeVisible();
	await filter.fill('Settings');
	await page.evaluate(() =>
		window.rendererTest.settle('createWorkspace', 0, {
			id: 'new',
			root: '/new',
			name: 'New',
			kind: 'editor'
		})
	);
	const added = page.getByRole('tab', { name: 'Workspace New', exact: true });
	await expect(added).toBeVisible();
	await expect(original).toHaveAttribute('aria-selected', 'true');
	await expect(added).toHaveAttribute('aria-selected', 'false');
	await expect(filter).toBeFocused();
	await expect(filter).toHaveValue('Settings');
});

test('going up from a Windows drive root lists the drives and opens another one', async ({
	page
}) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: 'C:\\',
			parent: 'C:\\',
			folders: [{ name: 'Users', path: 'C:\\Users', directory: true }]
		})
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect(list.getByRole('option')).toHaveText(['▸ Users']);
	const parent = page.getByRole('button', { name: '↑ Parent' });
	await expect(parent).toBeEnabled();
	await list.focus();
	await page.keyboard.press('h');
	await expect(list.getByRole('option')).toHaveText(['▸ C:', '▸ D:']);
	// The drive list has no folder of its own to open, and nothing above it.
	await expect(parent).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Open current folder' })).toBeDisabled();
	await page.keyboard.press('j');
	await page.keyboard.press('l');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending
					.filter((call) => call.method === 'browseFolders')
					.map((call) => call.args[0])
			)
		)
		.toEqual(['D:\\']);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: 'D:\\',
			parent: 'D:\\',
			folders: [{ name: 'Projects', path: 'D:\\Projects', directory: true }]
		})
	);
	await expect(list.getByRole('option')).toHaveText(['▸ Projects']);
	await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveValue('D:\\');
});

test('a POSIX root keeps the parent button disabled', async ({ page }) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/', parent: '/', folders: [] })
	);
	await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await expect(page.getByRole('button', { name: '↑ Parent' })).toBeDisabled();
});

test('folder loading preserves keyboard focus on the connection', async ({ page }) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.keyboard.press('Control+l');
	await page.keyboard.press('Shift+Tab');
	const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
	await expect(connection).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/alpha', parent: '/', folders: [] })
	);
	await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(connection).toBeFocused();
});

test('browsing folders moves focus to the list only if the user has not moved it', async ({
	page
}) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/alpha', parent: '/', folders: [] })
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect(list).toHaveAttribute('aria-busy', 'false');
	await page.keyboard.press('Control+l');
	await page.keyboard.type('/beta');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/beta', parent: '/', folders: [] })
	);
	await expect(list).toBeFocused();
	await page.keyboard.press('Control+l');
	await page.keyboard.type('/gamma');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.keyboard.press('Shift+Tab');
	const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
	await expect(connection).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, { path: '/gamma', parent: '/', folders: [] })
	);
	await expect(list).toHaveAttribute('aria-busy', 'false');
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(connection).toBeFocused();
});

test('creation entry chooses the session kind and cancelling resets the next editor request', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=favoriteWorkspaces`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('favoriteWorkspaces', 0, [
			{ root: '/editor', name: 'Editor project', kind: 'editor' },
			{ root: '/terminal', name: 'Terminal project', kind: 'terminal' }
		])
	);
	await page.keyboard.press('Control+Shift+p');
	await page.keyboard.type('New terminal session');
	await page.keyboard.press('Enter');
	const picker = page.getByRole('dialog', { name: 'folders palette' });
	await expect(picker).toContainText('New terminal session');
	// Favorites stay hidden until requested.
	await expect(picker.getByRole('option', { name: /^Favorite / })).toHaveCount(0);
	await page.keyboard.press('Control+f');
	await expect(
		picker.getByRole('option', { name: 'Favorite Terminal project (terminal)' })
	).toHaveCount(1);
	await expect(
		picker.getByRole('option', { name: 'Favorite Editor project (editor)' })
	).toHaveCount(0);
	await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.keyboard.press('Control+l');
	await page.keyboard.type('/different/project');
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.find((call) => call.method === 'createWorkspace')
					?.args.slice(0, 2)
			)
		)
		.toEqual(['/different/project', 'terminal']);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Control+Shift+n');
	await expect(picker).toContainText('Open a workspace');
	await page.keyboard.press('Control+f');
	await expect(
		picker.getByRole('option', { name: 'Favorite Editor project (editor)' })
	).toHaveCount(1);
	await expect(
		picker.getByRole('option', { name: 'Favorite Terminal project (terminal)' })
	).toHaveCount(0);
	await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'createWorkspace')
					.at(-1)
					?.args.slice(0, 2)
			)
		)
		.toEqual(['/alpha', 'editor']);
});

test('Folder listings keep address edits made while loading', async ({ page }) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	const address = page.getByRole('textbox', { name: 'Folder path' });
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await address.fill('/beta');
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/home',
			parent: '/',
			folders: [{ name: 'Projects', path: '/home/Projects', directory: true }]
		})
	);
	await expect(list.getByRole('option', { name: 'Projects' })).toBeVisible();
	await expect(address).toHaveValue('/beta');
	await address.press('Enter');
	await expect(list).toHaveAttribute('aria-busy', 'true');
	await expect
		.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.args[0]))
		.toBe('/beta');
	await address.fill('/gamma');
	await page.evaluate(async () => {
		window.rendererTest.settle('browseFolders', 0, {
			path: '/beta',
			parent: '/',
			folders: [{ name: 'Sources', path: '/beta/Sources', directory: true }]
		});
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
	});
	await expect(list.getByRole('option', { name: 'Sources' })).toBeVisible();
	await expect(address).toHaveValue('/gamma');
	await expect(address).toBeFocused();
});

test('Folder browsing cancels old results and clamps selection after favorites change', async ({
	page
}) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	const path = page.getByRole('textbox', { name: 'Folder path' });
	await path.fill('/beta');
	await path.press('Enter');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(2);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 1, {
			path: '/beta',
			parent: '/',
			folders: []
		})
	);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/alpha',
			parent: '/',
			folders: [{ name: 'STALE_FOLDER', path: '/alpha/stale', directory: true }]
		})
	);
	await expect(path).toHaveValue('/beta');
	await expect(page.getByText('STALE_FOLDER')).toHaveCount(0);
	await page.evaluate(() =>
		window.rendererTest.render({
			favorites: [
				{ root: '/first', name: 'First', kind: 'editor' },
				{ root: '/second', name: 'Second', kind: 'editor' }
			]
		})
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect(list.getByRole('option')).toHaveCount(0);
	await list.press('Control+f');
	await expect(list.getByRole('option')).toHaveCount(2);
	await list.press('j');
	await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-1');
	await page.evaluate(() =>
		window.rendererTest.render({
			favorites: [{ root: '/first', name: 'First', kind: 'editor' }]
		})
	);
	await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-0');
});

test('a folder response leaves the selected favorite and its scroll position in place', async ({
	page
}) => {
	await page.setViewportSize({ width: 900, height: 560 });
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.render({
			favorites: Array.from({ length: 30 }, (_, index) => ({
				root: `/favorite-${index}`,
				name: `Favorite ${index}`,
				kind: 'editor'
			}))
		})
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await list.press('Control+f');
	await expect(list.getByRole('option')).toHaveCount(30);
	// The standalone picker does not have the app dialog's height constraint.
	await list.evaluate((node) => {
		node.style.maxHeight = '160px';
	});
	for (let index = 0; index < 24; index++) {
		await list.press('j');
	}
	const selected = list.getByRole('option', { selected: true });
	await expect(selected).toContainText('Favorite 24');
	const top = (): Promise<number> => list.evaluate((node) => node.scrollTop);
	await expect.poll(top).toBeGreaterThan(0);
	const position = await top();

	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/alpha',
			parent: '/',
			folders: [{ name: 'Child', path: '/alpha/child', directory: true }]
		})
	);
	await expect(list).toHaveAttribute('aria-busy', 'false');
	await expect(selected).toContainText('Favorite 24');
	expect(await top()).toBe(position);
	await list.press('Control+f');
	await expect(selected).toContainText('Child');
});

test('Folder browsing keeps the current listing until the next one arrives', async ({ page }) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/alpha',
			parent: '/',
			folders: Array.from({ length: 40 }, (_, index) => ({
				name: `folder${index}`,
				path: `/alpha/folder${index}`,
				directory: true
			}))
		})
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect(list.getByRole('option')).toHaveCount(40);
	const parent = page.getByRole('button', { name: '↑ Parent' });
	// The standalone harness does not bound the list height like the palette does.
	await list.evaluate((element) => (element.style.maxHeight = '200px'));
	await list.focus();
	for (let index = 0; index < 30; index++) {
		await list.press('j');
	}
	expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await list.press('l');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	// No loading placeholder and no disabled controls while the next listing is pending.
	await expect(list).toHaveAttribute('aria-busy', 'true');
	await expect(list.getByRole('option')).toHaveCount(40);
	await expect(list).not.toContainText('Loading folders…');
	await expect(parent).toBeEnabled();
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/alpha/folder30',
			parent: '/alpha',
			folders: [{ name: 'child', path: '/alpha/folder30/child', directory: true }]
		})
	);
	await expect(list.getByRole('option')).toHaveCount(1);
	await expect(list).toHaveAttribute('aria-activedescendant', 'folder-choice-0');
	expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
});

test('Listing Windows drives keeps focus where the user moved it', async ({ page }) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders,windowsDrives`);
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: 'C:\\',
			parent: 'C:\\',
			folders: [{ name: 'Users', path: 'C:\\Users', directory: true }]
		})
	);
	const list = page.getByRole('listbox', { name: 'Folders' });
	await expect(list.getByRole('option', { name: 'Users' })).toBeVisible();
	await list.press('h');
	await expect(list).toHaveAttribute('aria-busy', 'true');
	const address = page.getByRole('textbox', { name: 'Folder path' });
	await address.focus();
	await page.evaluate(async () => {
		window.rendererTest.settle('windowsDrives', 0, ['C:\\', 'D:\\']);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
	});
	await expect(list.getByRole('option', { name: 'D:' })).toBeVisible();
	await expect(address).toBeFocused();
});

test('Favorites open from the command palette and hide again with Ctrl+F', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=favoriteWorkspaces`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('favoriteWorkspaces', 0, [
			{ root: '/editor', name: 'Editor project', kind: 'editor' }
		])
	);
	await page.keyboard.press('Control+Shift+p');
	await page.keyboard.type('Open favorite workspace');
	await page.keyboard.press('Enter');
	const picker = page.getByRole('dialog', { name: 'folders palette' });
	const favorite = picker.getByRole('option', { name: 'Favorite Editor project (editor)' });
	await expect(favorite).toHaveCount(1);
	await expect(picker.getByRole('button', { name: 'Favorites' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.keyboard.press('Control+f');
	await expect(favorite).toHaveCount(0);
	await picker.getByRole('button', { name: 'Favorites' }).click();
	await expect(favorite).toHaveCount(1);
	await page.keyboard.press('h');
	await expect(favorite).toHaveCount(0);
});

test('Switching WSL connections ignores stale listings and displays Linux paths', async ({
	page
}) => {
	await page.goto(`${origin}?view=folders&defer=browseFolders,wslDistributions`);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'browseFolders')
						.length
			)
		)
		.toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('wslDistributions', 0, ['Fedora', 'Ubuntu'])
	);
	const connection = page.getByRole('combobox', { name: 'Connection', exact: true });
	await page.keyboard.press('Control+l');
	await page.keyboard.press('Shift+Tab');
	await expect(connection).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(connection).toHaveValue('Fedora');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'browseFolders')
						.length
			)
		)
		.toBe(2);
	await page.keyboard.press('ArrowDown');
	await expect(connection).toHaveValue('Ubuntu');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'browseFolders')
						.length
			)
		)
		.toBe(3);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 2, {
			path: '\\\\wsl.localhost\\Ubuntu\\home\\me',
			parent: '\\\\wsl.localhost\\Ubuntu\\home',
			folders: []
		})
	);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 1, {
			path: '\\\\wsl.localhost\\Fedora\\home\\old',
			parent: '\\\\wsl.localhost\\Fedora\\home',
			folders: [{ name: 'STALE_WSL_FOLDER', path: 'old', directory: true }]
		})
	);
	await page.evaluate(() =>
		window.rendererTest.settle('browseFolders', 0, {
			path: '/alpha',
			parent: '/',
			folders: []
		})
	);
	const address = page.getByRole('textbox', { name: 'Folder path' });
	await expect(address).toHaveValue('/home/me');
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(connection).toBeFocused();
	await expect(page.getByText('STALE_WSL_FOLDER')).toHaveCount(0);
	await address.fill('/home/me/project with spaces');
	await address.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'browseFolders')
						.at(-1)?.args
			)
		)
		.toEqual(['/home/me/project with spaces', 'Ubuntu']);
	await address.fill('\\\\wsl$\\Fedora\\home\\me\\direct');
	await address.press('Enter');
	await expect(connection).toHaveValue('Fedora');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'browseFolders')
						.at(-1)?.args
			)
		)
		.toEqual(['\\\\wsl$\\Fedora\\home\\me\\direct', 'Fedora']);
});
