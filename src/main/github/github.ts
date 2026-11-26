import type {
	GitHubStatus,
	IssueDetails,
	IssueFilter,
	IssueSummary,
	LineComment,
	MergeMethod,
	PullRequestDetails,
	PullRequestDraft,
	PullRequestFilter,
	PullRequestSummary,
	ReviewEvent
} from '../../shared/github';
import { gitPushBranch, gitPushRemoteUrl, gitStatus } from '../git/git';
import { gh, GhError, ghGraphql, ghJson } from './gh';
import {
	parseIssueDetails,
	parseIssueSummary,
	parsePullRequestDetails,
	parsePullRequestSummary,
	splitPullRequestDiff
} from './parse';

// Pull requests and issues of a workspace's GitHub repository, through gh. gh finds the
// repository from the folder's Git remotes, and {owner}/{repo} in `gh api` paths stands for it.

const summaryFields =
	'number,title,author,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt,url,labels';
const detailFields = `${summaryFields},body,headRefOid,isCrossRepository,mergeable,additions,deletions,createdAt,files,comments,reviews`;
const issueFields = 'number,title,author,state,updatedAt,url,labels,comments';

/** A positive pull request or issue number; throws otherwise. */
export function issueNumber(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error('Invalid pull request or issue number.');
	}
	return value;
}

/** A review thread's node id from GitHub's GraphQL API; throws otherwise. */
function nodeId(value: string): string {
	if (!/^[A-Za-z0-9_=-]{1,200}$/.test(value)) {
		throw new Error('Invalid review thread.');
	}
	return value;
}

/** Text for gh, refusing empty text where GitHub needs some. */
function requiredText(value: string, what: string): string {
	if (!value.trim()) {
		throw new Error(`Write a ${what} first.`);
	}
	return value;
}

/** Whether gh failed because it is not signed in (exit status 4, or GitHub answered 401). */
function signedOut(error: GhError): boolean {
	return error.exitCode === 4 || /\b401\b|gh auth login|not logged in/i.test(error.message);
}

