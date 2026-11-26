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
import type { IssueFilter, PullRequestFilter } from '../../shared/github';

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

	handle('githubStatus', (id) => githubStatus(root(id)));
	handle('githubPullRequests', (id, filter) => {
		if (!pullRequestFilters.includes(filter as PullRequestFilter)) {
			throw new Error('Invalid pull request filter.');
		}
		return listPullRequests(root(id), filter as PullRequestFilter);
	});
	handle('githubPullRequest', (id, number) => pullRequest(root(id), issueNumber(number)));
	handle('githubPullRequestDiff', (id, number, expectedHead) =>
		pullRequestDiff(root(id), issueNumber(number), text(expectedHead))
	);
	handle('githubCheckout', async (id, number) => {
		const current = session(id);
		const pr = issueNumber(number);
		await changeBranch(current, () => checkoutPullRequest(current.workspace.root, pr));
	});
	handle('githubComment', (id, kind, number, body) => {
		if (kind !== 'pr' && kind !== 'issue') {
			throw new Error('Invalid GitHub request.');
		}
		return addComment(root(id), kind, issueNumber(number), text(body));
	});
	handle('githubReview', (id, number, event, body, head) =>
		reviewPullRequest(root(id), issueNumber(number), event as never, text(body), text(head))
	);
	handle('githubReply', (id, thread, body) => replyToThread(root(id), text(thread), text(body)));
	handle('githubResolve', (id, thread, resolved) =>
		resolveThread(root(id), text(thread), flag(resolved))
	);
	handle('githubLineComment', (id, number, path, line, side, body, head) =>
		commentOnLine(root(id), issueNumber(number), {
			path: text(path),
			line: typeof line === 'number' ? line : NaN,
			side: side as never,
			body: text(body),
			head: text(head)
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
	handle('githubMerge', (id, number, method, deleteBranch, expectedHead) =>
		mergePullRequest(
			root(id),
			issueNumber(number),
			method as never,
			flag(deleteBranch),
			text(expectedHead)
		)
	);
	handle('githubIssues', (id, filter) => {
		if (!issueFilters.includes(filter as IssueFilter)) {
			throw new Error('Invalid issue filter.');
		}
		return listIssues(root(id), filter as IssueFilter);
	});
	handle('githubIssue', (id, number) => issue(root(id), issueNumber(number)));
	handle('githubSetIssueOpen', (id, number, open) =>
		setIssueOpen(root(id), issueNumber(number), flag(open))
	);
}
