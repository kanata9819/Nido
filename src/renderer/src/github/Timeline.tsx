import { useI18n } from '../i18n';
import type { GitHubComment } from '../../../shared/github';
import { GitHubMarkdown } from './GitHubMarkdown';
import { FormattedDate } from './format';
import styles from './GitHub.module.css';

const reviewTitles: Record<string, string> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'requested changes',
	COMMENTED: 'reviewed',
	DISMISSED: 'review dismissed'
};

/** Comments (and reviews) of a conversation, oldest first. */
export function Timeline({
	comments,
	empty
}: {
	comments: GitHubComment[];
	empty?: string;
}): React.JSX.Element {
	const t = useI18n();
	if (!comments.length) {
		return <p className={styles.dim}>{empty ?? t('No comments yet.')}</p>;
	}
	return (
		<ol className={styles.timeline}>
			{comments.map((comment) => (
				<li key={comment.id} data-review={comment.reviewState}>
					<header>
						<strong>{comment.author}</strong>
						{comment.reviewState && reviewTitles[comment.reviewState] && (
							<span className={styles.reviewState} data-review={comment.reviewState}>
								{t(reviewTitles[comment.reviewState])}
							</span>
						)}
						<FormattedDate value={comment.createdAt} />
					</header>
					{(comment.body || !comment.reviewState) && (
						<GitHubMarkdown source={comment.body} />
					)}
				</li>
			))}
		</ol>
	);
}
