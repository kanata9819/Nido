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

test('Git shows remote actions and refreshes the upstream after publishing', async ({ page }) => {
	await page.goto(`${origin}?view=git&defer=gitStatus,gitRemoteAction`);
	const panel = page.getByRole('region', { name: 'Git changes' });
	const refresh = panel.getByRole('button', { name: 'Refresh' });
	const fetch = panel.getByRole('button', { name: 'Fetch all' });
	const pull = panel.getByRole('button', { name: 'Pull' });
	const publish = panel.getByRole('button', { name: 'Publish branch' });
	const status = { root: '/alpha', branch: 'main', changes: [] };
	const remote = { branch: 'main', remote: 'origin', upstream: '' };
	const remoteCalls = (): Promise<unknown[]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter(({ method }) => method === 'gitRemoteAction')
				.map(({ args }) => args[1])
		);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), status);
	await expect(refresh).toBeEnabled();
	await expect(fetch).toHaveCount(0);
	await expect(publish).toHaveCount(0);

	await refresh.click();
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
		...status,
		remote
	});
	await expect(fetch).toBeEnabled();
	await expect(pull).toBeDisabled();
	await publish.click();
	await expect(publish).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest.calls.find(({ method }) => method === 'gitRemoteAction')
						?.args
			)
		)
		.toEqual(['alpha', 'push', remote]);
	await page.evaluate(() => window.rendererTest.settle('gitRemoteAction', 0, undefined));
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
		...status,
		remote: { ...remote, upstream: 'refs/heads/main' }
	});
	await expect(panel.getByRole('button', { name: 'Push' })).toBeEnabled();
	await expect(pull).toBeEnabled();
	await expect(panel.getByText('origin/main', { exact: true })).toBeVisible();
	await expect(panel.getByRole('status')).toHaveText('Published main.');
	await expect(panel.getByText('Up to date')).toHaveCount(0);

	// With commits to push and pull, both buttons stand out and carry the counts.
	await refresh.click();
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	const sync = { upstream: 'origin/main', head: 'a'.repeat(40), outgoing: ['b'.repeat(40)] };
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
		...status,
		remote: { ...remote, upstream: 'refs/heads/main' },
		sync: { ...sync, ahead: 2, behind: 1 }
	});
	const push = panel.getByRole('button', { name: 'Push' });
	await expect(push).toHaveText(/Push\s*2/);
	await expect(push).toHaveClass(/syncReady/);
	await expect(pull).toHaveText(/Pull\s*1/);
	await expect(pull).toHaveClass(/syncReady/);
	await expect(panel.getByLabel('2 to push · 1 to pull')).toBeVisible();
	await push.click();
	await expect.poll(async () => (await remoteCalls()).at(-1)).toBe('push');
	await page.evaluate(() => window.rendererTest.settle('gitRemoteAction', 0, undefined));
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
		...status,
		remote: { ...remote, upstream: 'refs/heads/main' },
		sync: { ...sync, outgoing: [], ahead: 0, behind: 1 }
	});
	await expect(panel.getByRole('status')).toHaveText('Pushed 2 commits to origin/main.');
	await expect(push).not.toHaveClass(/syncReady/);

	// From the list, f fetches, p pulls and P pushes, as in lazygit.
	const tracked = { ...remote, upstream: 'refs/heads/main' };
	const list = page.getByRole('listbox', { name: 'Changed files' });
	for (const [key, action] of [
		['f', 'fetch'],
		['p', 'pull'],
		['Shift+P', 'push']
	] as const) {
		await list.focus();
		await page.keyboard.press(key);
		await expect.poll(async () => (await remoteCalls()).at(-1)).toBe(action);
		await page.evaluate(
			(result) => window.rendererTest.settle('gitRemoteAction', 0, result),
			action === 'pull' ? 2 : undefined
		);
		await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
		await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
			...status,
			remote: tracked
		});
		await expect(fetch).toBeEnabled();
		if (action === 'pull') {
			await expect(panel.getByRole('status')).toHaveText(
				'Pulled 2 commits from origin/main.'
			);
		}
	}
	expect(await remoteCalls()).toEqual(['push', 'push', 'fetch', 'pull', 'push']);
});

