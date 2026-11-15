import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
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

test('Notification replacement resets fading and cancels the previous dismissal', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=notification`);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'notification',
			id: 'alpha',
			severity: 'info',
			title: 'First',
			message: 'first notice'
		})
	);
	await expect(page.getByRole('status')).toHaveText(/first notice/);
	await page.clock.runFor(2000);
	await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'true');
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'notification',
			id: 'alpha',
			severity: 'info',
			title: 'Second',
			message: 'second notice'
		})
	);
	await expect(page.getByRole('status')).toHaveAttribute('data-fading', 'false');
	await page.clock.runFor(300);
	await expect(page.getByRole('status')).toHaveText(/second notice/);
	await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
	await expect(page.getByRole('status')).toHaveCount(0);
});

test('warnings and errors stay long enough to read, and Escape still dismisses them', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=notification`);
	const notify = (severity: 'warning' | 'error'): Promise<void> =>
		page.evaluate(
			(severity) =>
				window.rendererTest.emit({
					type: 'notification',
					id: 'alpha',
					severity,
					title: 'Time Machine',
					message: 'Save this file to keep your changes.'
				}),
			severity
		);
	const notice = page.getByRole('alert');
	for (const severity of ['warning', 'error'] as const) {
		await notify(severity);
		await expect(notice).toHaveText(/Save this file/);
		// An informational notice would be gone by now.
		await page.clock.runFor(7900);
		await expect(notice).toHaveAttribute('data-fading', 'false');
		await page.clock.runFor(100);
		await expect(notice).toHaveAttribute('data-fading', 'true');
		await page.clock.runFor(300);
		await expect(notice).toHaveCount(0);
	}
	await notify('warning');
	await expect(notice).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(notice).toHaveCount(0);
});

test('an error notice stays long enough to read, and Escape still dismisses it', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
	const show = (): Promise<void> =>
		page.evaluate(() =>
			window.rendererTest.emit({
				type: 'error',
				id: 'alpha',
				message:
					"Error: Error invoking remote method 'nido:gitCommit': Error: Stage changes before committing."
			})
		);
	const error = page.getByRole('alert').filter({ hasText: 'Stage changes before committing.' });
	await show();
	await expect(error).toHaveText('Stage changes before committing.');
	// An informational notice would be gone by now.
	await page.clock.runFor(7900);
	await expect(error).toHaveAttribute('data-fading', 'false');
	await page.clock.runFor(100);
	await expect(error).toHaveAttribute('data-fading', 'true');
	await page.clock.runFor(300);
	await expect(error).toHaveCount(0);
	await show();
	await expect(error).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(error).toHaveCount(0);
});

test('state patches coalesce without dropping diagnostics, other sessions or optional clears', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=session-updates`);
	await page.evaluate(() => {
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [{ id: 1, name: '/alpha/main.rs', modified: false }],
				current: 1,
				mode: 'i',
				line: 1,
				column: 1,
				filetype: 'rust',
				lineEnding: 'LF',
				problems: [
					{
						path: '/alpha/main.rs',
						line: 1,
						column: 1,
						severity: 1,
						message: 'error',
						source: 'rustc'
					}
				]
			}
		});
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { line: 9, column: 4, lspProgress: 'Indexing' }
		});
		window.rendererTest.emit({ type: 'statePatch', id: 'beta', state: { line: 3 } });
	});
	await page.clock.runFor(50);
	const states = await page.getByRole('status').textContent();
	expect(JSON.parse(states!)).toMatchObject({
		alpha: {
			line: 9,
			column: 4,
			mode: 'i',
			lineEnding: 'LF',
			problems: [{ message: 'error' }],
			buffers: [{ name: '/alpha/main.rs' }],
			lspProgress: 'Indexing'
		},
		beta: { line: 3, buffers: [], mode: 'n' }
	});
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { lineEnding: undefined, mode: 'n' }
		})
	);
	await page.clock.runFor(50);
	const next = JSON.parse((await page.getByRole('status').textContent())!);
	expect(next.alpha.lineEnding).toBeUndefined();
	expect(next.alpha.mode).toBe('n');
	expect(next.alpha.problems).toHaveLength(1);
});

test('Explorer discards obsolete manual refreshes and loads started before a file change', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=files`);
	await expect
		.poll(() =>
			page.evaluate(
				() => window.rendererTest?.pending.filter((call) => call.method === 'files').length
			)
		)
		.toBe(1);
	const tree = page.getByRole('tree', { name: 'Project files' });
	const initial = [{ name: 'initial.txt', path: 'initial.txt', directory: false }];
	await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
	await expect(tree).toContainText('initial.txt');
	const refresh = page.getByRole('button', { name: 'Refresh files' });
	await refresh.click();
	await refresh.click();
	const fresh = [{ name: 'fresh.txt', path: 'fresh.txt', directory: false }];
	await page.evaluate((value) => window.rendererTest.settle('files', 1, value), fresh);
	await expect(tree).toContainText('fresh.txt');
	await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
	await expect(tree).toContainText('fresh.txt');
	await expect(tree).not.toContainText('initial.txt');
	await refresh.click();
	await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
	await expect
		.poll(() =>
			page.evaluate(
				() => window.rendererTest?.pending.filter((call) => call.method === 'files').length
			)
		)
		.toBe(2);
	await page.evaluate((value) => window.rendererTest.settle('files', 1, value), fresh);
	await page.evaluate((value) => window.rendererTest.settle('files', 0, value), initial);
	await expect(tree).toContainText('fresh.txt');
	await expect(tree).not.toContainText('initial.txt');
});

