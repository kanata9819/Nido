import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useErrorMessage, useI18n } from '../i18n';
import type { IssueDetails, IssueFilter, IssueSummary } from '../../../shared/github';
import GitHubList, { type GitHubRow } from './GitHubList';
import { Composer } from './Composer';
import { GitHubMarkdown } from './GitHubMarkdown';
import { Timeline } from './Timeline';
import { FormattedDate, IssueState } from './format';
import type { GitHubViewProps } from './githubModel';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

const filters: readonly IssueFilter[] = ['open', 'assigned', 'mine', 'closed'];
const filterTitles = {
	open: 'Open',
	assigned: 'Assigned to me',
	mine: 'Created by me',
	closed: 'Closed'
} as const;

/**
 * The issues of the repository. The preview shows the selected issue; Enter loads its
 * description and comments, where it can be commented on, closed or reopened.
 */
export default function Issues({
	workspaceId,
	status,
	action,
	notify,
	backRef,
	keysRef
}: GitHubViewProps): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const { run, working } = action;
	const [filter, setFilter] = useState<IssueFilter>('open');
	const [revision, setRevision] = useState(0);
	const [issues, setIssues] = useState<IssueSummary[]>([]);
	const [listError, setListError] = useState('');
	// The filter and refresh count the shown list was loaded for.
	const [loadedKey, setLoadedKey] = useState<string>();
	const listKey = `${filter}:${revision}`;
	const loaded = loadedKey === listKey;
	const [index, setIndex] = useState(0);
	const [opened, setOpened] = useState<IssueDetails>();
	const [commentTarget, setCommentTarget] = useState<number>();
	const list = useRef<HTMLDivElement>(null);
	const previousIssues = useRef<IssueSummary[]>([]);
	const busy = working || !loaded;

	useEffect(() => {
		let alive = true;
		window.nido.githubIssues(workspaceId, filter).then(
			(next) => {
				if (alive) {
					const previous = previousIssues.current;
					previousIssues.current = next;
					setIssues(next);
					setIndex((value) => {
						const number = previous[value]?.number;
						const position = next.findIndex((issue) => issue.number === number);
						return position < 0
							? Math.min(value, Math.max(0, next.length - 1))
							: position;
					});
					setLoadedKey(listKey);
					setListError('');
					list.current?.focus();
				}
			},
			(error) => {
				if (alive) {
					previousIssues.current = [];
					setIssues([]);
					setLoadedKey(listKey);
					setListError(String(error));
				}
			}
		);
		return () => {
			alive = false;
		};
	}, [workspaceId, filter, listKey]);

	// A different selection closes the opened issue.
	const selected = issues[index];
	const shown = opened && opened.number === selected?.number ? opened : undefined;
	const commenting = commentTarget !== undefined && commentTarget === selected?.number;

	function setCommenting(value: boolean): void {
		setCommentTarget(value ? selected?.number : undefined);
	}

	/** Load the selected issue's description and comments; resolves to whether it loaded. */
	const open = (): Promise<boolean> =>
		selected
			? run(async () => {
					setOpened(await window.nido.githubIssue(workspaceId, selected.number));
				})
			: Promise.resolve(false);

	const refresh = (): void => {
		if (busy) {
			return;
		}
		setRevision((value) => value + 1);
		if (shown) {
			void open();
		}
	};

	useLayoutEffect(() => {
		backRef.current = () => {
			if (commenting) {
				setCommenting(false);
				list.current?.focus();
				return true;
			}
			if (shown) {
				setOpened(undefined);
				list.current?.focus();
				return true;
			}
			return false;
		};
	});

	const postComment = (number: number, body: string): Promise<boolean> =>
		run(async () => {
			await window.nido.githubComment(workspaceId, 'issue', number, body);
			setCommenting(false);
			let details: IssueDetails | undefined;
			let message = t('Comment posted.');
			try {
				details = await window.nido.githubIssue(workspaceId, number);
				setOpened(details);
			} catch (error) {
				message = t('Comment posted, but the issue could not be refreshed: {reason}', {
					reason: errorMessage(error)
				});
			}
			setIssues((current) =>
				current.map((issue) =>
					issue.number === number
						? { ...issue, comments: details?.comments ?? issue.comments + 1 }
						: issue
				)
			);
			notify(message);
			list.current?.focus();
		});
	const toggleOpen = (): void => {
		if (!selected || busy) {
			return;
		}
		const { number } = selected;
		const open = selected.state === 'CLOSED';
		const state = open ? 'OPEN' : 'CLOSED';
		void run(async () => {
			await window.nido.githubSetIssueOpen(workspaceId, number, open);
			setCommenting(false);
			setIssues((current) =>
				current.map((issue) => (issue.number === number ? { ...issue, state } : issue))
			);
			setOpened((current) => (current?.number === number ? { ...current, state } : current));
			notify(open ? 'Issue reopened.' : 'Issue closed.');
			setRevision((value) => value + 1);
			list.current?.focus();
		});
	};
	const comment = (): void => {
		if (selected) {
			void (shown ? Promise.resolve(true) : open()).then(
				(loaded) => loaded && setCommenting(true)
			);
		}
	};

	useLayoutEffect(() => {
		keysRef.current = {
			f: () => setFilter(filters[(filters.indexOf(filter) + 1) % filters.length]),
			c: comment,
			x: toggleOpen,
			b: () => selected && void window.nido.openDocumentation(selected.url),
			r: refresh
		};
	});

	const rows: GitHubRow[] = issues.map((issue) => ({
		key: String(issue.number),
		title: issue.title,
		label: `#${issue.number} ${issue.title}`,
		meta: (
			<>
				<code className={gitStyles.hashBadge}>#{issue.number}</code>
				<IssueState state={issue.state} />
				<span>{issue.author}</span>
				{issue.comments > 0 && (
					<span>{t('Comments: {count}', { count: issue.comments })}</span>
				)}
			</>
		)
	}));

	return (
		<>
			<div className={gitStyles.toolbar}>
				<strong>{status.repository}</strong>
				<span>{t('Issues of the repository')}</span>
				<label className={styles.filter}>
					{t('Show')}
					<select
						value={filter}
						disabled={busy}
						aria-keyshortcuts="f"
						onChange={(event) => setFilter(event.currentTarget.value as IssueFilter)}
					>
						{filters.map((value) => (
							<option key={value} value={value}>
								{t(filterTitles[value])}
							</option>
						))}
					</select>
				</label>
				<button disabled={busy} onClick={refresh}>
					{t('Refresh (r)')}
				</button>
			</div>
			<div className={gitStyles.content}>
				<GitHubList
					rows={rows}
					label={t('Issues')}
					busy={busy}
					index={index}
					setIndex={(next) => {
						if (!busy && next !== index) {
							setCommenting(false);
							setIndex(next);
						}
					}}
					listRef={list}
					open={() => void open()}
					empty={t(loaded ? 'No issues.' : 'Loading…')}
				/>
				<div className={`${gitStyles.preview} ${styles.preview}`} data-git-preview>
					{selected ? (
						<div className={styles.overview}>
							<section
								className={`${gitStyles.commitSummary} ${styles.summary}`}
								data-git-summary
								tabIndex={0}
								aria-label={t('Issue')}
							>
								<span className={gitStyles.summaryLabel}>
									{t('ISSUE #{number}', { number: selected.number })}
								</span>
								<h2>{selected.title}</h2>
								<div className={styles.badges}>
									<IssueState state={selected.state} />
									{selected.labels.map((label) => (
										<span key={label} className={styles.label}>
											{label}
										</span>
									))}
								</div>
								<p className={styles.dim}>
									{t('Opened by {author}', { author: selected.author })} ·{' '}
									<FormattedDate value={shown?.createdAt ?? selected.updatedAt} />
									{shown && shown.assignees.length > 0 && (
										<>
											{' · '}
											{t('Assigned to {names}', {
												names: shown.assignees.join(', ')
											})}
										</>
									)}
								</p>
								{shown ? (
									<>
										<GitHubMarkdown source={shown.body} baseUrl={shown.url} />
										<h3 className={styles.sectionTitle}>{t('Comments')}</h3>
										<Timeline comments={shown.timeline} baseUrl={shown.url} />
									</>
								) : (
									<button disabled={busy} onClick={() => void open()}>
										{t('Show description and comments')} <kbd>Enter</kbd>
									</button>
								)}
							</section>
							{commenting ? (
								<Composer
									key={selected.number}
									label={t('Comment on the issue')}
									submitLabel={t('Comment')}
									busy={busy}
									onSubmit={(body) => postComment(selected.number, body)}
									onCancel={() => setCommenting(false)}
								/>
							) : (
								<div className={`${gitStyles.toolbar} ${styles.actions}`}>
									<button disabled={busy} onClick={comment}>
										{t('Comment')} <kbd>c</kbd>
									</button>
									<button disabled={busy} onClick={toggleOpen}>
										{t(
											selected.state === 'OPEN'
												? 'Close issue'
												: 'Reopen issue'
										)}{' '}
										<kbd>x</kbd>
									</button>
									<span />
									<button
										disabled={busy}
										onClick={() =>
											void window.nido.openDocumentation(selected.url)
										}
									>
										{t('Open on GitHub')} <kbd>b</kbd>
									</button>
								</div>
							)}
						</div>
					) : (
						<div className={gitStyles.emptyPreview} tabIndex={0} aria-busy={busy}>
							{!busy && <p>{t('Nothing to preview yet.')}</p>}
						</div>
					)}
				</div>
			</div>
			<footer>
				{t(
					'1/2/3 Views · j/k Select · Enter Open · f Filter · c Comment · x Close / Reopen · b Browser · r Refresh · Esc Back / Close'
				)}
			</footer>
			{listError && (
				<p role="alert" className={gitStyles.error}>
					{errorMessage(listError)}
				</p>
			)}
		</>
	);
}
