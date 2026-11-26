import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { useGhExecutable } from '../src/main/github/gh';
import {
	addComment,
	commentOnLine,
	createPullRequest,
	githubStatus,
	issue,
	listPullRequests,
	mergePullRequest,
	pullRequest,
	pullRequestDiff,
	replyToThread,
	reviewPullRequest,
	setIssueOpen
} from '../src/main/github/github';
import {
	combinedChecks,
	diffPath,
	parseCheck,
	splitPullRequestDiff
} from '../src/main/github/parse';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

// A fake gh: it records each call's arguments and input, and answers from a table of replies
// keyed by the first arguments.
let folder: string;
let log: string;

const fakeGh = String.raw`
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input }) + '\n');
	const replies = JSON.parse(process.env.FAKE_GH_REPLIES || '{}');
	const key = Object.keys(replies)
		.filter((prefix) => args.join(' ').startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0];
	const reply = key === undefined ? '' : replies[key];
	if (reply && reply.error) {
		process.stderr.write(reply.error);
		process.exit(1);
	}
	process.stdout.write(typeof reply === 'string' ? reply : JSON.stringify(reply));
});
`;

before(async () => {
	folder = await mkdtemp(join(tmpdir(), 'nido-gh-'));
	log = join(folder, 'calls.jsonl');
	await writeFile(join(folder, 'gh.cjs'), fakeGh);
	useGhExecutable(process.execPath, [join(folder, 'gh.cjs')]);
	process.env.FAKE_GH_LOG = log;
});

after(async () => {
	useGhExecutable('gh');
	await rm(folder, { recursive: true, force: true });
});

/** Answer gh calls from `replies`, run `action`, and return the calls gh received. */
async function withReplies(
	replies: Record<string, unknown>,
	action: () => Promise<unknown>
): Promise<{ args: string[]; input: string }[]> {
	await writeFile(log, '');
	process.env.FAKE_GH_REPLIES = JSON.stringify(replies);
	await action();
	const lines = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
	return lines.map((line) => JSON.parse(line));
}

