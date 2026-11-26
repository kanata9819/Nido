import type { Page } from '@playwright/test';
import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import type {} from './renderer/harness';
import type { IssueDetails, PullRequestDetails } from '../src/shared/github';

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
	expect(await calls(page, 'githubPullRequest')).toEqual([
		['alpha', 7, 'https://github.com/octo/alpha/pull/7']
	]);
	expect(await calls(page, 'githubPullRequestDiff')).toEqual([
		[
			'alpha',
			7,
			'a'.repeat(40),
			{
				url: 'https://github.com/octo/alpha/pull/7',
				baseRefName: 'main',
				baseRefOid: 'b'.repeat(40)
			}
		]
	]);

	await page.keyboard.press('c');
	const comment = page.getByRole('textbox', { name: 'Comment on the pull request' });
	await expect(comment).toBeFocused();
	await page.keyboard.type('Ship it');
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	expect(await calls(page, 'githubComment')).toEqual([
		['alpha', 'pr', 7, 'Ship it', 'https://github.com/octo/alpha/pull/7']
	]);
	// The pull request is read again after the comment.
	expect((await calls(page, 'githubPullRequest')).length).toBe(2);

	// Esc leaves the pull request, then closes the page.
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	expect(await calls(page, 'onClose')).toEqual([]);
	await page.keyboard.press('Escape');
	expect(await calls(page, 'onClose')).toEqual([[]]);
});

test('an unavailable diff leaves the pull request overview usable and can be retried', async ({
	page
}) => {
	await page.goto(`${origin}?view=github&defer=githubPullRequestDiff`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => calls(page, 'githubPullRequestDiff')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequestDiff', 0, new Error('HTTP 503'), true)
	);
	const overview = page.getByRole('region', { name: 'Pull request overview' });
	await expect(overview).toContainText('Adds sign-in.');
	await expect(overview).toContainText('Looks close.');
	await expect(page.getByRole('alert')).toContainText('HTTP 503');
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await files.getByRole('option', { name: 'src/login.ts' }).click();
	await expect(page.getByText('The diff is unavailable. Refresh to try again.')).toBeVisible();
	await page.keyboard.press('r');
	await expect.poll(() => calls(page, 'githubPullRequestDiff')).toHaveLength(2);
	await page.evaluate(() => window.rendererTest.settle('githubPullRequestDiff', 0, []));
	await expect(page.getByRole('region', { name: 'Review threads' })).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a refresh whose diff fails does not keep showing the earlier diff', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubPullRequestDiff`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => calls(page, 'githubPullRequestDiff')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequestDiff', 0, [
			[
				'src/login.ts',
				'diff --git a/src/login.ts b/src/login.ts\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1 +1 @@\n-before refresh\n+earlier diff line\n'
			]
		])
	);
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await files.getByRole('option', { name: 'src/login.ts' }).click();
	const preview = page.locator('[data-panel="github"] [data-git-preview]');
	await expect(preview).toContainText('earlier diff line');
	await page.keyboard.press('r');
	await expect.poll(() => calls(page, 'githubPullRequestDiff')).toHaveLength(2);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequestDiff', 0, new Error('HTTP 503'), true)
	);
	await expect(page.getByRole('alert')).toContainText('HTTP 503');
	await expect(page.getByText('The diff is unavailable. Refresh to try again.')).toBeVisible();
	await expect(preview).not.toContainText('earlier diff line');
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

	// A sent reply closes its form.
	await threads.getByRole('button', { name: 'Reply', exact: true }).click();
	await reply.fill('Done');
	await page.keyboard.press('Control+Enter');
	await expect(page.getByRole('status')).toHaveText('Reply posted.');
	expect(await calls(page, 'githubReply')).toEqual([
		['alpha', 'PRRT_1', 'Done', 'https://github.com/octo/alpha/pull/7']
	]);
	await expect(reply).toHaveCount(0);

	await threads.getByRole('button', { name: 'Resolve', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Thread resolved.');
	expect(await calls(page, 'githubResolve')).toEqual([
		['alpha', 'PRRT_1', true, 'https://github.com/octo/alpha/pull/7']
	]);

	// c starts a thread on a line, of the new or the old side.
	await files.focus();
	await page.keyboard.press('c');
	const send = page.getByRole('button', { name: /^Comment/ });
	await page.getByRole('textbox', { name: /^Comment on line/ }).fill('Typo here');
	await expect(send).toBeDisabled();
	// Without a line yet, the form can still be cancelled with its button.
	await expect(page.getByRole('button', { name: /^Cancel/ })).toBeEnabled();
	await page.getByRole('textbox', { name: 'Line number' }).fill('3x');
	await expect(page.getByRole('textbox', { name: 'Line number' })).toHaveValue('3');
	await page.getByRole('combobox').selectOption('LEFT');
	await send.click();
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	expect(await calls(page, 'githubLineComment')).toEqual([
		[
			'alpha',
			7,
			'src/login.ts',
			3,
			'LEFT',
			'Typo here',
			'a'.repeat(40),
			{
				url: 'https://github.com/octo/alpha/pull/7',
				baseRefName: 'main',
				baseRefOid: 'b'.repeat(40)
			}
		]
	]);
});

