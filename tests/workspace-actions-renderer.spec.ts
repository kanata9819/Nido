import { test, expect } from './helpers/renderer-test';
import type { Locator, Page } from '@playwright/test';
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

async function restoreWorkspaces(page: Page, deferred: string): Promise<void> {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,${deferred}`);
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
				{ id: 'alpha', root: '/alpha', name: 'Alpha', terminalId: 'alpha-shell' },
				{ id: 'beta', root: '/beta', name: 'Beta' }
			],
			active: 'alpha',
			errors: []
		})
	);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
}

test('a delayed workspace close preserves a newer terminal interaction', async ({ page }) => {
	await restoreWorkspaces(page, 'closeWorkspace');
	await page.getByRole('button', { name: 'Close workspace Beta', exact: true }).click();
	await page.keyboard.press('Control+`');
	const terminal = page.getByRole('textbox', { name: 'Terminal input', exact: true });
	await expect(terminal).toBeFocused();
	await page.evaluate(() => {
		window.rendererTest.emit({ type: 'exit', id: 'beta' });
		window.rendererTest.settle('closeWorkspace', 0, undefined);
	});
	await expect(page.getByRole('tab', { name: 'Workspace Beta', exact: true })).toHaveCount(0);
	await expect(terminal).toBeFocused();
});