/** Whether gh is installed and signed in, and the repository and branch of `cwd`. */
export async function githubStatus(cwd: string): Promise<GitHubStatus> {
	repositories.delete(cwd);
	let user: string;
	try {
		user = (await gh(cwd, ['api', 'user', '--jq', '.login'])).trim();
	} catch (error) {
		if (error instanceof GhError && error.missing) {
			return { installed: false, authenticated: false, message: error.message };
		}
		// Offline, a proxy or a rate limit is not fixed by signing in again.
		if (error instanceof GhError && !signedOut(error)) {
			return {
				installed: true,
				authenticated: false,
				unreachable: true,
				message: error.message
			};
		}
		return {
			installed: true,
			authenticated: false,
			message: 'Sign in with `gh auth login`, then refresh.'
		};
	}
	try {
		const repository = await ghJson<{
			nameWithOwner?: string;
			url?: string;
			defaultBranchRef?: { name?: string };
		}>(cwd, ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef']);
		const branch = await gitStatus(cwd).then(
			(status) => status.branch,
			() => undefined
		);
		return {
			installed: true,
			authenticated: true,
			user,
			repository: repository.nameWithOwner,
			url: repository.url,
			defaultBranch: repository.defaultBranchRef?.name,
			branch: branch || undefined
		};
	} catch (error) {
		return {
			installed: true,
			authenticated: true,
			user,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}

/** Up to 100 pull requests: open ones, the user's, those awaiting their review, or closed. */
export async function listPullRequests(
	cwd: string,
	filter: PullRequestFilter
): Promise<PullRequestSummary[]> {
	const args = ['pr', 'list', '--limit', '100', '--json', summaryFields];
	if (filter === 'mine') {
		args.push('--author', '@me');
	} else if (filter === 'review') {
		args.push('--search', 'review-requested:@me');
	} else if (filter === 'closed') {
		args.push('--state', 'closed');
	}
	return (await ghJson<unknown[]>(cwd, args)).map(parsePullRequestSummary);
}

const threadQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { nodes { id author { login } body createdAt url } }
        }
      }
    }
  }
}`;

/** A pull request with its files, checks, conversation and review threads. */
export async function pullRequest(cwd: string, number: number): Promise<PullRequestDetails> {
	const [details, repository] = await Promise.all([
		ghJson<{ url?: string }>(cwd, ['pr', 'view', String(number), '--json', detailFields]),
		repositoryName(cwd)
	]);
	const threads = await ghGraphql<unknown>(cwd, threadQuery, { ...repository, number });
	return parsePullRequestDetails(details, threads);
}

/** Each folder's repository, read once; githubStatus reads it again. */
const repositories = new Map<string, Promise<{ owner: string; name: string }>>();

/** The owner and name of the workspace's repository. */
function repositoryName(cwd: string): Promise<{ owner: string; name: string }> {
	let pending = repositories.get(cwd);
	if (!pending) {
		pending = ghJson<{ nameWithOwner?: string }>(cwd, [
			'repo',
			'view',
			'--json',
			'nameWithOwner'
		]).then(({ nameWithOwner }) => {
			const [owner, name] = (nameWithOwner ?? '').split('/');
			if (!owner || !name) {
				throw new GhError('This folder has no GitHub repository.');
			}
			return { owner, name };
		});
		repositories.set(cwd, pending);
		// A failed read is tried again next time.
		pending.catch(() => {
			if (repositories.get(cwd) === pending) {
				repositories.delete(cwd);
			}
		});
	}
	return pending;
}

async function requirePullRequestHead(
	cwd: string,
	number: number,
	expectedHead: string
): Promise<void> {
	if (!/^[a-f\d]{40}$/i.test(expectedHead)) {
		throw new Error('Refresh the pull request to get its current diff.');
	}
	const { headRefOid } = await ghJson<{ headRefOid?: string }>(cwd, [
		'pr',
		'view',
		String(number),
		'--json',
		'headRefOid'
	]);
	if (headRefOid !== expectedHead) {
		throw new Error('The pull request head changed. Refresh it to get the current diff.');
	}
}

/** The pull request's diff, one entry per changed file, as [path, diff] pairs. */
export async function pullRequestDiff(
	cwd: string,
	number: number,
	expectedHead: string
): Promise<[string, string][]> {
	await requirePullRequestHead(cwd, number, expectedHead);
	const diff = await gh(cwd, ['pr', 'diff', String(number), '--color', 'never']);
	await requirePullRequestHead(cwd, number, expectedHead);
	return [...splitPullRequestDiff(diff)];
}

/** Check out the pull request's branch into the working tree. */
export async function checkoutPullRequest(cwd: string, number: number): Promise<void> {
	await gh(cwd, ['pr', 'checkout', String(number)]);
}

/** Add a comment to the pull request's or issue's conversation. */
export async function addComment(
	cwd: string,
	kind: 'pr' | 'issue',
	number: number,
	body: string
): Promise<void> {
	await gh(
		cwd,
		[kind, 'comment', String(number), '--body-file', '-'],
		requiredText(body, 'comment')
	);
}

/** Approve, request changes on, or comment on a pull request as a review. */
export async function reviewPullRequest(
	cwd: string,
	number: number,
	event: ReviewEvent,
	body: string
): Promise<void> {
	if (event !== 'approve' && event !== 'request-changes' && event !== 'comment') {
		throw new Error('Invalid review.');
	}
	if (event !== 'approve') {
		requiredText(body, 'review');
	}
	await gh(cwd, ['pr', 'review', String(number), `--${event}`, '--body-file', '-'], body);
}

/** Reply to a review thread. */
export async function replyToThread(cwd: string, thread: string, body: string): Promise<void> {
	await ghGraphql(
		cwd,
		`mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id }
  }
}`,
		{ thread: nodeId(thread), body: requiredText(body, 'reply') }
	);
}

/** Resolve a review thread, or with `resolved` false, reopen it. */
export async function resolveThread(cwd: string, thread: string, resolved: boolean): Promise<void> {
	const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
	await ghGraphql(
		cwd,
		`mutation($thread: ID!) { ${mutation}(input: { threadId: $thread }) { thread { id } } }`,
		{ thread: nodeId(thread) }
	);
}

/** Start a review thread on a line of the displayed diff. */
export async function commentOnLine(
	cwd: string,
	number: number,
	comment: LineComment
): Promise<void> {
	if (!Number.isSafeInteger(comment.line) || comment.line <= 0) {
		throw new Error('Choose a line to comment on.');
	}
	if (comment.side !== 'LEFT' && comment.side !== 'RIGHT') {
		throw new Error('Invalid diff side.');
	}
	if (!comment.path || comment.path.startsWith('-')) {
		throw new Error('Invalid file.');
	}
	const body = requiredText(comment.body, 'comment');
	await requirePullRequestHead(cwd, number, comment.head);
	await gh(cwd, [
		'api',
		'--method',
		'POST',
		`repos/{owner}/{repo}/pulls/${number}/comments`,
		'-f',
		`body=${body}`,
		'-f',
		`commit_id=${comment.head}`,
		'-f',
		`path=${comment.path}`,
		'-F',
		`line=${comment.line}`,
		'-f',
		`side=${comment.side}`
	]);
}

/**
 * Open a pull request from the checked-out branch. The draft is checked first, then `publish`
 * (pushing the branch) runs, so an invalid draft pushes nothing.
 */
export async function createPullRequest(
	cwd: string,
	draft: PullRequestDraft,
	publish: () => Promise<string> = () => publishPullRequestBranch(cwd, draft)
): Promise<string> {
	if (!/^[\w./#+-]+$/.test(draft.base) || draft.base.startsWith('-')) {
		throw new Error('Choose a base branch.');
	}
	requiredText(draft.title, 'title');
	if (!draft.head || draft.head === draft.base) {
		throw new Error('Switch to a branch other than the base first.');
	}
	const head = await publish();
	const args = [
		'pr',
		'create',
		'--title',
		requiredText(draft.title, 'title'),
		'--base',
		draft.base,
		'--head',
		head,
		'--body-file',
		'-'
	];
	if (draft.draft) {
		args.push('--draft');
	}
	// gh prints the new pull request's address.
	return (await gh(cwd, args, draft.body)).trim().split('\n').pop() ?? '';
}

async function publishPullRequestBranch(cwd: string, draft: PullRequestDraft): Promise<string> {
	const { branch, remote } = await gitPushBranch(cwd, draft.base, draft.head);
	const [url, base] = await Promise.all([gitPushRemoteUrl(cwd, remote), repositoryName(cwd)]);
	const path = url.includes('://') ? new URL(url).pathname : (url.split(':').at(-1) ?? '');
	const match = /^\/?([^/]+)\/([^/]+?)\/?$/.exec(path);
	if (!match) {
		throw new Error('Could not identify the GitHub push repository.');
	}
	const [, owner, name] = match;
	const repo = `${owner}/${name.replace(/\.git$/i, '')}`.toLowerCase();
	return repo === `${base.owner}/${base.name}`.toLowerCase() ? branch : `${owner}:${branch}`;
}

/**
 * Merge a pull request. With `deleteBranch`, the head branch is deleted on GitHub only; the
 * local checkout is left alone, so unsaved editor changes and the working tree are safe.
 * A branch that cannot be deleted does not undo the merge: its error is returned instead.
 */
export async function mergePullRequest(
	cwd: string,
	number: number,
	method: MergeMethod,
	deleteBranch: boolean,
	expectedHead: string
): Promise<{ branchError?: string }> {
	if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
		throw new Error('Invalid merge method.');
	}
	if (!/^[a-f\d]{40}$/i.test(expectedHead)) {
		throw new Error('Refresh the pull request before merging.');
	}
	const { headRefName, isCrossRepository } = await ghJson<{
		headRefName?: string;
		isCrossRepository?: boolean;
	}>(cwd, ['pr', 'view', String(number), '--json', 'headRefName,isCrossRepository']);
	await gh(cwd, [
		'pr',
		'merge',
		String(number),
		`--${method}`,
		'--match-head-commit',
		expectedHead
	]);
	if (deleteBranch && headRefName && !isCrossRepository) {
		// Each part is escaped: a '#' or '?' in a branch name must not end the path early and
		// delete another branch.
		const ref = headRefName.split('/').map(encodeURIComponent).join('/');
		try {
			await gh(cwd, [
				'api',
				'--method',
				'DELETE',
				`repos/{owner}/{repo}/git/refs/heads/${ref}`
			]);
		} catch (error) {
			return { branchError: error instanceof Error ? error.message : String(error) };
		}
	}
	return {};
}

/** Up to 100 issues: open ones, those assigned to the user, the user's, or closed. */
export async function listIssues(cwd: string, filter: IssueFilter): Promise<IssueSummary[]> {
	const args = ['issue', 'list', '--limit', '100', '--json', issueFields];
	if (filter === 'assigned') {
		args.push('--assignee', '@me');
	} else if (filter === 'mine') {
		args.push('--author', '@me');
	} else if (filter === 'closed') {
		args.push('--state', 'closed');
	}
	return (await ghJson<unknown[]>(cwd, args)).map(parseIssueSummary);
}

export async function issue(cwd: string, number: number): Promise<IssueDetails> {
	return parseIssueDetails(
		await ghJson(cwd, [
			'issue',
			'view',
			String(number),
			'--json',
			`${issueFields},body,createdAt,assignees`
		])
	);
}

/** Close an open issue, or reopen a closed one. */
export async function setIssueOpen(cwd: string, number: number, open: boolean): Promise<void> {
	await gh(cwd, ['issue', open ? 'reopen' : 'close', String(number)]);
}