test('checks combine into failing, pending or passing', () => {
	const checks = [
		parseCheck({
			__typename: 'CheckRun',
			name: 'lint',
			status: 'COMPLETED',
			conclusion: 'SUCCESS'
		}),
		parseCheck({ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' }),
		parseCheck({ __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS' })
	];
	assert.deepEqual(
		checks.map((check) => check.state),
		['success', 'pending', 'success']
	);
	assert.equal(combinedChecks(checks), 'pending');
	assert.equal(
		combinedChecks([
			...checks,
			parseCheck({ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' })
		]),
		'failure'
	);
	assert.equal(
		combinedChecks([parseCheck({ name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' })]),
		'success'
	);
	assert.equal(combinedChecks([]), 'none');
});

test('a pull request diff splits into one diff per file, including deleted and renamed files', () => {
	const diff = [
		'diff --git a/src/app.ts b/src/app.ts',
		'index 1..2 100644',
		'--- a/src/app.ts',
		'+++ b/src/app.ts',
		'@@ -1 +1 @@',
		'-old',
		'+new',
		'diff --git a/gone.txt b/gone.txt',
		'deleted file mode 100644',
		'--- a/gone.txt',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-bye',
		'diff --git a/before.md b/after.md',
		'similarity index 100%',
		'rename from before.md',
		'rename to after.md',
		''
	].join('\n');
	const files = splitPullRequestDiff(diff);
	assert.deepEqual([...files.keys()], ['src/app.ts', 'gone.txt', 'after.md']);
	assert.match(files.get('src/app.ts')!, /^diff --git a\/src\/app\.ts[\s\S]*\+new\n$/);
	assert.doesNotMatch(files.get('src/app.ts')!, /gone\.txt/);
});

test('status reports a missing gh, a signed-out gh, and the repository and account', async () => {
	useGhExecutable(join(folder, 'missing-gh'));
	assert.deepEqual(await githubStatus(folder), {
		installed: false,
		authenticated: false,
		message: 'GitHub CLI (gh) is not installed.'
	});
	useGhExecutable(process.execPath, [join(folder, 'gh.cjs')]);
	await withReplies({ 'api user': { error: 'HTTP 401: Bad credentials' } }, async () => {
		const status = await githubStatus(folder);
		assert.equal(status.installed, true);
		assert.equal(status.authenticated, false);
	});
	await withReplies(
		{
			'api user': 'octocat\n',
			'repo view': {
				nameWithOwner: 'octo/app',
				url: 'https://github.com/octo/app',
				defaultBranchRef: { name: 'main' }
			}
		},
		async () => {
			const status = await githubStatus(folder);
			assert.equal(status.user, 'octocat');
			assert.equal(status.repository, 'octo/app');
			assert.equal(status.defaultBranch, 'main');
		}
	);
});

test('lists ask gh for the chosen pull requests', async () => {
	for (const [filter, extra] of [
		['open', []],
		['mine', ['--author', '@me']],
		['review', ['--search', 'review-requested:@me']],
		['closed', ['--state', 'closed']]
	] as const) {
		const calls = await withReplies(
			{
				'pr list': [
					{
						number: 7,
						title: 'Fix',
						author: { login: 'a' },
						state: 'OPEN',
						statusCheckRollup: []
					}
				]
			},
			async () => {
				const prs = await listPullRequests(folder, filter);
				assert.equal(prs[0].number, 7);
				assert.equal(prs[0].checks, 'none');
			}
		);
		assert.deepEqual(calls[0].args.slice(6), extra);
	}
});

test('a pull request joins its details with its review threads', async () => {
	const calls = await withReplies(
		{
			'pr view 12': {
				number: 12,
				title: 'Add',
				author: { login: 'dev' },
				state: 'OPEN',
				body: 'Body',
				headRefOid: 'abc',
				files: [{ path: 'a.ts', additions: 2, deletions: 1 }],
				comments: [
					{ id: 'c1', author: { login: 'x' }, body: 'Nice', createdAt: '2026-01-02' }
				],
				reviews: [
					{
						id: 'r1',
						author: { login: 'y' },
						body: '',
						state: 'APPROVED',
						submittedAt: '2026-01-03'
					},
					{
						id: 'r2',
						author: { login: 'z' },
						body: '',
						state: 'COMMENTED',
						submittedAt: '2026-01-04'
					}
				]
			},
			'repo view': { nameWithOwner: 'octo/app' },
			'api graphql': {
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [
									{
										id: 'T1',
										path: 'a.ts',
										line: 3,
										diffSide: 'RIGHT',
										isResolved: false,
										isOutdated: false,
										comments: {
											nodes: [
												{ id: 'k', author: { login: 'q' }, body: 'Why?' }
											]
										}
									}
								]
							}
						}
					}
				}
			}
		},
		async () => {
			const pr = await pullRequest(folder, 12);
			assert.equal(pr.files[0].path, 'a.ts');
			// A review without text that only comments on lines stays out of the conversation.
			assert.deepEqual(
				pr.timeline.map((entry) => [entry.author, entry.reviewState]),
				[
					['x', undefined],
					['y', 'APPROVED']
				]
			);
			assert.equal(pr.threads[0].line, 3);
			assert.equal(pr.threads[0].comments[0].body, 'Why?');
		}
	);
	const graphql = calls.find((call) => call.args[1] === 'graphql')!;
	assert.ok(graphql.args.includes('owner=octo'));
	assert.ok(graphql.args.includes('name=app'));
	assert.deepEqual(graphql.args.slice(-2), ['-F', 'number=12']);
});

const diffHead = 'a'.repeat(40);

test('writing actions pass text on stdin or as raw fields, never as gh flags', async () => {
	const body = '--approve\n@file and `code`';
	let calls = await withReplies({}, () => addComment(folder, 'issue', 3, body));
	assert.deepEqual(calls[0].args, ['issue', 'comment', '3', '--body-file', '-']);
	assert.equal(calls[0].input, body);

	calls = await withReplies({ 'pr view 3': { headRefOid: diffHead } }, () =>
		reviewPullRequest(folder, 3, 'request-changes', body, diffHead)
	);
	assert.deepEqual(calls[1].args, [
		'api',
		'--method',
		'POST',
		'repos/{owner}/{repo}/pulls/3/reviews',
		'--input',
		'-'
	]);
	assert.deepEqual(JSON.parse(calls[1].input), {
		commit_id: diffHead,
		event: 'REQUEST_CHANGES',
		body
	});
	await assert.rejects(
		reviewPullRequest(folder, 3, 'comment', '  ', diffHead),
		/Write a review first/
	);

	calls = await withReplies({ 'api graphql': { data: {} } }, () =>
		replyToThread(folder, 'PRRT_kw1', body)
	);
	assert.ok(calls[0].args.includes(`body=${body}`));
	await assert.rejects(replyToThread(folder, 'bad id; drop', 'x'), /Invalid review thread/);

	calls = await withReplies({ 'pr view 3': { headRefOid: diffHead } }, () =>
		commentOnLine(folder, 3, { path: 'src/a.ts', line: 9, side: 'LEFT', body, head: diffHead })
	);
	assert.deepEqual(calls[1].args.slice(0, 4), [
		'api',
		'--method',
		'POST',
		'repos/{owner}/{repo}/pulls/3/comments'
	]);
	for (const field of [
		`body=${body}`,
		`commit_id=${diffHead}`,
		'path=src/a.ts',
		'line=9',
		'side=LEFT'
	]) {
		assert.ok(calls[1].args.includes(field), field);
	}
	await assert.rejects(
		commentOnLine(folder, 3, { path: 'a', line: 0, side: 'LEFT', body: 'x', head: diffHead }),
		/Choose a line/
	);

	calls = await withReplies(
		{ 'pr create': 'Warning\nhttps://github.com/octo/app/pull/9\n' },
		async () =>
			assert.equal(
				await createPullRequest(
					folder,
					{ title: 'T', body, base: 'main', draft: true, head: 'feature' },
					async () => 'octo:published'
				),
				'https://github.com/octo/app/pull/9'
			)
	);
	assert.deepEqual(calls[0].args, [
		'pr',
		'create',
		'--title',
		'T',
		'--base',
		'main',
		'--head',
		'octo:published',
		'--body-file',
		'-',
		'--draft'
	]);
	assert.equal(calls[0].input, body);
	await assert.rejects(
		createPullRequest(folder, {
			title: 'T',
			body: '',
			base: '--web',
			draft: false,
			head: 'feature'
		}),
		/Choose a base branch/
	);
});

const mergeHead = 'a'.repeat(40);

test('merging deletes the head branch on GitHub only, and never for a fork', async () => {
	let calls = await withReplies(
		{ 'pr view 5': { headRefName: 'feature/x', isCrossRepository: false, state: 'MERGED' } },
		() => mergePullRequest(folder, 5, 'squash', true, mergeHead)
	);
	assert.deepEqual(calls[1].args, [
		'pr',
		'merge',
		'5',
		'--squash',
		'--match-head-commit',
		mergeHead
	]);
	assert.deepEqual(calls[3].args, [
		'api',
		'--method',
		'DELETE',
		'repos/{owner}/{repo}/git/refs/heads/feature/x'
	]);
	calls = await withReplies(
		{ 'pr view 5': { headRefName: 'feature/x', isCrossRepository: true, state: 'MERGED' } },
		() => mergePullRequest(folder, 5, 'rebase', true, mergeHead)
	);
	assert.equal(calls.length, 3);
	await assert.rejects(
		mergePullRequest(folder, 5, '--admin' as never, false, mergeHead),
		/Invalid merge/
	);
	await assert.rejects(
		mergePullRequest(folder, 5, 'squash', true, ''),
		/Refresh the pull request/
	);
	const rejected = await withReplies(
		{
			'pr view 5': { headRefName: 'feature/x', isCrossRepository: false },
			'pr merge 5': { error: 'Head SHA does not match' }
		},
		() =>
			assert.rejects(mergePullRequest(folder, 5, 'squash', true, mergeHead), /does not match/)
	);
	assert.equal(rejected.length, 2);
});

test('merging refuses a changed base before sending a merge request', async () => {
	const calls = await withReplies({ 'pr view 7': { baseRefName: 'release' } }, () =>
		assert.rejects(
			mergePullRequest(folder, 7, 'squash', false, mergeHead, 'main'),
			/base branch changed/
		)
	);
	assert.equal(calls.length, 1);
	assert.ok(calls[0].args.at(-1)?.includes('baseRefName'));
});

test('only confirmed merges may delete their branch', async () => {
	for (const reply of [{ state: 'OPEN' }, { error: 'HTTP 503' }]) {
		const calls = await withReplies(
			{
				'pr view 7': { headRefName: 'topic', isCrossRepository: false },
				'pr view 7 --json state': reply
			},
			async () =>
				assert.deepEqual(
					await mergePullRequest(folder, 7, 'squash', true, mergeHead),
					'error' in reply
						? { merged: false, confirmationError: reply.error }
						: { merged: false }
				)
		);
		assert.deepEqual(
			calls.map(({ args }) => args.slice(0, 2)),
			[
				['pr', 'view'],
				['pr', 'merge'],
				['pr', 'view']
			]
		);
	}
});

test('a pull request diff is returned per file and checked against its head', async () => {
	const calls = await withReplies(
		{
			'pr view 4': { headRefOid: diffHead },
			'pr diff 4': 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
		},
		async () => {
			const files = await pullRequestDiff(folder, 4, diffHead);
			assert.deepEqual(
				files.map(([path]) => path),
				['x']
			);
		}
	);
	assert.deepEqual(
		calls.map(({ args }) => args.slice(0, 3)),
		[
			['pr', 'view', '4'],
			['pr', 'diff', '4'],
			['pr', 'view', '4']
		]
	);
});

test('a stale head prevents loading its diff or posting a line comment', async () => {
	const calls = await withReplies({ 'pr view 4': { headRefOid: 'b'.repeat(40) } }, async () => {
		await assert.rejects(pullRequestDiff(folder, 4, diffHead), /head changed/);
		await assert.rejects(
			commentOnLine(folder, 4, {
				path: 'x',
				line: 1,
				side: 'RIGHT',
				body: 'Review',
				head: diffHead
			}),
			/head changed/
		);
	});
	assert.deepEqual(
		calls.map(({ args }) => args.slice(0, 3)),
		[
			['pr', 'view', '4'],
			['pr', 'view', '4']
		]
	);
});

test('reviews refuse stale heads and pin even a bodyless approval to the viewed commit', async () => {
	const stale = await withReplies({ 'pr view 3': { headRefOid: 'b'.repeat(40) } }, () =>
		assert.rejects(reviewPullRequest(folder, 3, 'approve', '', diffHead), /head changed/)
	);
	assert.deepEqual(
		stale.map(({ args }) => args.slice(0, 3)),
		[['pr', 'view', '3']]
	);
	const calls = await withReplies({ 'pr view 3': { headRefOid: diffHead } }, () =>
		reviewPullRequest(folder, 3, 'approve', '', diffHead)
	);
	assert.deepEqual(JSON.parse(calls[1].input), {
		commit_id: diffHead,
		event: 'APPROVE',
		body: ''
	});
});

test('gh errors come back with gh’s own message', async () => {
	await withReplies({ 'pr list': { error: 'GraphQL: Could not resolve to a Repository' } }, () =>
		assert.rejects(
			listPullRequests(folder, 'open'),
			/^Error: Could not resolve to a Repository$/
		)
	);
});

test('diffs of files with spaces or non-ASCII names are found under their real paths', async () => {
	const repo = join(folder, 'paths');
	await mkdir(join(repo, 'docs'), { recursive: true });
	await mkdir(join(repo, 'docs b'));
	const git = (...args: string[]): string =>
		execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
	git('init', '-q');
	git('config', 'user.name', 'Nido Test');
	git('config', 'user.email', 'test@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	// Names Windows allows; quotes and control characters are covered by diffPath below.
	const names = ['my file.txt', '日本語.ts', 'docs/two  spaces.md', 'old.txt'];
	for (const name of names) {
		await writeFile(join(repo, name), 'before\n');
	}
	const binary = 'docs b/icon.bin';
	await writeFile(join(repo, binary), Buffer.from([0, 1, 2]));
	git('add', '.');
	git('commit', '-qm', 'Initial');
	for (const name of names.slice(0, 3)) {
		await writeFile(join(repo, name), 'after\n');
	}
	await writeFile(join(repo, binary), Buffer.from([0, 3, 4]));
	git('mv', 'old.txt', 'renamed é.txt');
	// Git's own header format, with core.quotePath left at its default, as GitHub uses it.
	const files = splitPullRequestDiff(git('diff', 'HEAD', '-M', '--no-color'));
	assert.deepEqual([...files.keys()].sort(), [
		'docs b/icon.bin',
		'docs/two  spaces.md',
		'my file.txt',
		'renamed é.txt',
		'日本語.ts'
	]);
	assert.match(files.get(binary)!, /Binary files .* differ/);
	assert.match(files.get('日本語.ts')!, /\+after/);
});

test('deleting a merged branch escapes its name, and a failed deletion keeps the merge', async () => {
	let calls = await withReplies(
		{ 'pr view 6': { headRefName: 'fix#12/a?b', isCrossRepository: false, state: 'MERGED' } },
		async () =>
			assert.deepEqual(await mergePullRequest(folder, 6, 'squash', true, mergeHead), {
				merged: true
			})
	);
	assert.deepEqual(calls[3].args.at(-1), 'repos/{owner}/{repo}/git/refs/heads/fix%2312/a%3Fb');
	calls = await withReplies(
		{
			'pr view 6': { headRefName: 'protected', isCrossRepository: false, state: 'MERGED' },
			'api --method DELETE': { error: 'HTTP 422: Reference does not exist' }
		},
		async () =>
			assert.deepEqual(await mergePullRequest(folder, 6, 'merge', true, mergeHead), {
				merged: true,
				branchError: 'HTTP 422: Reference does not exist'
			})
	);
	assert.deepEqual(calls[1].args, [
		'pr',
		'merge',
		'6',
		'--merge',
		'--match-head-commit',
		mergeHead
	]);
});

test('issue actions stay on the displayed repository even when gh has a different default', async () => {
	const url = 'https://github.example.com/octo/old/issues/3';
	const calls = await withReplies(
		{
			'issue view 3': { url: 'https://github.example.com/octo/new/issues/3' },
			[`issue view ${url}`]: { number: 3, url }
		},
		async () => {
			assert.equal((await issue(folder, 3, url)).url, url);
			await addComment(folder, 'issue', 3, 'Only for the old repository', url);
			await setIssueOpen(folder, 3, false, url);
			await assert.rejects(
				addComment(folder, 'issue', 4, 'Wrong issue', url),
				/Invalid GitHub request/
			);
		}
	);
	assert.deepEqual(
		calls.map(({ args }) => args.slice(0, 3)),
		[
			['issue', 'view', url],
			['issue', 'comment', url],
			['issue', 'close', url]
		]
	);
});

test('creating a pull request checks the draft before the branch is pushed', async () => {
	const pushes: string[] = [];
	const publish = async (): Promise<string> => {
		pushes.push('push');
		return 'feature';
	};
	await assert.rejects(
		createPullRequest(
			folder,
			{ title: ' ', body: '', base: 'main', draft: false, head: 'feature' },
			publish
		),
		/Write a title first/
	);
	await assert.rejects(
		createPullRequest(
			folder,
			{ title: 'T', body: '', base: '-x', draft: false, head: 'feature' },
			publish
		),
		/Choose a base branch/
	);
	await assert.rejects(
		createPullRequest(
			folder,
			{ title: 'T', body: '', base: 'main', draft: false, head: 'main' },
			publish
		),
		/Switch to a branch other than the base/
	);
	assert.equal(pushes.length, 0);
	const calls = await withReplies({ 'pr create': 'https://github.com/octo/app/pull/1' }, () =>
		createPullRequest(
			folder,
			{ title: 'T', body: '', base: 'release/1.0', draft: false, head: 'feature' },
			async () => {
				pushes.push('push');
				assert.equal(
					(await readFile(log, 'utf8')).trim(),
					'',
					'pushed before gh pr create'
				);
				return 'feature';
			}
		)
	);
	assert.deepEqual(pushes, ['push']);
	assert.equal(calls[0].args[1], 'create');
});

test('status tells a signed-out gh from a GitHub it cannot reach', async () => {
	await withReplies({ 'api user': { error: 'HTTP 401: Bad credentials' } }, async () => {
		const status = await githubStatus(folder);
		assert.equal(status.unreachable, undefined);
		assert.match(status.message!, /gh auth login/);
	});
	await withReplies({ 'api user': { error: 'error connecting to api.github.com' } }, async () => {
		const status = await githubStatus(folder);
		assert.equal(status.authenticated, false);
		assert.equal(status.unreachable, true);
		assert.equal(status.message, 'error connecting to api.github.com');
	});
});

test('a pull request reads its repository once per folder until status is read again', async () => {
	const replies = {
		'pr view 12': { number: 12, title: 'A', author: { login: 'a' }, state: 'OPEN' },
		'repo view': { nameWithOwner: 'octo/app' },
		'api graphql': { data: {} },
		'api user': 'octocat'
	};
	const calls = await withReplies(replies, async () => {
		await githubStatus(folder);
		await pullRequest(folder, 12);
		await pullRequest(folder, 12);
	});
	// One repo view for the status and one shared by both pull requests.
	assert.equal(calls.filter((call) => call.args[0] === 'repo').length, 2);
});

test("diff paths undo git's quoting and keep folders named a or b", () => {
	assert.equal(diffPath('"b/docs/a \\"quoted\\" name.md"'), 'docs/a "quoted" name.md');
	assert.equal(diffPath('"b/tab\\tname.txt"'), 'tab\tname.txt');
	assert.equal(diffPath('"b/\\346\\227\\245.ts"'), '日.ts');
	assert.equal(diffPath('b/my file.txt\t'), 'my file.txt');
	assert.equal(diffPath('a/b/c.ts'), 'b/c.ts');
	assert.equal(diffPath('a/c.ts', false), 'a/c.ts');
});
