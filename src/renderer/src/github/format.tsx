import { useContext } from 'react';
import { CircleCheck, CircleDot, CircleX, GitMerge, GitPullRequest, Loader } from 'lucide-react';
import { LanguageContext, useI18n } from '../i18n';
import type { CheckState, PullRequestSummary } from '../../../shared/github';
import styles from './GitHub.module.css';

/** A date as "Nov 16, 2026, 7:38 PM", or in Japanese for a Japanese UI. */
export function FormattedDate({ value }: { value: string }): React.JSX.Element | null {
	const language = useContext(LanguageContext);
	if (!value) {
		return null;
	}
	return (
		<time dateTime={value}>
			{new Date(value).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US', {
				dateStyle: 'medium',
				timeStyle: 'short'
			})}
		</time>
	);
}

/** A pull request's state: draft, open, merged or closed. */
export function PullRequestState({
	pr
}: {
	pr: Pick<PullRequestSummary, 'state' | 'isDraft'>;
}): React.JSX.Element {
	const t = useI18n();
	const state = pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state;
	const Icon = state === 'MERGED' ? GitMerge : GitPullRequest;
	const titles = { DRAFT: 'Draft', OPEN: 'Open', MERGED: 'Merged', CLOSED: 'Closed' } as const;
	return (
		<span className={styles.state} data-state={state}>
			<Icon size={12} aria-hidden="true" />
			{t(titles[state])}
		</span>
	);
}

/** An issue's state: open or closed. */
export function IssueState({ state }: { state: 'OPEN' | 'CLOSED' }): React.JSX.Element {
	const t = useI18n();
	return (
		<span className={styles.state} data-state={state}>
			<CircleDot size={12} aria-hidden="true" />
			{t(state === 'OPEN' ? 'Open' : 'Closed')}
		</span>
	);
}

const checkTitles = {
	success: 'Checks passed',
	failure: 'Checks failed',
	pending: 'Checks running',
	none: 'No checks'
} as const;

/** The combined state of a pull request's checks, as an icon with a label for screen readers. */
export function ChecksIcon({ state }: { state: CheckState }): React.JSX.Element | null {
	const t = useI18n();
	if (state === 'none') {
		return null;
	}
	const Icon = state === 'success' ? CircleCheck : state === 'failure' ? CircleX : Loader;
	return (
		<span
			className={styles.checks}
			data-checks={state}
			role="img"
			aria-label={t(checkTitles[state])}
			title={t(checkTitles[state])}
		>
			<Icon size={13} aria-hidden="true" />
		</span>
	);
}