test('a failed Pull still refreshes the branch comparison and keeps the error', async ({
	page
}) => {
	await page.goto(origin + '?view=git&defer=gitStatus,gitRemoteAction');
	const panel = page.getByRole('region', { name: 'Git changes' });
	const pending = (): Promise<string[]> =>
		page.evaluate(() => window.rendererTest.pending.map(({ method }) => method));
	const status = {
		root: '/alpha',
		branch: 'main',
		changes: [],
		remote: { branch: 'main', remote: 'origin', upstream: 'refs/heads/main' },
		sync: { upstream: 'origin/main', head: 'a'.repeat(40), ahead: 1, behind: 0, outgoing: [] }
	};
	await expect.poll(pending).toEqual(['gitStatus']);
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), status);
	const pull = panel.getByRole('button', { name: 'Pull' });
	await pull.click();
	await expect.poll(pending).toEqual(['gitRemoteAction']);
	await page.evaluate(() =>
		window.rendererTest.settle('gitRemoteAction', 0, 'Not possible to fast-forward.', true)
	);
	// A failed fast-forward can still fetch and advance origin/main.
	await expect.poll(pending).toEqual(['gitStatus']);
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
		...status,
		sync: { ...status.sync, head: 'b'.repeat(40), behind: 2 }
	});
	await expect(pull).toHaveText(/Pull\s*2/);
	await expect(panel.getByRole('alert')).toContainText('Not possible to fast-forward.');
});

test('Git shortcuts use the enabled state as soon as loading finishes', async ({ page }) => {
	await page.goto(`${origin}?view=git&defer=gitStatus`);
	const branches = page.getByRole('button', { name: 'Branches', exact: true });
	const list = page.getByRole('listbox', { name: 'Changed files' });
	await expect(branches).toBeDisabled();
	await expect(list).toBeFocused();
	await page.evaluate(() => {
		document.getElementById('root')!.dataset.panel = 'git';
		const changes = document.querySelector('[aria-label="Git changes"]')!;
		const list = document.querySelector('[role="listbox"]')!;
		const observer = new MutationObserver(() => {
			if (changes.getAttribute('aria-busy') === 'false') {
				observer.disconnect();
				list.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '3',
						bubbles: true,
						cancelable: true
					})
				);
			}
		});
		observer.observe(changes, { attributes: true, attributeFilter: ['aria-busy'] });
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] });
	});
	await expect(branches).toHaveAttribute('aria-current', 'page');
});

test('Git diff ignores an older response after selecting another file', async ({ page }) => {
	await page.goto(`${origin}?view=git&defer=gitDiff`);
	const list = page.getByRole('listbox', { name: 'Changed files' });
	await expect(list).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await list.press('j');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(2);
	await page.evaluate(() =>
		window.rendererTest.settle('gitDiff', 1, '@@ -1 +1 @@\n-old\n+SECOND_CONTENT')
	);
	await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
	await page.evaluate(() =>
		window.rendererTest.settle('gitDiff', 0, '@@ -1 +1 @@\n-old\n+STALE_CONTENT')
	);
	await expect(page.locator('[data-git-scroll="after"]')).toContainText('SECOND_CONTENT');
	await expect(page.locator('[data-git-scroll="after"]')).not.toContainText('STALE_CONTENT');
});

test('Git diff shows which version lacks a final newline in both layouts', async ({ page }) => {
	await page.goto(origin + '?view=git&defer=gitDiff');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some(({ method }) => method === 'gitDiff')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'gitDiff',
			0,
			'@@ -1 +1 @@\n-same text\n\\ No newline at end of file\n+same text\n'
		)
	);
	const before = page.locator('[data-git-scroll="before"]');
	const after = page.locator('[data-git-scroll="after"]');
	const marker = 'No newline at end of file';
	await expect(before.getByText(marker, { exact: true })).toBeVisible();
	await expect(after.getByText(marker, { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Inline', exact: true }).click();
	const rows = after.locator('[data-diff-row]');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0).getByText(marker, { exact: true })).toBeVisible();
	await expect(rows.nth(1).getByText(marker, { exact: true })).toHaveCount(0);
});