test('refresh keeps the reviewed file selected by path and returns to overview if it was removed', async ({
	page
}) => {
	await page.goto(`${origin}?view=github&defer=githubPullRequest`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	const details = (paths: string[], head: string, base: string): PullRequestDetails => ({
		number: 7,
		title: 'Add sign-in',
		author: 'dev',
		state: 'OPEN',
		isDraft: false,
		headRefName: 'feature/login',
		baseRefName: base,
		reviewDecision: '',
		checks: 'none',
		updatedAt: '',
		url: 'https://github.com/octo/alpha/pull/7',
		labels: [],
		body: '',
		headRefOid: head,
		baseRefOid: 'b'.repeat(40),
		isCrossRepository: false,
		mergeable: 'MERGEABLE',
		additions: 1,
		deletions: 0,
		createdAt: '',
		files: paths.map((path) => ({ path, additions: 1, deletions: 0 })),
		checkRuns: [],
		timeline: [],
		threads: []
	});
	const refresh = async (
		paths: string[],
		head = 'a'.repeat(40),
		base = 'main'
	): Promise<void> => {
		await expect
			.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.method))
			.toBe('githubPullRequest');
		await page.evaluate(
			(value) => window.rendererTest.settle('githubPullRequest', 0, value),
			details(paths, head, base)
		);
	};
	await page.keyboard.press('Enter');
	await refresh(['src/login.ts']);
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	const reviewed = files.getByRole('option', { name: 'src/login.ts' });
	await reviewed.click();
	await expect(reviewed).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('c');
	const draft = page.getByRole('textbox', { name: /^Comment on line/ });
	await draft.fill('About the original diff');
	await page.getByRole('textbox', { name: 'Line number' }).fill('2');
	const send = page.getByRole('button', { name: /^Comment/ });
	await expect(send).toBeEnabled();
	await files.focus();
	await page.keyboard.press('r');
	await refresh(['README.md', 'src/login.ts']);
	await expect(files.getByRole('option', { name: 'README.md' })).toBeVisible();
	await expect(reviewed).toHaveAttribute('aria-selected', 'true');
	await expect(send).toBeEnabled();
	await page.keyboard.press('r');
	await refresh(['README.md', 'src/login.ts'], 'a'.repeat(40), 'release');
	await expect(page.getByRole('alert')).toContainText('The diff changed.');
	await expect(draft).toHaveValue('About the original diff');
	await expect(send).toBeDisabled();
	await draft.press('Control+Enter');
	expect(await calls(page, 'githubLineComment')).toEqual([]);
	await draft.press('Escape');
	await files.focus();
	await page.keyboard.press('r');
	await refresh(['README.md']);
	await expect(files.getByRole('option', { name: 'Overview' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
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
		['alpha', 7, 'request-changes', 'Add a test', 'a'.repeat(40)]
	]);

	await files.focus();
	await page.keyboard.press('m');
	const merge = page.getByRole('form', { name: 'Merge pull request' });
	await expect(merge).toContainText('Some checks failed.');
	await merge.getByRole('combobox').selectOption('rebase');
	await merge.getByRole('checkbox', { name: 'Delete the branch on GitHub' }).uncheck();
	await merge.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Pull request merged.');
	expect(await calls(page, 'githubMerge')).toEqual([
		['alpha', 7, 'rebase', false, 'a'.repeat(40), 'main']
	]);

	await files.focus();
	await page.keyboard.press('o');
	await expect(page.getByRole('status')).toHaveText('Checked out the pull request’s branch.');
	expect(await calls(page, 'githubCheckout')).toEqual([['alpha', 7]]);
	// The branch changed, so gh's status is read again.
	expect((await calls(page, 'githubStatus')).length).toBe(2);
});

