import { useState } from 'react';
import { useErrorMessage, useI18n } from '../i18n';
import type { MergeMethod, PullRequestDetails, ReviewEvent } from '../../../shared/github';
import { Composer } from './Composer';
import { GitHubMarkdown } from './GitHubMarkdown';
import { Timeline } from './Timeline';
import { ChecksIcon, FormattedDate, PullRequestState } from './format';
import { canMergePullRequest, canReviewPullRequest, reviewDecisionTitle } from './githubModel';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

/** The form open below a pull request's overview, if any. */
export type PullRequestForm = 'comment' | 'review' | 'merge';

/**
 * An opened pull request: its description, checks and conversation, with buttons to check it
 * out, comment, review, merge or open it on GitHub.
 */
export default function PullRequestOverview({
	workspaceId,
	pr,
	busy,
	form,
	setForm,
	act,
	checkout,
	openInBrowser
}: {
	workspaceId: string;
	pr: PullRequestDetails;
	busy: boolean;
	form: PullRequestForm | undefined;
	setForm: (form: PullRequestForm | undefined) => void;
	act: (change: () => Promise<unknown>, message: string) => Promise<boolean>;
	checkout: () => void;
	openInBrowser: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const decision = reviewDecisionTitle(pr.reviewDecision);
	const open = pr.state === 'OPEN';
	const canMerge = canMergePullRequest(pr);
	const canReview = canReviewPullRequest(pr);
	return (
		<div className={styles.overview}>
			<section
				className={`${gitStyles.commitSummary} ${styles.summary}`}
				data-git-summary
				tabIndex={0}
				aria-label={t('Pull request overview')}
			>
				<span className={gitStyles.summaryLabel}>
					{t('PULL REQUEST #{number}', { number: pr.number })}
				</span>
				<h2>{pr.title}</h2>
				<div className={styles.badges}>
					<PullRequestState pr={pr} />
					{decision && <span className={styles.label}>{t(decision)}</span>}
					{pr.mergeable === 'CONFLICTING' && (
						<span className={styles.label} data-tone="danger">
							{t('Has conflicts')}
						</span>
					)}
					{pr.labels.map((label) => (
						<span key={label} className={styles.label}>
							{label}
						</span>
					))}
				</div>
				<p className={styles.dim}>
					{t('{author} wants to merge {head} into {base}', {
						author: pr.author,
						head: pr.headRefName,
						base: pr.baseRefName
					})}{' '}
					· <FormattedDate value={pr.createdAt} /> ·{' '}
					<span className={styles.added}>+{pr.additions}</span>{' '}
					<span className={styles.removed}>−{pr.deletions}</span>
				</p>
				<GitHubMarkdown source={pr.body} />
				{pr.checkRuns.length > 0 && (
					<>
						<h3 className={styles.sectionTitle}>
							{t('Checks')} <ChecksIcon state={pr.checks} />
						</h3>
						<ul className={styles.checkList}>
							{pr.checkRuns.map((check, position) => (
								<li key={`${check.name}:${position}`} data-check={check.state}>
									<span className={styles.checkDot} aria-hidden="true" />
									{check.url ? (
										<a
											href={check.url}
											onClick={(event) => {
												event.preventDefault();
												void window.nido.openDocumentation(check.url!);
											}}
										>
											{check.name}
										</a>
									) : (
										<span>{check.name}</span>
									)}
									<small>{t(checkStateTitles[check.state])}</small>
								</li>
							))}
						</ul>
					</>
				)}
				<h3 className={styles.sectionTitle}>{t('Conversation')}</h3>
				<Timeline comments={pr.timeline} />
			</section>
			{form === 'comment' ? (
				<Composer
					label={t('Comment on the pull request')}
					submitLabel={t('Comment')}
					busy={busy}
					onSubmit={(body) =>
						act(
							() => window.nido.githubComment(workspaceId, 'pr', pr.number, body),
							'Comment posted.'
						)
					}
					onCancel={() => setForm(undefined)}
				/>
			) : form === 'review' && canReview ? (
				<ReviewForm
					workspaceId={workspaceId}
					pr={pr}
					busy={busy}
					act={act}
					cancel={() => setForm(undefined)}
				/>
			) : form === 'merge' && canMerge ? (
				<MergeForm
					workspaceId={workspaceId}
					pr={pr}
					busy={busy}
					act={act}
					cancel={() => setForm(undefined)}
				/>
			) : (
				<div className={`${gitStyles.toolbar} ${styles.actions}`}>
					<button disabled={busy || !open} onClick={checkout}>
						{t('Check out')} <kbd>o</kbd>
					</button>
					<button disabled={busy} onClick={() => setForm('comment')}>
						{t('Comment')} <kbd>c</kbd>
					</button>
					<button disabled={busy || !canReview} onClick={() => setForm('review')}>
						{t('Review')} <kbd>v</kbd>
					</button>
					<button disabled={busy || !canMerge} onClick={() => setForm('merge')}>
						{t('Merge')} <kbd>m</kbd>
					</button>
					<span />
					<button disabled={busy} onClick={openInBrowser}>
						{t('Open on GitHub')} <kbd>b</kbd>
					</button>
				</div>
			)}
		</div>
	);
}

const checkStateTitles = {
	success: 'Passed',
	failure: 'Failed',
	pending: 'Running',
	skipped: 'Skipped',
	neutral: 'Neutral'
} as const;

/** Approve, request changes or comment, as one review. */
function ReviewForm({
	workspaceId,
	pr,
	busy,
	act,
	cancel
}: {
	workspaceId: string;
	pr: PullRequestDetails;
	busy: boolean;
	act: (change: () => Promise<unknown>, message: string) => Promise<boolean>;
	cancel: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const [event, setEvent] = useState<ReviewEvent>('approve');
	return (
		<Composer
			label={t('Review summary')}
			submitLabel={t('Submit review')}
			busy={busy}
			allowEmpty={event === 'approve'}
			controls={
				<label className={styles.filter}>
					{t('Review')}
					<select
						value={event}
						onChange={(change) => setEvent(change.currentTarget.value as ReviewEvent)}
					>
						<option value="approve">{t('Approve')}</option>
						<option value="request-changes">{t('Request changes')}</option>
						<option value="comment">{t('Comment')}</option>
					</select>
				</label>
			}
			onSubmit={(body) =>
				act(
					() => window.nido.githubReview(workspaceId, pr.number, event, body),
					'Review submitted.'
				)
			}
			onCancel={cancel}
		/>
	);
}

/** Merge the pull request with a chosen method, optionally deleting its branch on GitHub. */
function MergeForm({
	workspaceId,
	pr,
	busy,
	act,
	cancel
}: {
	workspaceId: string;
	pr: PullRequestDetails;
	busy: boolean;
	act: (change: () => Promise<unknown>, message: string) => Promise<boolean>;
	cancel: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [method, setMethod] = useState<MergeMethod>('squash');
	const [deleteBranch, setDeleteBranch] = useState(!pr.isCrossRepository);
	return (
		<form
			className={styles.composer}
			aria-label={t('Merge pull request')}
			onSubmit={(event) => {
				event.preventDefault();
				void act(async () => {
					const { branchError } = await window.nido.githubMerge(
						workspaceId,
						pr.number,
						method,
						deleteBranch,
						pr.headRefOid
					);
					// The merge happened even when the branch on GitHub could not be deleted.
					return branchError
						? t('Pull request merged, but its branch could not be deleted: {reason}', {
								reason: errorMessage(branchError)
							})
						: undefined;
				}, 'Pull request merged.');
			}}
		>
			<p>
				{t('Merge #{number} into {base}?', { number: pr.number, base: pr.baseRefName })}
				{pr.checks === 'failure' && (
					<strong className={styles.removed}> {t('Some checks failed.')}</strong>
				)}
			</p>
			<div className={styles.composerControls}>
				<label className={styles.filter}>
					{t('Merge method')}
					<select
						autoFocus
						value={method}
						onChange={(event) => setMethod(event.currentTarget.value as MergeMethod)}
					>
						<option value="squash">{t('Squash and merge')}</option>
						<option value="merge">{t('Create a merge commit')}</option>
						<option value="rebase">{t('Rebase and merge')}</option>
					</select>
				</label>
				{!pr.isCrossRepository && (
					<label className={styles.check}>
						<input
							type="checkbox"
							checked={deleteBranch}
							onChange={(event) => setDeleteBranch(event.currentTarget.checked)}
						/>
						{t('Delete the branch on GitHub')}
					</label>
				)}
				<span />
				<button type="button" disabled={busy} onClick={cancel}>
					{t('Cancel (Esc)')}
				</button>
				<button type="submit" className={styles.primary} disabled={busy}>
					{t('Merge')}
				</button>
			</div>
		</form>
	);
}