test('Git page scrolling returns to the same position with an odd viewport height', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=gitDiff`);
	await page
		.getByRole('navigation')
		.getByRole('button', { name: 'Source control', exact: true })
		.click();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'gitDiff',
			0,
			'@@ -1,500 +1,500 @@\n' + Array.from({ length: 500 }, (_, i) => ` row ${i}`).join('\n')
		)
	);
	await page.addStyleTag({
		content: 'pre[data-git-scroll] { flex: none; height: 335px; padding: 0; }'
	});
	for (const side of ['before', 'after']) {
		const preview = page.locator(`[data-git-scroll="${side}"]`);
		expect(await preview.evaluate((node) => node.clientHeight)).toBe(335);
		await preview.focus();
		for (const [down, up, distance] of [
			['Control+d', 'Control+u', 168],
			['Control+f', 'Control+b', 335]
		] as const) {
			for (let step = 0; step < 3; step++) {
				await preview.press(down);
				await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(distance);
				await preview.press(up);
				await expect.poll(() => preview.evaluate((node) => node.scrollTop)).toBe(0);
			}
		}
	}
});

test('Git staging keeps the reviewed file selected and commits only staged changes', async ({
	page
}) => {
	await page.goto(`${origin}?view=git&defer=gitStatus,gitStage,gitCommit`);
	await page.addStyleTag({ content: '#root { display: flex; flex-direction: column; }' });
	const path = 'crate/chibi/src/screen/renderer.rs';
	const first = { path: 'src/main.rs', status: 'M', staged: false };
	const reviewed = { path, status: 'M', staged: false };
	const status = { root: '/alpha', branch: 'main', changes: [first, reviewed] };
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), status);
	const list = page.getByRole('listbox', { name: 'Changed files' });
	const input = page.getByRole('textbox', { name: 'Commit message' });
	const commit = page.getByRole('button', { name: 'Commit staged', exact: true });
	const preview = page.locator('[data-git-preview]');
	await expect(commit).toBeDisabled();
	await expect(input).toHaveAccessibleDescription('Stage changes to include them in the commit.');
	const file = list.getByRole('option', { name: path, exact: true });
	await expect(file.locator('strong')).toHaveText('renderer.rs');
	await expect(file.locator('small')).toHaveText('crate/chibi/src/screen');
	await file.click();
	await input.fill('Improve rendering');
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'gitStatus')
						.length
			)
		)
		.toBe(1);
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
		...status,
		changes: [first, reviewed, { ...reviewed, staged: true }]
	});
	await expect(preview.getByRole('button', { name: 'Stage (s)', exact: true })).toBeEnabled();

	for (const staged of [true, false]) {
		await list.focus();
		await list.press(staged ? 's' : 'u');
		await expect(input).toHaveAttribute('readonly', '');
		await list.press(staged ? 's' : 'u');
		expect(
			await page.evaluate(() =>
				window.rendererTest.pending
					.filter((call) => call.method === 'gitStage')
					.map((call) => call.args)
			)
		).toEqual([['alpha', path, !staged]]);
		await page.evaluate(() => window.rendererTest.settle('gitStage', 0, undefined));
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.rendererTest?.pending.filter((call) => call.method === 'gitStatus')
							.length
				)
			)
			.toBe(1);
		await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
			...status,
			changes: [first, { ...reviewed, staged }]
		});
		await expect(list.getByRole('option', { selected: true })).toHaveAccessibleName(path);
		await expect(
			preview.getByRole('button', { name: staged ? 'Unstage (u)' : 'Stage (s)', exact: true })
		).toBeEnabled();
		await expect(commit).toBeEnabled({ enabled: staged });
		await expect(input).toHaveValue('Improve rendering');
	}

	await list.press('s');
	await page.evaluate(() => window.rendererTest.settle('gitStage', 0, undefined));
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'gitStatus')
						.length
			)
		)
		.toBe(1);
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
		...status,
		changes: [first, { ...reviewed, staged: true }]
	});
	await expect(input).toHaveAccessibleDescription('Only staged changes (1) will be committed.');
	await expect(page.getByRole('heading', { name: 'Staged changes', exact: true })).toHaveText(
		'Staged changes1'
	);
	await expect(page.getByRole('heading', { name: 'Changes', exact: true })).toHaveText(
		'Changes1'
	);
	await commit.click();
	await input.press('Control+Enter');
	expect(
		await page.evaluate(() =>
			window.rendererTest.pending
				.filter((call) => call.method === 'gitCommit')
				.map((call) => call.args)
		)
	).toEqual([['alpha', 'Improve rendering']]);
	await page.evaluate(() =>
		window.rendererTest.settle('gitCommit', 0, 'Committed Improve rendering')
	);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'gitStatus')
						.length
			)
		)
		.toBe(1);
	await page.evaluate((status) => window.rendererTest.settle('gitStatus', 0, status), {
		...status,
		changes: [first]
	});
	await expect(input).toHaveValue('');
	await expect(list.getByRole('option')).toHaveCount(1);
	await expect(list.getByRole('option', { name: first.path })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('status')).toHaveText('Committed Improve rendering');
	await expect(commit).toBeDisabled();
});

test('Git commit failures preserve the draft and it survives switching views', async ({ page }) => {
	await page.goto(`${origin}?view=git&defer=gitStatus,gitCommit`);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'main',
			changes: [{ path: 'new name.ts', original: 'old name.ts', status: 'R', staged: true }]
		})
	);
	const input = page.getByRole('textbox', { name: 'Commit message' });
	await expect(input).toHaveAccessibleDescription(
		'Enter a message to commit staged changes (1).'
	);
	await expect(page.getByRole('option', { name: 'new name.ts' })).toHaveAttribute(
		'title',
		'old name.ts → new name.ts'
	);
	await input.fill('Rename the module');
	await input.press('Control+Enter');
	await expect(input).toHaveAttribute('readonly', '');
	await page.evaluate(() =>
		window.rendererTest.settle('gitCommit', 0, 'Commit hook rejected the message.', true)
	);
	await expect(page.getByRole('alert')).toHaveText('Commit hook rejected the message.');
	await expect(input).toHaveValue('Rename the module');
	await expect(input).not.toHaveAttribute('readonly', '');
	await page.getByRole('button', { name: 'History', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'gitStatus')
						.length
			)
		)
		.toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
	);
	await page.getByRole('button', { name: 'Changes', exact: true }).click();
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] })
	);
	await expect(input).toHaveValue('Rename the module');
	await expect(input).toHaveAccessibleDescription('No changes to commit.');
	await expect(page.getByText('Working tree clean.', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stage all (S)', exact: true })).toBeDisabled();
	await page.getByText('Keyboard shortcuts', { exact: true }).click();
	await expect(
		page.getByText(
			'j/k Select · s Stage · S Stage all · u Unstage · r Refresh · c Message · f Fetch · p Pull · P Push · Esc Close',
			{ exact: true }
		)
	).toBeVisible();
});

test('Git keeps the commit input reachable while typing in a small window', async ({ page }) => {
	await page.setViewportSize({ width: 850, height: 560 });
	await page.goto(`${origin}?view=git`);
	await page.addStyleTag({
		content: '#root { display: flex; flex-direction: column; height: 350px; }'
	});
	const list = page.getByRole('listbox', { name: 'Changed files' });
	const input = page.getByRole('textbox', { name: 'Commit message' });
	await list.focus();
	await list.press('c');
	await input.fill('A commit message that stays visible');
	await expect(input).toBeInViewport({ ratio: 1 });
	await input.press('End');
	await input.press('!');
	await expect(input).toBeInViewport({ ratio: 1 });
	await expect(input).toHaveValue('A commit message that stays visible!');
	await list.focus();
	await expect(list.getByRole('option', { selected: true })).toBeInViewport();
	await list.press('j');
	await expect(list.getByRole('option', { name: 'second.ts' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(list.getByRole('option', { selected: true })).toBeInViewport();
	await list.press('c');
	await expect(input).toBeInViewport({ ratio: 1 });
	expect(await page.locator('#root').evaluate((node) => node.scrollTop)).toBe(0);
});

test('Git keyboard help stays in the modal focus cycle', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	await page
		.getByRole('navigation')
		.getByRole('button', { name: 'Source control', exact: true })
		.click();
	const dialog = page.locator('[data-panel="git"]');
	const help = dialog.locator('summary');
	// The views sit in the heading, so the cycle wraps from the help to the first view.
	const first = dialog.getByRole('button', { name: 'Changes', exact: true });
	await expect(
		dialog.locator('[class*="paletteHeading"]').getByRole('navigation', { name: 'Git views' })
	).toBeVisible();
	await page.getByLabel('Git diff', { exact: true }).focus();
	await page.keyboard.press('Tab');
	await expect(help).toBeFocused();
	await help.press('Enter');
	await expect(dialog.locator('details')).toHaveAttribute('open', '');
	await help.press('Tab');
	await expect(first).toBeFocused();
	await first.press('Shift+Tab');
	await expect(help).toBeFocused();
});

test('Git history marks unpushed commits and the upstream, with the ahead and behind counts', async ({
	page
}) => {
	await page.goto(`${origin}?view=git&defer=gitStatus,gitHistory`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	const status = { root: '/alpha', branch: 'main', changes: [] };
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), status);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	const hash = (index: number): string => String(index).repeat(40);
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	expect(
		await page.evaluate(() => window.rendererTest.pending.map(({ args }) => args[1]))
	).toEqual([true]);
	await page.evaluate((next) => window.rendererTest.settle('gitStatus', 0, next), {
		...status,
		remote: { branch: 'main', remote: 'origin', upstream: 'refs/heads/main' },
		sync: {
			upstream: 'origin/main',
			head: hash(3),
			ahead: 2,
			behind: 1,
			outgoing: [hash(1), hash(2)]
		}
	});
	await expect.poll(() => page.evaluate(() => window.rendererTest.pending.length)).toBe(1);
	await page.evaluate(
		(commits) => window.rendererTest.settle('gitHistory', 0, { total: 3, commits }),
		[1, 2, 3].map((index) => ({
			hash: hash(index),
			subject: `Commit ${index}`,
			author: 'Ada',
			date: '2026-01-01'
		}))
	);
	await expect(page.getByText('2 ahead of origin/main · 1 behind')).toBeVisible();
	await expect(page.getByLabel('2 to push · 1 to pull')).toBeVisible();
	const rows = page.getByRole('listbox', { name: 'Commit history' }).getByRole('option');
	await expect(rows.nth(0)).toContainText('Not pushed');
	await expect(rows.nth(1)).toContainText('Not pushed');
	await expect(rows.nth(2)).not.toContainText('Not pushed');
	await expect(rows.nth(2)).toContainText('origin/main');
});

test('Git history counts all commits and supports paging without reloading the first page', async ({
	page
}) => {
	await page.goto(`${origin}?view=git&defer=gitHistory`);
	await page.addStyleTag({ content: '#root { display: flex; flex-direction: column; }' });
	await page.getByRole('button', { name: 'History', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitHistory', 0, {
			total: 101,
			commits: Array.from({ length: 100 }, (_, index) => ({
				hash: index.toString(16).padStart(40, '0'),
				subject: `Commit ${index}`,
				author: 'Ada',
				date: '2026-01-01'
			}))
		})
	);
	await expect(page.getByText('Commits: 101', { exact: true })).toBeVisible();
	const list = page.getByRole('listbox', { name: 'Commit history' });
	const steps = await list.evaluate((node) => {
		const row = node.querySelector('[role="option"]')!;
		const rows = node.clientHeight / row.getBoundingClientRect().height;
		return { half: Math.max(1, Math.floor(rows / 2)), full: Math.max(1, Math.floor(rows)) };
	});
	await list.focus();
	for (const [key, index] of [
		['Control+d', steps.half],
		['Control+u', 0],
		['Control+f', steps.full],
		['Control+b', 0],
		['PageDown', steps.full],
		['PageUp', 0],
		['G', 99],
		['Control+d', 99],
		['g', 0],
		['Control+u', 0]
	] as const) {
		await list.press(key);
		await expect(list).toHaveAttribute('aria-activedescendant', `git-entry-${index}`);
		await expect(list.getByRole('option', { selected: true })).toBeInViewport();
		await expect(
			page.getByRole('heading', { name: `Commit ${index}`, exact: true })
		).toBeVisible();
	}
	await page.screenshot({ path: 'test-results/git-history-keyboard.png' });
	await page.getByRole('button', { name: 'Load older commits' }).click();
	await expect
		.poll(() => page.evaluate(() => window.rendererTest?.pending[0]?.args.slice(1)))
		.toEqual([100, '0'.repeat(40)]);
	await list.press('Control+d');
	await expect(list).toHaveAttribute('aria-activedescendant', 'git-entry-0');
	await page.evaluate(() =>
		window.rendererTest.settle('gitHistory', 0, {
			total: 101,
			commits: [
				{ hash: 'f'.repeat(40), subject: 'Older commit', author: 'Ada', date: '2025-01-01' }
			]
		})
	);
	await expect(
		page.getByRole('listbox', { name: 'Commit history' }).getByRole('option')
	).toHaveCount(101);
	await expect(page.getByRole('button', { name: 'Load older commits' })).toHaveCount(0);
	await expect(page.getByText('Commits: 101', { exact: true })).toBeVisible();
	await list.press('G');
	await expect(list).toHaveAttribute('aria-activedescendant', 'git-entry-100');
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'gitHistory').length
		)
	).toBe(2);
	await page.getByRole('button', { name: 'Changes', exact: true }).click();
	await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeVisible();
	await page.getByRole('button', { name: 'History', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending[0]?.args[1])).toBe(0);
	await expect(page.getByRole('button', { name: 'History', exact: true })).toBeDisabled();
	await page.evaluate(() =>
		window.rendererTest.settle('gitHistory', 0, { commits: [], total: 0 })
	);
	await expect(page.getByRole('button', { name: 'History', exact: true })).toBeEnabled();
	await expect(page.getByText('Commits: 0', { exact: true })).toBeVisible();
	await list.press('Control+d');
	await expect(list).not.toHaveAttribute('aria-activedescendant');
});

for (const [view, method, action, emptyText] of [
	['History', 'gitHistory', 'Open commit (Enter)', 'No commits yet.'],
	['Branches', 'gitBranches', 'Switch branch (Enter)', 'No branches yet. Press n to create one.']
] as const) {
	test(`Git ${view} stops offering old entries when refresh fails and can retry`, async ({
		page
	}) => {
		await page.goto(`${origin}?view=git&defer=${method}`);
		await page.getByRole('button', { name: view, exact: true }).click();
		const list = page.getByRole('listbox', {
			name: view === 'History' ? 'Commit history' : 'Branches'
		});
		const rows = list.getByRole('option');
		const button = page.getByRole('button', { name: action, exact: true });
		const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
		const pending = async (): Promise<void> => {
			await expect
				.poll(() =>
					page.evaluate(
						(name) => window.rendererTest.pending.some(({ method }) => method === name),
						method
					)
				)
				.toBe(true);
		};
		const finish = async (name: string): Promise<void> => {
			await pending();
			await page.evaluate(
				({ method, name }) =>
					window.rendererTest.settle(
						method,
						0,
						method === 'gitHistory'
							? {
									total: 2,
									commits: [
										{
											hash: 'a'.repeat(40),
											subject: name,
											author: 'Ada',
											date: '2026-01-01'
										}
									]
								}
							: [{ name, current: false, remote: false }]
					),
				{ method, name }
			);
		};
		await finish('old-entry');
		await expect(rows.first()).toContainText('old-entry');
		await expect(button).toBeEnabled();
		await refresh.click();
		await pending();
		await rows.first().dblclick();
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls.filter(
					({ method }) => method === 'gitCommitFiles' || method === 'gitSwitch'
				)
			)
		).toHaveLength(0);
		await page.evaluate(
			(method) => window.rendererTest.settle(method, 0, 'Git refresh failed', true),
			method
		);
		await expect(page.getByRole('alert')).toHaveText('Git refresh failed');
		await expect(rows).toHaveCount(0);
		await expect(button).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Load older commits' })).toHaveCount(0);
		await expect(page.getByText(emptyText, { exact: true })).toHaveCount(0);
		await refresh.click();
		await finish('fresh-entry');
		await expect(rows.first()).toContainText('fresh-entry');
		await expect(button).toBeEnabled();
	});
}

test('A new diff clears the previous highlighting failure', async ({ page }) => {
	await page.goto(`${origin}?view=highlight&defer=highlightSources`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('highlightSources', 0, 'unavailable', true)
	);
	await expect(page.getByRole('status')).toHaveText('Syntax highlighting unavailable');
	await page.evaluate(() => window.rendererTest.render({ path: 'second.ts' }));
	await expect(page.getByRole('status')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => window.rendererTest.settle('highlightSources', 0, [[], []]));
	await expect(page.locator('[data-git-scroll="after"]')).toContainText('after');
});

test('unchanged Git polls avoid commits while changed and removed badges still update', async ({
	page
}) => {
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	const status = {
		root: '/alpha',
		branch: 'main',
		changes: [{ path: 'first.ts', status: 'M', staged: false }]
	};
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate((value) => window.rendererTest.settle('gitStatus', 0, value), status);
	const badges = page.getByRole('status');
	await expect(badges).toContainText('Modified');
	const commits = await badges.getAttribute('data-commits');
	await page.evaluate((value) => {
		window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
		window.rendererTest.settle('gitStatus', 0, value);
	}, status);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(0);
	expect(await badges.getAttribute('data-commits')).toBe(commits);
	await page.evaluate(
		(value) => {
			window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
			window.rendererTest.settle('gitStatus', 0, value);
		},
		{ ...status, changes: [{ ...status.changes[0], staged: true }] }
	);
	await expect(badges).toContainText('(staged)');
	await page.evaluate(
		(value) => {
			window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
			window.rendererTest.settle('gitStatus', 0, value);
		},
		{ ...status, changes: [] }
	);
	await expect(badges).toHaveText('{}');
});

test('failed Git refreshes preserve badges until a successful status replaces them', async ({
	page
}) => {
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'main',
			changes: [{ path: 'first.ts', status: 'M', staged: false }]
		})
	);
	const badges = page.getByRole('status');
	await expect(badges).toContainText('Modified');
	const commits = await badges.getAttribute('data-commits');
	await page.evaluate(() => {
		window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
		window.rendererTest.settle('gitStatus', 0, 'Git temporarily unavailable', true);
	});
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(0);
	await expect(badges).toContainText('Modified');
	await expect(badges).toHaveAttribute('data-commits', commits!);
	await page.evaluate(() => {
		window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] });
	});
	await expect(badges).toHaveText('{}');
});

test('Git changes during an in-flight poll trigger a fresh request without waiting for the next poll', async ({
	page
}) => {
	await pauseRendererClock(page);
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	await page.clock.runFor(250);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => {
		window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
		window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' });
		window.rendererTest.settle('gitStatus', 0, { root: '/alpha', branch: 'main', changes: [] });
	});
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'main',
			changes: [{ path: 'first.ts', status: 'M', staged: false }]
		})
	);
	await expect(page.getByRole('status')).toContainText('Modified');
	expect(
		await page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
		)
	).toBe(2);
});

test('Git badge polling backs off while idle and refreshes immediately on activity', async ({
	page
}) => {
	await page.clock.install();
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	const calls = (): Promise<number> =>
		page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
		);
	const settle = async (): Promise<void> => {
		await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
		await page.evaluate(() =>
			window.rendererTest.settle('gitStatus', 0, {
				root: '/alpha',
				branch: 'main',
				changes: []
			})
		);
		await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(0);
	};
	await page.clock.runFor(250);
	await settle();
	await page.clock.runFor(3000);
	await settle();
	expect(await calls()).toBe(2);
	await page.clock.runFor(3000);
	expect(await calls()).toBe(2);
	await page.clock.runFor(3000);
	await settle();
	expect(await calls()).toBe(3);
	await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
	await settle();
	expect(await calls()).toBe(4);
	await page.clock.runFor(3000);
	await settle();
	expect(await calls()).toBe(5);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await settle();
	expect(await calls()).toBe(6);
	let expected = 6;
	for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
		await page.clock.runFor(delay - 1);
		expect(await calls()).toBe(expected);
		await page.clock.runFor(1);
		await settle();
		expect(await calls()).toBe(++expected);
	}
});

test('Git status polling outside a repository backs off instead of starting Git every 3 seconds', async ({
	page
}) => {
	await page.clock.install();
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	const calls = (): Promise<number> =>
		page.evaluate(
			() => window.rendererTest.calls.filter((call) => call.method === 'gitStatus').length
		);
	const fail = async (): Promise<void> => {
		await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
		await page.evaluate(() =>
			window.rendererTest.settle('gitStatus', 0, new Error('Not a git repository'), true)
		);
		await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(0);
	};
	await page.clock.runFor(250);
	await fail();
	let expected = 1;
	for (const delay of [3000, 6000, 12000, 24000, 30000]) {
		await page.clock.runFor(delay - 1);
		expect(await calls()).toBe(expected);
		await page.clock.runFor(1);
		await fail();
		expect(await calls()).toBe(++expected);
	}
	// Activity, such as running git init, is still noticed at once.
	await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
	await fail();
	expect(await calls()).toBe(++expected);
});

test('Git badges clear immediately when switching workspaces', async ({ page }) => {
	await page.goto(`${origin}?view=badges&defer=gitStatus`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'main',
			changes: [{ path: 'first.ts', status: 'M', staged: false }]
		})
	);
	await expect(page.getByRole('status')).toContainText('Modified');
	await page.evaluate(() => window.rendererTest.render({ workspaceId: 'beta' }));
	await expect(page.getByRole('status')).toHaveText('{}');
	await expect
		.poll(() => page.evaluate(() => window.rendererTest?.pending[0]?.args[0]))
		.toBe('beta');
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, 'Not a Git repository', true)
	);
	await expect(page.getByRole('status')).toHaveText('{}');
});

test('Git errors show their reason alone, translated, in the panel and the diff', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
	await page.goto(`${origin}?view=app&defer=gitStatus,gitDiff,gitStage`);
	await expect(
		page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
	).toBeVisible();
	const settleStatus = (): Promise<void> =>
		page.evaluate(() => {
			for (const call of window.rendererTest.pending.filter(
				(entry) => entry.method === 'gitStatus'
			)) {
				void call;
				window.rendererTest.settle('gitStatus', 0, {
					root: '/alpha',
					branch: 'main',
					changes: [{ path: 'renamed.txt', status: 'R', staged: true }]
				});
			}
		});
	await page.keyboard.press('Control+Shift+g');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'gitStatus')
			)
		)
		.toBe(true);
	await settleStatus();
	// Electron wraps an error from the main process in the name of the IPC channel.
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'gitDiff')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'gitDiff',
			0,
			new Error(
				"Error invoking remote method 'nido:gitDiff': Error: This change no longer exists. Refresh the changes list."
			),
			true
		)
	);
	const preview = page.locator('[data-git-preview]');
	await expect(preview).toContainText('この変更はもうありません。変更の一覧を更新してください。');
	await expect(preview).not.toContainText('invoking remote method');
	// The change is staged, so u unstages it.
	await page.getByRole('option', { name: 'renamed.txt' }).click();
	await page.keyboard.press('u');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'gitStage')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'gitStage',
			0,
			new Error(
				"Error invoking remote method 'nido:gitStage': Error: Git is not installed or is not on PATH."
			),
			true
		)
	);
	await settleStatus();
	await expect(page.getByRole('alert')).toHaveText(
		'Gitがインストールされていないか、PATHにありません。'
	);
});

test('the status bar shows the checked-out branch and opens Source control from it', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=gitStatus`);
	const status = page.locator('footer');
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'gitStatus')
			)
		)
		.toBe(true);
	// Outside a repository nothing is shown.
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, new Error('Not a git repository'), true)
	);
	await expect(status.getByRole('button', { name: /^Branch:/ })).toHaveCount(0);
	// A change of files reads the status again, here after a branch switch.
	await page.evaluate(() => window.rendererTest.emit({ type: 'filesChanged', id: 'alpha' }));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.pending.some((call) => call.method === 'gitStatus')
			)
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.settle('gitStatus', 0, {
			root: '/alpha',
			branch: 'feature/status-bar',
			changes: []
		})
	);
	const branch = status.getByRole('button', { name: 'Branch: feature/status-bar' });
	await expect(branch).toContainText('feature/status-bar');
	await branch.click();
	await expect(page.locator('[data-panel="git"]')).toBeVisible();
});