test('review and merge shortcuts respect pull request state', async ({ page }) => {
	const pr: PullRequestDetails = {
		number: 7,
		title: 'Add sign-in',
		author: 'dev',
		state: 'OPEN',
		isDraft: true,
		headRefName: 'feature',
		baseRefName: 'main',
		reviewDecision: '',
		checks: 'none',
		updatedAt: '',
		url: '',
		labels: [],
		body: '',
		headRefOid: 'a'.repeat(40),
		baseRefOid: 'b'.repeat(40),
		isCrossRepository: false,
		mergeable: 'MERGEABLE',
		additions: 1,
		deletions: 0,
		createdAt: '',
		files: [],
		checkRuns: [],
		timeline: [],
		threads: []
	};
	await page.goto(`${origin}?view=github&defer=githubPullRequest`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => calls(page, 'githubPullRequest')).toHaveLength(1);
	await page.evaluate((value) => window.rendererTest.settle('githubPullRequest', 0, value), pr);
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	const merge = page.getByRole('button', { name: /^Merge/ });
	const form = page.getByRole('form', { name: 'Merge pull request' });
	await expect(files).toBeFocused();
	await expect(merge).toBeDisabled();
	await page.keyboard.press('m');
	await expect(form).toHaveCount(0);

	await page.keyboard.press('r');
	await expect.poll(() => calls(page, 'githubPullRequest')).toHaveLength(2);
	await page.evaluate((value) => window.rendererTest.settle('githubPullRequest', 0, value), {
		...pr,
		isDraft: false,
		state: 'CLOSED'
	});
	await expect(merge).toBeDisabled();
	await expect(files).toBeFocused();
	await expect(page.getByRole('button', { name: /^Review/ })).toBeDisabled();
	await expect(page.getByRole('button', { name: /^Check out/ })).toBeDisabled();
	await page.keyboard.press('o');
	expect(await calls(page, 'githubCheckout')).toEqual([]);
	await page.keyboard.press('v');
	await expect(page.getByRole('textbox', { name: 'Review summary' })).toHaveCount(0);
	expect(await calls(page, 'githubReview')).toEqual([]);
	await page.keyboard.press('m');
	await expect(form).toHaveCount(0);
	expect(await calls(page, 'githubMerge')).toEqual([]);
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
	expect(await calls(page, 'githubComment')).toEqual([
		['alpha', 'issue', 3, 'Here it is', 'https://github.com/octo/alpha/issues/3']
	]);

	await page.keyboard.press('x');
	await expect(page.getByRole('status')).toHaveText('Issue closed.');
	expect(await calls(page, 'githubSetIssueOpen')).toEqual([
		['alpha', 3, false, 'https://github.com/octo/alpha/issues/3']
	]);
});

