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
	listPullRequests,
	mergePullRequest,
	pullRequest,
	pullRequestDiff,
	replyToThread,
	reviewPullRequest
} from '../src/main/github/github';
import { combinedChecks, parseCheck, splitPullRequestDiff } from '../src/main/github/parse';

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

test('writing actions pass text on stdin or as raw fields, never as gh flags', async () => {
	const body = '--approve\n@file and `code`';
	let calls = await withReplies({}, () => addComment(folder, 'issue', 3, body));
	assert.deepEqual(calls[0].args, ['issue', 'comment', '3', '--body-file', '-']);
	assert.equal(calls[0].input, body);

	calls = await withReplies({}, () => reviewPullRequest(folder, 3, 'request-changes', body));
	assert.deepEqual(calls[0].args, ['pr', 'review', '3', '--request-changes', '--body-file', '-']);
	assert.equal(calls[0].input, body);
	await assert.rejects(reviewPullRequest(folder, 3, 'comment', '  '), /Write a review first/);

	calls = await withReplies({ 'api graphql': { data: {} } }, () =>
		replyToThread(folder, 'PRRT_kw1', body)
	);
	assert.ok(calls[0].args.includes(`body=${body}`));
	await assert.rejects(replyToThread(folder, 'bad id; drop', 'x'), /Invalid review thread/);

	calls = await withReplies({ 'pr view 3': { headRefOid: 'f00d' } }, () =>
		commentOnLine(folder, 3, { path: 'src/a.ts', line: 9, side: 'LEFT', body })
	);
	assert.deepEqual(calls[1].args.slice(0, 4), [
		'api',
		'--method',
		'POST',
		'repos/{owner}/{repo}/pulls/3/comments'
	]);
	for (const field of [
		`body=${body}`,
		'commit_id=f00d',
		'path=src/a.ts',
		'line=9',
		'side=LEFT'
	]) {
		assert.ok(calls[1].args.includes(field), field);
	}
	await assert.rejects(
		commentOnLine(folder, 3, { path: 'a', line: 0, side: 'LEFT', body: 'x' }),
		/Choose a line/
	);

	calls = await withReplies(
		{ 'pr create': 'Warning\nhttps://github.com/octo/app/pull/9\n' },
		async () =>
			assert.equal(
				await createPullRequest(folder, { title: 'T', body, base: 'main', draft: true }),
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
		'--body-file',
		'-',
		'--draft'
	]);
	assert.equal(calls[0].input, body);
	await assert.rejects(
		createPullRequest(folder, { title: 'T', body: '', base: '--web', draft: false }),
		/Choose a base branch/
	);
});

test('merging deletes the head branch on GitHub only, and never for a fork', async () => {
	let calls = await withReplies(
		{ 'pr view 5': { headRefName: 'feature/x', isCrossRepository: false } },
		() => mergePullRequest(folder, 5, 'squash', true)
	);
	assert.deepEqual(calls[1].args, ['pr', 'merge', '5', '--squash']);
	assert.deepEqual(calls[2].args, [
		'api',
		'--method',
		'DELETE',
		'repos/{owner}/{repo}/git/refs/heads/feature/x'
	]);
	calls = await withReplies(
		{ 'pr view 5': { headRefName: 'feature/x', isCrossRepository: true } },
		() => mergePullRequest(folder, 5, 'rebase', true)
	);
	assert.equal(calls.length, 2);
	await assert.rejects(mergePullRequest(folder, 5, '--admin' as never, false), /Invalid merge/);
});

test('a pull request diff is returned per file', async () => {
	await withReplies(
		{
			'pr diff 4': 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
		},
		async () => {
			const files = await pullRequestDiff(folder, 4);
			assert.deepEqual(
				files.map(([path]) => path),
				['x']
			);
		}
	);
});

test('gh errors come back with gh’s own message', async () => {
	await withReplies({ 'pr list': { error: 'GraphQL: Could not resolve to a Repository' } }, () =>
		assert.rejects(
			listPullRequests(folder, 'open'),
			/^Error: Could not resolve to a Repository$/
		)
	);
});