test('a failed workspace creation preserves a newer terminal interaction', async ({ page }) => {
	await restoreWorkspaces(page, 'createWorkspace');
	await page.keyboard.press('Control+Shift+n');
	const picker = page.getByRole('dialog', { name: 'folders palette' });
	await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'createWorkspace')
			)
		)
		.toBe(true);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Control+`');
	const terminal = page.getByRole('textbox', { name: 'Terminal input', exact: true });
	await expect(terminal).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.settle('createWorkspace', 0, 'Workspace startup failed', true)
	);
	await expect(page.getByRole('alert')).toContainText('Workspace startup failed');
	await expect(terminal).toBeFocused();
});

test('cancelling a workspace close still returns focus to the editor', async ({ page }) => {
	await restoreWorkspaces(page, 'closeWorkspace');
	await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
	await page.evaluate(() => window.rendererTest.settle('closeWorkspace', 0, undefined));
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
});

test('successful workspace creation selects and focuses the new editor', async ({ page }) => {
	await restoreWorkspaces(page, 'createWorkspace');
	await page.keyboard.press('Control+Shift+n');
	const picker = page.getByRole('dialog', { name: 'folders palette' });
	await expect(picker.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.pending.some((call) => call.method === 'createWorkspace')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('createWorkspace', 0, {
			id: 'gamma',
			root: '/gamma',
			name: 'Gamma'
		})
	);
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'Workspace Gamma', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
});

test('closing the selected workspace selects the tab that takes its place', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
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
				{ id: 'beta', root: '/beta', name: 'Beta' },
				{ id: 'gamma', root: '/gamma', name: 'Gamma' },
				{ id: 'delta', root: '/delta', name: 'Delta' }
			],
			active: 'beta',
			errors: []
		})
	);
	const tab = (name: string): Locator =>
		page.getByRole('tab', { name: `Workspace ${name}`, exact: true });
	await expect(tab('Beta')).toHaveAttribute('aria-selected', 'true');
	// The tab to the right takes the closed tab's place.
	await page.evaluate(() => window.rendererTest.emit({ type: 'exit', id: 'beta' }));
	await expect(tab('Beta')).toHaveCount(0);
	await expect(tab('Gamma')).toHaveAttribute('aria-selected', 'true');
	// Closing a background tab keeps the selection.
	await page.evaluate(() => window.rendererTest.emit({ type: 'exit', id: 'alpha' }));
	await expect(tab('Alpha')).toHaveCount(0);
	await expect(tab('Gamma')).toHaveAttribute('aria-selected', 'true');
	// The last tab has none to its right, so the one to its left is selected.
	await page.getByRole('tab', { name: 'Workspace Delta', exact: true }).click();
	await expect(tab('Delta')).toHaveAttribute('aria-selected', 'true');
	await page.evaluate(() => window.rendererTest.emit({ type: 'exit', id: 'delta' }));
	await expect(tab('Delta')).toHaveCount(0);
	await expect(tab('Gamma')).toHaveAttribute('aria-selected', 'true');
});

test('Ctrl+S in the workspace list puts a background workspace to sleep', async ({ page }) => {
	await restoreWorkspaces(page, 'sleepWorkspace');
	const sleeps = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'sleepWorkspace')
				.map((call) => call.args)
		);
	await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
	const list = page.getByRole('dialog', { name: 'workspaces palette', exact: true });
	const alpha = list.getByRole('button', { name: /Alpha/ });
	const beta = list.getByRole('button', { name: /Beta/ });
	await expect(alpha).toContainText('Current');
	await expect(alpha).toHaveAttribute('title', 'Current workspace · Cannot sleep');

	// The selected workspace stays awake.
	await page.keyboard.press('Control+s');
	expect(await sleeps()).toEqual([]);

	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Control+s');
	await expect.poll(sleeps).toEqual([['beta']]);
	await page.evaluate(() => window.rendererTest.settle('sleepWorkspace', 0, true));
	await expect(
		page.getByRole('tab', { name: 'Workspace Beta', exact: true })
	).toHaveAccessibleDescription('Sleeping');
	await expect(beta).toContainText('Sleeping');
	await expect(list).toBeVisible();

	// A sleeping workspace is not asked again.
	await page.keyboard.press('Control+s');
	expect(await sleeps()).toEqual([['beta']]);
});

/** Open the workspace list, select Beta and press Ctrl+S; resolves once the request is pending. */
async function requestBetaSleep(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Control+s');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'sleepWorkspace')
			)
		)
		.toBe(true);
}

const sleepRequests = (page: Page): Promise<unknown[][]> =>
	page.evaluate(() =>
		window.rendererTest.calls
			.filter((call) => call.method === 'sleepWorkspace')
			.map((call) => call.args)
	);

test('a busy terminal and unsaved files are cleared with Enter before sleeping', async ({
	page
}) => {
	await restoreWorkspaces(page, 'sleepWorkspace');
	await requestBetaSleep(page);
	await page.evaluate(() =>
		window.rendererTest.settle('sleepWorkspace', 0, ['terminal', 'modified'])
	);
	const list = page.getByRole('dialog', { name: 'workspaces palette', exact: true });
	const prompt = list.getByRole('alert');
	await expect(prompt).toContainText(
		'Beta: its terminal will be closed and its unsaved changes saved before it sleeps.'
	);
	// Nothing is closed or saved until Enter.
	expect(await sleepRequests(page)).toEqual([['beta']]);
	await page.keyboard.press('Enter');
	await expect.poll(() => sleepRequests(page)).toEqual([['beta'], ['beta', true]]);
	await expect(prompt).toHaveCount(0);
	await page.evaluate(() => window.rendererTest.settle('sleepWorkspace', 0, true));
	await expect(
		page.getByRole('tab', { name: 'Workspace Beta', exact: true })
	).toHaveAccessibleDescription('Sleeping');
});

test('any other key cancels the sleep prompt', async ({ page }) => {
	await restoreWorkspaces(page, 'sleepWorkspace');
	await requestBetaSleep(page);
	await page.evaluate(() => window.rendererTest.settle('sleepWorkspace', 0, ['modified']));
	const list = page.getByRole('dialog', { name: 'workspaces palette', exact: true });
	await expect(list.getByRole('alert')).toContainText(
		'Beta: its unsaved changes will be saved before it sleeps.'
	);
	await page.keyboard.press('ArrowUp');
	await expect(list.getByRole('alert')).toHaveCount(0);
	expect(await sleepRequests(page)).toEqual([['beta']]);
});

test('a workspace that cannot be cleared for sleep explains why', async ({ page }) => {
	await restoreWorkspaces(page, 'sleepWorkspace');
	await requestBetaSleep(page);
	// Insert mode is not something sleeping can clear, so there is no prompt.
	await page.evaluate(() =>
		window.rendererTest.settle('sleepWorkspace', 0, ['terminal', 'mode'])
	);
	await expect(page.getByRole('alert').filter({ hasText: 'Normal mode' })).toContainText(
		'Beta cannot sleep while it is outside Normal mode or waiting for a key.'
	);
	await expect(
		page.getByRole('tab', { name: 'Workspace Beta', exact: true })
	).not.toHaveAttribute('aria-description', 'Sleeping');
});