test('relative links in an issue use the issue host and open in the browser', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubIssue`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	const list = page.getByRole('listbox', { name: 'Issues' });
	await expect(list.getByRole('option', { name: '#3 Crash on start' })).toBeVisible();
	await list.press('Enter');
	await expect.poll(() => calls(page, 'githubIssue')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssue', 0, {
			number: 3,
			title: 'Crash on start',
			state: 'OPEN',
			author: 'user',
			updatedAt: '',
			createdAt: '',
			url: 'https://github.com/octo/alpha/issues/3',
			labels: [],
			assignees: [],
			comments: 0,
			timeline: [],
			body: '[Another issue](/octo/alpha/issues/5) [Unsafe](javascript:alert%281%29)'
		})
	);
	const link = page.getByRole('link', { name: 'Another issue' });
	await expect(link).toHaveAttribute('href', 'https://github.com/octo/alpha/issues/5');
	await link.click();
	expect(await calls(page, 'openDocumentation')).toEqual([
		['https://github.com/octo/alpha/issues/5']
	]);
	await expect(page.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
});

test('posting an issue comment updates its list count even if detail refresh fails', async ({
	page
}) => {
	const issue: IssueDetails = {
		number: 3,
		title: 'Crash on start',
		author: 'user',
		state: 'OPEN',
		updatedAt: '',
		url: 'https://github.com/octo/alpha/issues/3',
		labels: [],
		comments: 1,
		body: 'Report',
		createdAt: '',
		assignees: [],
		timeline: []
	};
	await page.goto(`${origin}?view=github&defer=githubIssue`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	const list = page.getByRole('listbox', { name: 'Issues' });
	await expect(list).toBeFocused();
	await page.keyboard.press('c');
	await expect.poll(() => calls(page, 'githubIssue')).toHaveLength(1);
	await page.evaluate((value) => window.rendererTest.settle('githubIssue', 0, value), issue);
	const draft = page.getByRole('textbox', { name: 'Comment on the issue' });
	await draft.fill('First new comment');
	await draft.press('Control+Enter');
	await expect.poll(() => calls(page, 'githubIssue')).toHaveLength(2);
	await page.evaluate((value) => window.rendererTest.settle('githubIssue', 0, value), {
		...issue,
		comments: 3
	});
	await expect(list.getByText('Comments: 3')).toBeVisible();
	await expect(page.getByRole('status')).toHaveText('Comment posted.');

	await list.press('c');
	await draft.fill('Second new comment');
	await draft.press('Control+Enter');
	await expect.poll(() => calls(page, 'githubIssue')).toHaveLength(3);
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssue', 0, new Error('HTTP 503'), true)
	);
	await expect(list.getByText('Comments: 4')).toBeVisible();
	await expect(page.getByRole('status')).toContainText('Comment posted, but');
	await expect(page.getByRole('status')).toContainText('HTTP 503');
});

test('switching issues cannot carry a comment draft to the new issue', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubIssues`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'githubIssues',
			0,
			['First issue', 'Second issue'].map((title, index) => ({
				number: index + 3,
				url: `https://github.com/octo/alpha/issues/${index + 3}`,
				title,
				author: 'user',
				state: 'OPEN',
				labels: [],
				comments: 0
			}))
		)
	);
	await expect(page.getByRole('listbox', { name: 'Issues' })).toBeFocused();
	await page.keyboard.press('c');
	const box = page.getByRole('textbox', { name: 'Comment on the issue' });
	await box.fill('Only for issue 3');
	await page.getByRole('option', { name: '#4 Second issue' }).click();
	await expect(page.getByRole('heading', { name: 'Second issue' })).toBeVisible();
	await expect(box).toHaveCount(0);
	await page.keyboard.press('Control+Enter');
	expect(await calls(page, 'githubComment')).toEqual([]);

	await page.getByRole('option', { name: '#3 First issue' }).click();
	await page.keyboard.press('c');
	await expect(box).toHaveValue('');
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
		['alpha', 'Add sign-in', 'Closes #3', 'main', true, 'feature/login']
	]);

	// The base cannot be the checked-out branch.
	await page.keyboard.press('3');
	await page.getByRole('textbox', { name: 'Base branch' }).fill('feature/login');
	await expect(page.getByRole('button', { name: /^Push and create/ })).toBeDisabled();
	await expect(page.getByText('Switch to a branch other than the base first.')).toBeVisible();
});

