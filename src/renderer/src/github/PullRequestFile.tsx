import { useState } from 'react';
import { useI18n } from '../i18n';
import type {
	PullRequestDetails,
	PullRequestDiffTarget,
	ReviewThread
} from '../../../shared/github';
import GitDiff from '../git/GitDiff';
import { Composer } from './Composer';
import { Timeline } from './Timeline';
import styles from './GitHub.module.css';

interface PullRequestFileProps {
	workspaceId: string;
	pr: PullRequestDetails;
	path: string;
	diff?: string;
	diffHead: string;
	diffTarget: PullRequestDiffTarget;
	historical?: boolean;
	busy: boolean;
	commenting: boolean;
	setCommenting: (commenting: boolean) => void;
	act: (change: () => Promise<unknown>, message: string) => Promise<boolean>;
}

/**
 * A file of an opened pull request: its diff, and below it the file's review threads, which
 * can be replied to and resolved, and a form to start a thread on a line (c).
 */
export default function PullRequestFile({
	workspaceId,
	pr,
	path,
	diff,
	diffHead,
	diffTarget,
	historical,
	busy,
	commenting,
	setCommenting,
	act
}: PullRequestFileProps): React.JSX.Element {
	const t = useI18n();
	const threads = pr.threads.filter((thread) => thread.path === path);
	const focusThreads = historical || diff === undefined;
	const canCommentOnLine = !historical && diff !== undefined && pr.state === 'OPEN';
	const showLineForm = canCommentOnLine && commenting;
	return (
		<div className={styles.fileView}>
			{historical ? (
				<p>{t('This file is no longer in the current diff.')}</p>
			) : diff === undefined ? (
				<p>{t('The diff is unavailable. Refresh to try again.')}</p>
			) : (
				<div className={styles.diff}>
					<GitDiff
						workspaceId={workspaceId}
						path={path}
						diff={diff || t('No textual diff for this file.')}
						label={t('Pull request diff')}
						beforeLabel={pr.baseRefName}
						afterLabel={pr.headRefName}
					/>
				</div>
			)}
			<section
				className={styles.threads}
				aria-label={t('Review threads')}
				tabIndex={focusThreads ? 0 : undefined}
				data-git-summary={focusThreads || undefined}
			>
				<header className={styles.threadsHeading}>
					<strong>
						{t('Review threads')} <span>{threads.length}</span>
					</strong>
					{!focusThreads && !showLineForm && (
						<button
							disabled={busy || !canCommentOnLine}
							onClick={() => setCommenting(true)}
						>
							{t('Comment on a line')} <kbd>c</kbd>
						</button>
					)}
				</header>
				{showLineForm && (
					<LineCommentForm
						workspaceId={workspaceId}
						pr={pr}
						path={path}
						diff={diff}
						diffHead={diffHead}
						diffTarget={diffTarget}
						busy={busy}
						act={act}
						setCommenting={setCommenting}
					/>
				)}
				{threads.map((thread) => (
					<Thread
						key={thread.id}
						workspaceId={workspaceId}
						thread={thread}
						pullRequestUrl={pr.url}
						busy={busy}
						act={act}
					/>
				))}
			</section>
		</div>
	);
}

