import { useI18n } from '../i18n';
import type { PullRequestSummary } from '../../../shared/github';
import { ChecksIcon, FormattedDate, PullRequestState } from './format';
import { reviewDecisionTitle } from './githubModel';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

/** The selected pull request in the list: its title, branches, state and author. */
export function PullRequestCard({
	pr,
	busy,
	open
}: {
	pr: PullRequestSummary;
	busy: boolean;
	open: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const decision = reviewDecisionTitle(pr.reviewDecision);
	return (
		<section
			className={gitStyles.commitSummary}
			data-git-summary
			tabIndex={0}
			aria-label={t('Pull request summary')}
		>
			<span className={gitStyles.summaryLabel}>
				{t('PULL REQUEST #{number}', { number: pr.number })}
			</span>
			<h2>{pr.title}</h2>
			<div className={styles.badges}>
				<PullRequestState pr={pr} />
				<ChecksIcon state={pr.checks} />
				{decision && <span className={styles.label}>{t(decision)}</span>}
				{pr.labels.map((label) => (
					<span key={label} className={styles.label}>
						{label}
					</span>
				))}
			</div>
			<dl className={gitStyles.commitDetails}>
				<div>
					<dt>{t('Author')}</dt>
					<dd>{pr.author}</dd>
				</div>
				<div>
					<dt>{t('Branches')}</dt>
					<dd>
						<code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code>
					</dd>
				</div>
				<div>
					<dt>{t('Updated')}</dt>
					<dd>
						<FormattedDate value={pr.updatedAt} />
					</dd>
				</div>
			</dl>
			<button disabled={busy} onClick={open}>
				{t('Open pull request')} <kbd>Enter</kbd>
			</button>
		</section>
	);
}