test('closing an issue updates its state before the list reloads', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubIssues,githubIssue,githubSetIssueOpen`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssues', 0, [
			{
				number: 3,
				title: 'Crash on start',
				author: 'user',
				state: 'OPEN',
				url: 'https://github.com/octo/alpha/issues/3',
				labels: [],
				comments: 0
			}
		])
	);
	const list = page.getByRole('listbox', { name: 'Issues' });
	await expect(
		list.getByRole('option', { name: '#3 Crash on start', selected: true })
	).toBeVisible();
	await list.press('x');
	await expect
		.poll(() => calls(page, 'githubSetIssueOpen'))
		.toEqual([['alpha', 3, false, 'https://github.com/octo/alpha/issues/3']]);
	await page.evaluate(() => window.rendererTest.settle('githubSetIssueOpen', 0, undefined));
	await expect(page.getByRole('status')).toHaveText('Issue closed.');
	await expect(page.getByRole('button', { name: 'Reopen issue' })).toBeVisible();
	expect(await calls(page, 'githubIssue')).toEqual([]);
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(2);
	await page.evaluate(() => window.rendererTest.settle('githubIssues', 0, []));
	await expect(page.getByText('No issues.')).toBeVisible();
});

test('a delayed commit subject does not refill a pull request title the user cleared', async ({
	page
}) => {
	await page.goto(`${origin}?view=github&defer=gitHistory`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('3');
	const title = page.getByRole('textbox', { name: 'Title' });
	await expect(title).toBeFocused();
	await title.fill('My draft title');
	await title.clear();
	await page.evaluate(async () => {
		window.rendererTest.settle('gitHistory', 0, {
			commits: [{ hash: 'a'.repeat(40), author: 'dev', date: '', subject: 'Add sign-in' }],
			total: 1
		});
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
	});
	await expect(title).toHaveValue('');
	await expect(page.getByRole('button', { name: /^Push and create/ })).toBeDisabled();
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
	// The card sits in the same list as the other extensions, below their buttons: one card
	// per row, each as wide as the list.
	await search.fill('');
	const deno = extensions.locator('[data-pack="deno"]');
	const [cardBox, denoBox, actionsBox] = await Promise.all([
		card.boundingBox(),
		deno.boundingBox(),
		extensions.getByRole('button', { name: 'Install extension' }).boundingBox()
	]);
	expect(cardBox!.x).toBe(denoBox!.x);
	expect(cardBox!.width).toBe(denoBox!.width);
	expect(denoBox!.y).toBeGreaterThan(cardBox!.y + cardBox!.height);
	expect(cardBox!.y).toBeGreaterThan(actionsBox!.y + actionsBox!.height);
	await page.screenshot({ path: test.info().outputPath('other-extensions.png') });
	expect(Math.abs(cardBox!.width - denoBox!.width)).toBeLessThan(1);
	expect(cardBox!.x).toBeGreaterThanOrEqual(actionsBox!.x);
	await search.fill('pull request');
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

test('a merge refreshes the list behind the pull request and reports a branch it could not delete', async ({
	page
}) => {
	await page.goto(`${origin}?view=github&defer=githubMerge`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	await page.keyboard.press('m');
	await page.getByRole('button', { name: 'Merge', exact: true }).click();
	await page.evaluate(() =>
		window.rendererTest.settle('githubMerge', 0, {
			merged: true,
			branchError: 'HTTP 422: protected'
		})
	);
	await expect(page.getByRole('status')).toHaveText(
		'Pull request merged, but its branch could not be deleted: HTTP 422: protected'
	);
	// The list behind the pull request is read again, so its state is current after Esc.
	expect((await calls(page, 'githubPullRequests')).length).toBe(2);
});

test('a requested merge is not displayed as completed', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubMerge`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	const files = page.getByRole('listbox', { name: 'Pull request files' });
	await expect(files).toBeFocused();
	await files.press('m');
	await page.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect.poll(() => calls(page, 'githubMerge')).toHaveLength(1);
	await page.evaluate(() => window.rendererTest.settle('githubMerge', 0, { merged: false }));
	await expect(page.getByRole('status')).toHaveText(
		'Merge requested. The pull request has not merged yet.'
	);
});

test('returning to a reordered PR list keeps the same pull request selected', async ({ page }) => {
	const first = {
		number: 7,
		title: 'Add sign-in',
		author: 'dev',
		state: 'OPEN',
		isDraft: false,
		headRefName: 'feature',
		baseRefName: 'main',
		reviewDecision: '',
		checks: 'none',
		updatedAt: '',
		url: '',
		labels: []
	};
	const next = { ...first, number: 8, title: 'Fix typo' };
	await page.goto(`${origin}?view=github&defer=githubPullRequests`);
	await expect.poll(() => calls(page, 'githubPullRequests')).toHaveLength(1);
	await page.evaluate(
		(items) => window.rendererTest.settle('githubPullRequests', 0, items),
		[first, next]
	);
	const list = page.getByRole('listbox', { name: 'Pull requests' });
	await expect(list).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	await page.keyboard.press('c');
	const draft = page.getByRole('textbox', { name: 'Comment on the pull request' });
	await draft.fill('Looks good');
	await draft.press('Control+Enter');
	await expect.poll(() => calls(page, 'githubPullRequests')).toHaveLength(2);
	await page.evaluate(
		(items) => window.rendererTest.settle('githubPullRequests', 0, items),
		[next, first]
	);
	await expect(page.getByRole('status')).toHaveText('Comment posted.');
	await page.getByRole('button', { name: 'Back (Esc)' }).click();
	await expect(
		list.getByRole('option', { name: '#7 Add sign-in', selected: true })
	).toBeVisible();
});

