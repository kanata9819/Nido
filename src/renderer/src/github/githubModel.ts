import type { useGitAction } from '../git/browser/useGitAction';
import type { GitHubStatus } from '../../../shared/github';

// Values and types shared by the GitHub page's components.

/** The views of the GitHub page, switched with 1, 2 and 3. */
export const githubViews = ['pulls', 'issues', 'create'] as const;
export type GitHubView = (typeof githubViews)[number];

/** What a view of the GitHub page shares with it. */
export interface GitHubViewProps {
	workspaceId: string;
	status: GitHubStatus;
	action: ReturnType<typeof useGitAction>;
	/** Show a short confirmation, such as "Comment posted." */
	notify: (message: string) => void;
	/** The view's own Esc step (closing a form or an opened item); false when it has none. */
	backRef: { current: (() => boolean) | undefined };
	/** The view's single-key actions, such as c to comment, wherever focus is on the page. */
	keysRef: { current: Record<string, () => void> | undefined };
	/** Read gh's status again, after a checkout changed the branch. */
	refreshStatus: () => Promise<void>;
}

/** The review decision, such as "Approved", or nothing when there is none. */
export function reviewDecisionTitle(decision: string): string | undefined {
	return (
		{
			APPROVED: 'Approved',
			CHANGES_REQUESTED: 'Changes requested',
			REVIEW_REQUIRED: 'Review required'
		} as Record<string, string>
	)[decision];
}

/** Words that find the GitHub extension in the Extensions page's search. */
const searchTerms = [
	'github',
	'pull request',
	'review',
	'issue',
	'gh',
	'プルリクエスト',
	'イシュー'
];

/** Whether the GitHub extension matches the Extensions page's search. */
export function githubMatches(query: string, translated: string[]): boolean {
	const needle = query.trim().toLocaleLowerCase();
	return [...searchTerms, ...translated].some((term) =>
		term.toLocaleLowerCase().includes(needle)
	);
}
