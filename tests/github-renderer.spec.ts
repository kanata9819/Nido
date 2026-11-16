import { test, expect, type Page } from './helpers/renderer-test';
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

/** The calls the page made to `method`, with their arguments. */
function calls(page: Page, method: string): Promise<unknown[][]> {
	return page.evaluate(
		(name) =>
			window.rendererTest.calls
				.filter((call) => call.method === name)
				.map((call) => call.args),
		method
	);
}

test('pull requests list, open with their overview, and take comments from the keyboard', async ({
	page
}) => {
	await page.goto(`${origin}?view=github`);
	const list = page.getByRole('listbox', { name: 'Pull requests' });
	await expect(list).toBeFocused();
	await expect(list.getByRole('option')).toHaveCount(2);
	// The preview follows the selection.
	await expect(page.getByRole('heading', { name: 'Add sign-in' })).toBeVisible();
	await page.keyboard.press('j');
	await expect(page.getByRole('heading', { name: 'Fix typo' })).toBeVisible();
	await page.keyboard.press('k');

	// f cycles the filter.
	await page.keyboard.press('f');
	await expect(page.getByRole('combobox')).toHaveValue('mine');
	expect((await calls(page, 'githubPullRequests')).map((args) => args[1])).toEqual([
		'open',
		'mine'
	]);

	await page.keyboard.press('Enter');
	const overview = page.getByRole('region', { name: 'Pull request overview' });
	await expect(overview).toContainText('Adds sign-in.');
	await expect(overview).toContainText('Looks close.');
	await expect(overview.getByText('e2e')).toBeVisible();
	await expect(page.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	expect(await calls(page, 'githubPullRequestDiff')).toEqual([['alpha', 7]]);

	await page.keyboard.press('c');
	const comment = page.getByRole('textbox', { name: 'Comment on the pull request' });
	await expect(comment).toBeFocused();
	await page.keyboard.type('Ship it');
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	expect(await calls(page, 'githubComment')).toEqual([['alpha', 'pr', 7, 'Ship it']]);
	// The pull request is read again after the comment.
	expect((await calls(page, 'githubPullRequest')).length).toBe(2);

	// Esc leaves the pull request, then closes the page.
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	expect(await calls(page, 'onClose')).toEqual([]);
	await page.keyboard.press('Escape');
	expect(await calls(page, 'onClose')).toEqual([[]]);
});

test('a pull request file shows its diff and threads, which can be replied to and resolved', async ({
	page
}) => {
	await page.goto(`${origin}?view=github`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await expect(files).toBeFocused();
	await page.keyboard.press('j');
	const threads = page.getByRole('region', { name: 'Review threads' });
	await expect(threads).toContainText('Rename this?');
	await expect(threads).toContainText('Line 2');

	// Esc in a reply closes the reply only.
	await threads.getByRole('button', { name: 'Reply', exact: true }).click();
	const reply = page.getByRole('textbox', { name: 'Reply to the thread' });
	await expect(reply).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(reply).toHaveCount(0);
	await expect(threads).toBeVisible();

	await threads.getByRole('button', { name: 'Resolve', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Thread resolved.');
	expect(await calls(page, 'githubResolve')).toEqual([['alpha', 'PRRT_1', true]]);

	// c starts a thread on a line, of the new or the old side.
	await files.focus();
	await page.keyboard.press('c');
	const send = page.getByRole('button', { name: /^Comment/ });
	await page.getByRole('textbox', { name: /^Comment on line/ }).fill('Typo here');
	await expect(send).toBeDisabled();
	await page.getByRole('textbox', { name: 'Line number' }).fill('3x');
	await expect(page.getByRole('textbox', { name: 'Line number' })).toHaveValue('3');
	await page.getByRole('combobox').selectOption('LEFT');
	await send.click();
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	expect(await calls(page, 'githubLineComment')).toEqual([
		['alpha', 7, 'src/login.ts', 3, 'LEFT', 'Typo here']
	]);
});

test('reviews, merges and checkouts send their choices', async ({ page }) => {
	await page.goto(`${origin}?view=github`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await expect(files).toBeFocused();

	// An approval can be sent without text; requesting changes needs some.
	await page.keyboard.press('v');
	const submit = page.getByRole('button', { name: /^Submit review/ });
	await expect(submit).toBeEnabled();
	await page.getByRole('combobox').selectOption('request-changes');
	await expect(submit).toBeDisabled();
	await page.getByRole('textbox', { name: 'Review summary' }).fill('Add a test');
	await submit.click();
	await expect(page.getByRole('status')).toHaveText('Review submitted.');
	expect(await calls(page, 'githubReview')).toEqual([
		['alpha', 7, 'request-changes', 'Add a test']
	]);

	await files.focus();
	await page.keyboard.press('m');
	const merge = page.getByRole('form', { name: 'Merge pull request' });
	await expect(merge).toContainText('Some checks failed.');
	await merge.getByRole('combobox').selectOption('rebase');
	await merge.getByRole('checkbox', { name: 'Delete the branch on GitHub' }).uncheck();
	await merge.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Pull request merged.');
	expect(await calls(page, 'githubMerge')).toEqual([['alpha', 7, 'rebase', false]]);

	await files.focus();
	await page.keyboard.press('o');
	await expect(page.getByRole('status')).toHaveText('Checked out the pull request’s branch.');
	expect(await calls(page, 'githubCheckout')).toEqual([['alpha', 7]]);
	// The branch changed, so gh's status is read again.
	expect((await calls(page, 'githubStatus')).length).toBe(2);
});

test('issues open with their comments, and can be commented on and closed', async ({ page }) => {
	await page.goto(`${origin}?view=github`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	const list = page.getByRole('listbox', { name: 'Issues' });
	await expect(list).toBeFocused();
	await expect(page.getByRole('heading', { name: 'Crash on start' })).toBeVisible();
	await page.keyboard.press('Enter');
	const issue = page.getByRole('region', { name: 'Issue' });
	await expect(issue).toContainText('It crashes.');
	await expect(issue).toContainText('Can you share the log?');
	await expect(issue).toContainText('Assigned to octocat');

	await page.keyboard.press('c');
	await page.keyboard.type('Here it is');
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	expect(await calls(page, 'githubComment')).toEqual([['alpha', 'issue', 3, 'Here it is']]);

	await page.keyboard.press('x');
	await expect(page.getByRole('status')).toHaveText('Issue closed.');
	expect(await calls(page, 'githubSetIssueOpen')).toEqual([['alpha', 3, false]]);
});

test('a new pull request starts from the last commit and pushes the branch', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=gitHistory`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('3');
	const title = page.getByRole('textbox', { name: 'Title' });
	await expect(title).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.settle('gitHistory', 0, {
			commits: [{ hash: 'a'.repeat(40), author: 'dev', date: '', subject: 'Add sign-in' }],
			total: 1
		})
	);
	await expect(title).toHaveValue('Add sign-in');
	await expect(page.getByText('From feature/login into main')).toBeVisible();
	await page.getByRole('textbox', { name: 'Description' }).fill('Closes #3');
	await page.getByRole('checkbox', { name: 'Draft' }).check();
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeVisible();
	expect(await calls(page, 'githubCreatePullRequest')).toEqual([
		['alpha', 'Add sign-in', 'Closes #3', 'main', true]
	]);

	// The base cannot be the checked-out branch.
	await page.keyboard.press('3');
	await page.getByRole('textbox', { name: 'Base branch' }).fill('feature/login');
	await expect(page.getByRole('button', { name: /^Push and create/ })).toBeDisabled();
	await expect(page.getByText('Switch to a branch other than the base first.')).toBeVisible();
});

test('without a signed-in gh, the page explains how to sign in', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubStatus`);
	await expect(page.getByText('Connecting to GitHub…')).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.settle('githubStatus', 0, {
			installed: true,
			authenticated: false,
			message: 'Sign in with `gh auth login`, then refresh.'
		})
	);
	await expect(page.getByRole('heading', { name: 'Sign in to GitHub' })).toBeVisible();
	await expect(page.getByText('gh auth login', { exact: true })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'GitHub views' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Refresh' }).click();
	expect((await calls(page, 'githubStatus')).length).toBe(2);
});

test('the GitHub extension is off until enabled, then opens from the activity bar and Space Shift+G', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const rail = page.getByRole('navigation', { name: 'Navigation' });
	await expect(rail.getByRole('button', { name: 'Explorer' })).toBeVisible();
	await expect(rail.getByRole('button', { name: 'GitHub' })).toHaveCount(0);

	await page.keyboard.press('Control+Shift+x');
	const extensions = page.getByRole('region', { name: 'Extensions', exact: true });
	await extensions.getByRole('tab', { name: 'Other extensions', exact: true }).click();
	const search = extensions.getByRole('textbox', { name: 'Search other extensions' });
	await search.fill('pull request');
	const card = extensions.locator('[data-pack="github"]');
	await expect(card).toBeVisible();
	await expect(extensions.getByText('No extensions match your search.')).toHaveCount(0);
	await card.getByRole('checkbox', { name: 'Enable GitHub' }).check();
	await expect(card).toContainText('Signed in as octocat · octo/alpha');
	expect(await page.evaluate(() => localStorage.getItem('nido.githubEnabled'))).toBe('true');

	await rail.getByRole('button', { name: 'GitHub' }).click();
	const dialog = page.getByRole('dialog', { name: 'github palette' });
	const list = dialog.getByRole('listbox', { name: 'Pull requests' });
	await expect(list).toBeFocused();
	// Esc steps back out of an opened pull request before it closes the page.
	await page.keyboard.press('Enter');
	await expect(dialog.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);

	await page.keyboard.press('Space');
	// The Space menu lists it.
	await expect(page.getByRole('button', { name: /Shift\+G\s*GitHub/ })).toBeVisible();
	await page.keyboard.press('Shift+G');
	await expect(
		page.getByRole('dialog', { name: 'github palette' }).getByRole('listbox', {
			name: 'Pull requests'
		})
	).toBeFocused();
});

test('the overview and the issue preview take focus and their keys work there', async ({
	page
}) => {
	await page.goto(`${origin}?view=github`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await expect(files).toBeFocused();
	// Enter on Overview moves into it; Ctrl+H returns to the list and Ctrl+L comes back.
	await page.keyboard.press('Enter');
	const overview = page.getByRole('region', { name: 'Pull request overview' });
	await expect(overview).toBeFocused();
	await page.keyboard.press('Control+h');
	await expect(files).toBeFocused();
	await page.keyboard.press('Control+l');
	await expect(overview).toBeFocused();
	// The pull request's keys work from the overview.
	await page.keyboard.press('v');
	await expect(page.getByRole('textbox', { name: 'Review summary' })).toBeFocused();
	await page.keyboard.press('Escape');
	await overview.focus();
	await page.keyboard.press('c');
	await expect(page.getByRole('textbox', { name: 'Comment on the pull request' })).toBeFocused();
	// While typing, the keys are text.
	await page.keyboard.type('mov');
	await expect(page.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue(
		'mov'
	);
	await expect(page.getByRole('form', { name: 'Merge pull request' })).toHaveCount(0);
	expect(await calls(page, 'githubCheckout')).toEqual([]);

	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await page.keyboard.press('2');
	await expect(page.getByRole('listbox', { name: 'Issues' })).toBeFocused();
	await page.keyboard.press('Control+l');
	await expect(page.getByRole('region', { name: 'Issue' })).toBeFocused();
	await page.keyboard.press('x');
	await expect(page.getByRole('status')).toHaveText('Issue closed.');
});