test('a pending or failed comment keeps its draft', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubComment`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	await page.keyboard.press('c');
	const box = page.getByRole('textbox', { name: 'Comment on the pull request' });
	await page.keyboard.type('Important review notes');
	await page.keyboard.press('Control+Enter');
	await expect.poll(() => calls(page, 'githubComment')).toHaveLength(1);
	await expect(page.getByRole('button', { name: 'Cancel (Esc)' })).toBeDisabled();
	await box.press('Escape');
	await expect(box).toBeFocused();
	await box.press('End');
	await page.keyboard.type(' unsent');
	await expect(box).toHaveValue('Important review notes');
	await page.evaluate(() =>
		window.rendererTest.settle('githubComment', 0, new Error('HTTP 502: Bad gateway'), true)
	);
	await expect(page.getByRole('alert')).toContainText('HTTP 502');
	await expect(box).toHaveValue('Important review notes');
	await box.press('End');
	await page.keyboard.type(' revised');
	await expect(box).toHaveValue('Important review notes revised');
	await box.press('Escape');
	await expect(box).toHaveCount(0);
});

test('a posted thread reply closes its draft even if reloading the PR fails', async ({ page }) => {
	const pr: PullRequestDetails = {
		number: 7,
		title: 'Add sign-in',
		author: 'dev',
		state: 'OPEN',
		isDraft: false,
		headRefName: 'feature',
		baseRefName: 'main',
		reviewDecision: '',
		checks: 'none',
		updatedAt: '',
		url: '',
		labels: [],
		body: '',
		headRefOid: 'a'.repeat(40),
		baseRefOid: 'b'.repeat(40),
		isCrossRepository: false,
		mergeable: 'MERGEABLE',
		additions: 1,
		deletions: 0,
		createdAt: '',
		files: [{ path: 'src/login.ts', additions: 1, deletions: 0 }],
		checkRuns: [],
		timeline: [],
		threads: [
			{
				id: 'PRRT_1',
				path: 'src/login.ts',
				line: 2,
				side: 'RIGHT',
				isResolved: false,
				isOutdated: false,
				comments: []
			}
		]
	};
	await page.goto(`${origin}?view=github&defer=githubPullRequest`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => calls(page, 'githubPullRequest')).toHaveLength(1);
	await page.evaluate((value) => window.rendererTest.settle('githubPullRequest', 0, value), pr);
	await expect(page.getByRole('listbox', { name: 'Pull request files' })).toBeFocused();
	await page.keyboard.press('j');
	await page.getByRole('button', { name: 'Reply', exact: true }).click();
	const reply = page.getByRole('textbox', { name: 'Reply to the thread' });
	await reply.fill('Done');
	await reply.press('Control+Enter');
	await expect.poll(() => calls(page, 'githubPullRequest')).toHaveLength(2);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequest', 0, new Error('HTTP 503'), true)
	);
	await expect(page.getByRole('status')).toContainText('Reply posted. Could not refresh');
	await expect(page.getByRole('status')).toContainText('HTTP 503');
	await expect(reply).toHaveCount(0);
	expect(await calls(page, 'githubReply')).toEqual([['alpha', 'PRRT_1', 'Done', pr.url]]);
});

test('refresh reloads an open issue and keeps it selected after list reordering', async ({
	page
}) => {
	const issue: IssueDetails = {
		number: 3,
		title: 'Crash on start',
		author: 'user',
		state: 'OPEN',
		updatedAt: '2026-11-14T10:00:00Z',
		url: 'https://github.com/octo/alpha/issues/3',
		labels: [],
		comments: 0,
		body: 'Original issue',
		createdAt: '2026-11-13T10:00:00Z',
		assignees: [],
		timeline: []
	};
	const other = {
		...issue,
		number: 4,
		title: 'Another issue',
		url: 'https://github.com/octo/alpha/issues/4'
	};
	await page.goto(`${origin}?view=github&defer=githubIssues,githubIssue`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(1);
	await page.evaluate(
		(items) => window.rendererTest.settle('githubIssues', 0, items),
		[issue, other]
	);
	const issueList = page.getByRole('listbox', { name: 'Issues' });
	await expect(
		issueList.getByRole('option', { name: '#3 Crash on start', selected: true })
	).toBeVisible();
	await issueList.press('Enter');
	await expect.poll(() => calls(page, 'githubIssue')).toEqual([['alpha', 3, issue.url]]);
	await page.evaluate((value) => window.rendererTest.settle('githubIssue', 0, value), issue);
	await expect(page.getByText('Original issue')).toBeVisible();

	await page.getByRole('button', { name: 'Refresh (r)' }).click();
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(2);
	await expect
		.poll(() => calls(page, 'githubIssue'))
		.toEqual([
			['alpha', 3, issue.url],
			['alpha', 3, issue.url]
		]);
	const updated: IssueDetails = {
		...issue,
		body: 'Updated issue',
		comments: 1,
		timeline: [{ id: 'new', author: 'user', body: 'A new comment', createdAt: issue.updatedAt }]
	};
	await page.evaluate(
		(items) => window.rendererTest.settle('githubIssues', 0, items),
		[other, updated]
	);
	await page.evaluate((value) => window.rendererTest.settle('githubIssue', 0, value), updated);
	await expect(
		page.getByRole('option', { name: '#3 Crash on start', selected: true })
	).toBeVisible();
	await expect(page.getByText('Updated issue')).toBeVisible();
	await expect(page.getByText('A new comment')).toBeVisible();
});

test('an issue that fails to load opens no comment form', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubIssue`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	await expect(page.getByRole('listbox', { name: 'Issues' })).toBeFocused();
	await page.keyboard.press('c');
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssue', 0, new Error('HTTP 404: Not Found'), true)
	);
	await expect(page.getByRole('alert')).toContainText('HTTP 404');
	await expect(page.getByRole('textbox', { name: 'Comment on the issue' })).toHaveCount(0);
});

