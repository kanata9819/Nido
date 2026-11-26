// Types of the GitHub integration (pull requests and issues), which runs the GitHub CLI (gh)
// in the main process with the user's own `gh auth login`.

/** Whether gh can be used for a workspace, and which repository and account it uses. */
export interface GitHubStatus {
	/** gh is installed and runs. */
	installed: boolean;
	/** gh is signed in to GitHub. */
	authenticated: boolean;
	/** The signed-in account. */
	user?: string;
	/** The GitHub repository of the workspace, such as "owner/name". */
	repository?: string;
	/** The repository's web address. */
	url?: string;
	defaultBranch?: string;
	/** The checked-out branch. */
	branch?: string;
	/** gh is signed in as far as we know, but GitHub could not be reached (offline, a proxy). */
	unreachable?: boolean;
	/** Why gh cannot be used, when it cannot. */
	message?: string;
}

/** Which pull requests the list shows. */
export type PullRequestFilter = 'open' | 'mine' | 'review' | 'closed';
/** Which issues the list shows. */
export type IssueFilter = 'open' | 'assigned' | 'mine' | 'closed';

/** The combined state of a pull request's checks. */
export type CheckState = 'success' | 'failure' | 'pending' | 'none';

/** One CI check or commit status of a pull request. */
export interface PullRequestCheck {
	name: string;
	state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
	url?: string;
}

/** A pull request as listed. */
export interface PullRequestSummary {
	number: number;
	title: string;
	author: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	/** APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED, or empty. */
	reviewDecision: string;
	checks: CheckState;
	updatedAt: string;
	url: string;
	labels: string[];
}

/** A comment on a pull request or issue, or the text of a review. */
export interface GitHubComment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	url?: string;
	/** For a review: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
	reviewState?: string;
}

/** A file a pull request changes. */
export interface PullRequestFile {
	path: string;
	additions: number;
	deletions: number;
}

/** A conversation on lines of a pull request's diff. */
export interface ReviewThread {
	id: string;
	path: string;
	/** The line in the new (RIGHT) or old (LEFT) file; undefined when the thread is outdated. */
	line?: number;
	side: 'LEFT' | 'RIGHT';
	isResolved: boolean;
	isOutdated: boolean;
	comments: GitHubComment[];
}

/** Everything the pull request view shows. */
export interface PullRequestDetails extends PullRequestSummary {
	body: string;
	headRefOid: string;
	isCrossRepository: boolean;
	/** MERGEABLE, CONFLICTING or UNKNOWN. */
	mergeable: string;
	additions: number;
	deletions: number;
	createdAt: string;
	files: PullRequestFile[];
	checkRuns: PullRequestCheck[];
	/** Comments on the conversation and the text of reviews, oldest first. */
	timeline: GitHubComment[];
	threads: ReviewThread[];
}

/** An issue as listed. */
export interface IssueSummary {
	number: number;
	title: string;
	author: string;
	state: 'OPEN' | 'CLOSED';
	updatedAt: string;
	url: string;
	labels: string[];
	comments: number;
}

/** Everything the issue view shows. */
export interface IssueDetails extends IssueSummary {
	body: string;
	createdAt: string;
	assignees: string[];
	timeline: GitHubComment[];
}

export type ReviewEvent = 'approve' | 'request-changes' | 'comment';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface PullRequestMergeResult {
	merged: boolean;
	confirmationError?: string;
	branchError?: string;
}

/** A new pull request from the checked-out branch. */
export interface PullRequestDraft {
	title: string;
	body: string;
	base: string;
	draft: boolean;
	/** The checked-out branch shown in the form. */
	head: string;
}

/** A new comment on a line of a pull request's diff. */
export interface LineComment {
	path: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	body: string;
	/** Head commit of the diff the user reviewed. */
	head: string;
}
