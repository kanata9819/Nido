import type { Session } from '../session/session';
import {
	addComment,
	checkoutPullRequest,
	commentOnLine,
	createPullRequest,
	githubStatus,
	issue,
	issueNumber,
	listIssues,
	listPullRequests,
	mergePullRequest,
	pullRequest,
	pullRequestDiff,
	replyToThread,
	resolveThread,
	reviewPullRequest,
	setIssueOpen
} from '../github/github';
import type { IssueFilter, PullRequestDiffTarget, PullRequestFilter } from '../../shared/github';

const pullRequestFilters: readonly PullRequestFilter[] = ['open', 'mine', 'review', 'closed'];
const issueFilters: readonly IssueFilter[] = ['open', 'assigned', 'mine', 'closed'];

function flag(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new Error('Invalid GitHub request.');
	}
	return value;
}

/**
 * IPC handlers of the GitHub page: pull requests and issues of the workspace's repository,
 * through the GitHub CLI. Checking out a pull request rewrites files like a branch switch.
 */
export function registerGithubHandlers({
	handle,
	session,
	text,
	changeBranch
}: {
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	session: (id: unknown) => Session;
	text: (value: unknown) => string;
	changeBranch: (current: Session, change: () => Promise<void>) => Promise<void>;
}): void {
	const root = (id: unknown): string => session(id).workspace.root;
	const optionalText = (value: unknown): string | undefined =>
		value === undefined ? undefined : text(value);
	const diffTarget = (value: unknown): PullRequestDiffTarget => {
		const target = value as Record<string, unknown> | null | undefined;
		return {
			url: text(target?.url),
			baseRefName: text(target?.baseRefName),
			baseRefOid: text(target?.baseRefOid)
		};
	};

	handle('githubStatus', (id) => githubStatus(root(id)));
	handle('githubPullRequests', (id, filter) => {
		if (!pullRequestFilters.includes(filter as PullRequestFilter)) {
			throw new Error('Invalid pull request filter.');
		}
		return listPullRequests(root(id), filter as PullRequestFilter);
	});
	handle('githubPullRequest', (id, number, url) =>
		pullRequest(root(id), issueNumber(number), text(url))
	);
	handle('githubPullRequestDiff', (id, number, expectedHead, target) =>
		pullRequestDiff(root(id), issueNumber(number), text(expectedHead), diffTarget(target))
	);
	handle('githubCheckout', async (id, number, url) => {
		const current = session(id);
		const pr = issueNumber(number);
		const address = optionalText(url);
		await changeBranch(current, () => checkoutPullRequest(current.workspace.root, pr, address));
	});
	handle('githubComment', (id, kind, number, body, url) => {
		if (kind !== 'pr' && kind !== 'issue') {
			throw new Error('Invalid GitHub request.');
		}
		return addComment(root(id), kind, issueNumber(number), text(body), text(url));
	});
	handle('githubReview', (id, number, event, body, head, url) =>
		reviewPullRequest(
			root(id),
			issueNumber(number),
			event as never,
			text(body),
			text(head),
			optionalText(url)
		)
	);
	handle('githubReply', (id, thread, body, url) =>
		replyToThread(root(id), text(thread), text(body), text(url))
	);
	handle('githubResolve', (id, thread, resolved, url) =>
		resolveThread(root(id), text(thread), flag(resolved), text(url))
	);
	handle('githubLineComment', (id, number, path, line, side, body, head, target) =>
		commentOnLine(root(id), issueNumber(number), {
			path: text(path),
			line: typeof line === 'number' ? line : NaN,
			side: side as never,
			body: text(body),
			head: text(head),
			target: diffTarget(target)
		})
	);
	handle('githubCreatePullRequest', (id, title, body, base, draft, head) =>
		createPullRequest(root(id), {
			title: text(title),
			body: text(body),
			base: text(base),
			draft: flag(draft),
			head: text(head)
		})
	);
	handle('githubMerge', (id, number, method, deleteBranch, expectedHead, expectedBase, url) =>
		mergePullRequest(
			root(id),
			issueNumber(number),
			method as never,
			flag(deleteBranch),
			text(expectedHead),
			text(expectedBase),
			optionalText(url)
		)
	);
	handle('githubIssues', (id, filter) => {
		if (!issueFilters.includes(filter as IssueFilter)) {
			throw new Error('Invalid issue filter.');
		}
		return listIssues(root(id), filter as IssueFilter);
	});
	handle('githubIssue', (id, number, url) => issue(root(id), issueNumber(number), text(url)));
	handle('githubSetIssueOpen', (id, number, open, url) =>
		setIssueOpen(root(id), issueNumber(number), flag(open), text(url))
	);
}