test('a successful issue list retry clears the prior list error', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubIssues`);
	await expect(page.getByRole('listbox', { name: 'Pull requests' })).toBeFocused();
	await page.keyboard.press('2');
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssues', 0, new Error('HTTP 503'), true)
	);
	await expect(page.getByRole('alert')).toContainText('HTTP 503');

	await page.getByRole('button', { name: 'Refresh (r)' }).click();
	await expect.poll(() => calls(page, 'githubIssues')).toHaveLength(2);
	await page.evaluate(() =>
		window.rendererTest.settle('githubIssues', 0, [
			{
				number: 3,
				title: 'Crash on start',
				author: 'user',
				state: 'OPEN',
				labels: [],
				comments: 0
			}
		])
	);
	await expect(page.getByRole('heading', { name: 'Crash on start' })).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a successful pull request list retry clears the prior list error', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubPullRequests`);
	await expect.poll(() => calls(page, 'githubPullRequests')).toHaveLength(1);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequests', 0, new Error('HTTP 503'), true)
	);
	await expect(page.getByRole('alert')).toContainText('HTTP 503');

	await page.getByRole('button', { name: 'Refresh (r)' }).click();
	await expect.poll(() => calls(page, 'githubPullRequests')).toHaveLength(2);
	await page.evaluate(() =>
		window.rendererTest.settle('githubPullRequests', 0, [
			{
				number: 7,
				title: 'Add sign-in',
				author: 'dev',
				state: 'OPEN',
				isDraft: false,
				headRefName: 'feature',
				baseRefName: 'main',
				reviewDecision: '',
				checks: 'none',
				updatedAt: '',
				url: '',
				labels: []
			}
		])
	);
	await expect(page.getByRole('heading', { name: 'Add sign-in' })).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a GitHub that cannot be reached is not reported as signed out', async ({ page }) => {
	await page.goto(`${origin}?view=github&defer=githubStatus`);
	await page.evaluate(() =>
		window.rendererTest.settle('githubStatus', 0, {
			installed: true,
			authenticated: false,
			unreachable: true,
			message: 'error connecting to api.github.com'
		})
	);
	await expect(page.getByRole('heading', { name: 'Cannot reach GitHub' })).toBeVisible();
	await expect(page.getByText('error connecting to api.github.com')).toBeVisible();
	await expect(page.getByText('gh auth login', { exact: true })).toHaveCount(0);
});