test('settings ignore obsolete failures after a newer request for the same value succeeds', async ({
	page
}) => {
	await page.goto(`${origin}?view=settings&defer=setWordWrap`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.render({
			settings: {
				clipboardSharing: true,
				relativeLineNumbers: true,
				editorConfig: true,
				methodSeparators: false,
				wordWrap: true
			}
		})
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(2);
	await page.evaluate(() =>
		window.rendererTest.render({
			settings: {
				clipboardSharing: true,
				relativeLineNumbers: true,
				editorConfig: true,
				methodSeparators: false,
				wordWrap: false
			}
		})
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(3);
	await page.evaluate(() => {
		window.rendererTest.settle('setWordWrap', 2, undefined);
		window.rendererTest.settle('setWordWrap', 0, 'Obsolete request failed', true);
		window.rendererTest.render({
			workspaces: [{ id: 'alpha', root: '/alpha', name: 'Renamed' }]
		});
	});
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'setWordWrap').length
		)
	).toBe(3);
});

test('a failed file operation shows its reason without the IPC channel', async ({ page }) => {
	await page.goto(`${origin}?view=explorer&defer=fileAction`);
	await page.evaluate(() =>
		window.rendererTest.render({
			request: { action: 'createFile', path: '', title: 'New file', value: 'taken.ts' }
		})
	);
	const field = page.getByRole('textbox');
	await expect(field).toHaveValue('taken.ts');
	await field.press('Enter');
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	// Electron wraps an error from the main process in the name of the IPC channel.
	await page.evaluate(() =>
		window.rendererTest.settle(
			'fileAction',
			0,
			new Error(
				"Error invoking remote method 'nido:fileAction': Error: A file or folder already exists at that path."
			),
			true
		)
	);
	await expect(page.getByRole('alert')).toHaveText(
		'A file or folder already exists at that path.'
	);
});

test('Explorer requests reset their field and clear the previous validation error', async ({
	page
}) => {
	await page.goto(`${origin}?view=explorer`);
	await expect(page.getByRole('dialog', { name: 'Explorer commands' })).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.render({
			request: {
				action: 'rename',
				path: 'first.ts',
				title: 'Rename',
				value: 'first.ts'
			}
		})
	);
	const field = page.getByRole('textbox');
	await expect(field).toHaveValue('first.ts');
	await field.fill('folder/new.ts');
	await page.getByRole('button', { name: 'Apply', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Use Move to');
	await page.evaluate(() =>
		window.rendererTest.render({
			request: {
				action: 'createFile',
				path: '',
				title: 'New file',
				value: 'src/new.ts'
			}
		})
	);
	await expect(field).toHaveValue('src/new.ts');
	await expect(field).toBeFocused();
	await expect(page.getByRole('alert')).toHaveCount(0);
});