function LineCommentForm({
	workspaceId,
	pr,
	path,
	diff,
	diffHead,
	diffTarget,
	busy,
	act,
	setCommenting
}: Omit<PullRequestFileProps, 'commenting' | 'historical' | 'diff'> & {
	diff: string;
}): React.JSX.Element {
	const t = useI18n();
	const [anchor] = useState({ head: diffHead, target: diffTarget, diff });
	const [line, setLine] = useState('');
	const [side, setSide] = useState<'LEFT' | 'RIGHT'>('RIGHT');
	const stale =
		anchor.head !== diffHead ||
		anchor.head !== pr.headRefOid ||
		anchor.diff !== diff ||
		anchor.target.baseRefName !== diffTarget.baseRefName ||
		anchor.target.baseRefName !== pr.baseRefName ||
		anchor.target.baseRefOid !== diffTarget.baseRefOid ||
		anchor.target.baseRefOid !== pr.baseRefOid ||
		anchor.target.url !== diffTarget.url ||
		anchor.target.url !== pr.url;
	return (
		<>
			{stale && (
				<p role="alert">
					{t(
						'The diff changed. Copy your draft and reopen the form to choose a line in the new diff.'
					)}
				</p>
			)}
			<Composer
				label={t('Comment on line {line}', { line: line || '…' })}
				submitLabel={t('Comment')}
				busy={busy}
				ready={!stale && Number(line) > 0}
				controls={
					<>
						<label className={styles.filter}>
							{t('Line')}
							<input
								className={styles.lineInput}
								inputMode="numeric"
								value={line}
								aria-label={t('Line number')}
								onChange={(event) =>
									setLine(event.currentTarget.value.replace(/\D/g, ''))
								}
							/>
						</label>
						<label className={styles.filter}>
							{t('Side')}
							<select
								value={side}
								onChange={(event) =>
									setSide(event.currentTarget.value as 'LEFT' | 'RIGHT')
								}
							>
								<option value="RIGHT">
									{t('New ({branch})', { branch: pr.headRefName })}
								</option>
								<option value="LEFT">
									{t('Old ({branch})', { branch: pr.baseRefName })}
								</option>
							</select>
						</label>
					</>
				}
				onSubmit={(body) =>
					act(
						() =>
							window.nido.githubLineComment(
								workspaceId,
								pr.number,
								path,
								Number(line),
								side,
								body,
								anchor.head,
								anchor.target
							),
						'Comment posted.'
					)
				}
				onCancel={() => setCommenting(false)}
			/>
		</>
	);
}

/** One review thread: where it is, its comments, and replying or resolving. */
function Thread({
	workspaceId,
	thread,
	pullRequestUrl,
	busy,
	act
}: {
	workspaceId: string;
	thread: ReviewThread;
	pullRequestUrl: string;
	busy: boolean;
	act: (change: () => Promise<unknown>, message: string) => Promise<boolean>;
}): React.JSX.Element {
	const t = useI18n();
	const [replying, setReplying] = useState(false);
	return (
		<article className={styles.thread} data-resolved={thread.isResolved || undefined}>
			<header>
				<strong>
					{thread.line === undefined
						? t('Outdated')
						: t(thread.side === 'LEFT' ? 'Old line {line}' : 'Line {line}', {
								line: thread.line
							})}
				</strong>
				{thread.isOutdated && thread.line !== undefined && (
					<span className={styles.label}>{t('Outdated')}</span>
				)}
				{thread.isResolved && <span className={styles.label}>{t('Resolved')}</span>}
				<span />
				<button disabled={busy} onClick={() => setReplying(true)}>
					{t('Reply')}
				</button>
				<button
					disabled={busy}
					onClick={() =>
						void act(
							() =>
								window.nido.githubResolve(
									workspaceId,
									thread.id,
									!thread.isResolved,
									pullRequestUrl
								),
							thread.isResolved ? 'Thread reopened.' : 'Thread resolved.'
						)
					}
				>
					{t(thread.isResolved ? 'Unresolve' : 'Resolve')}
				</button>
			</header>
			<Timeline comments={thread.comments} />
			{replying && (
				<Composer
					label={t('Reply to the thread')}
					submitLabel={t('Reply')}
					busy={busy}
					onSubmit={(body) =>
						act(
							() =>
								window.nido.githubReply(
									workspaceId,
									thread.id,
									body,
									pullRequestUrl
								),
							'Reply posted.'
						).then((sent) => {
							if (sent) {
								setReplying(false);
							}
							return sent;
						})
					}
					onCancel={() => setReplying(false)}
				/>
			)}
		</article>
	);
}
