import { useErrorMessage, useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from 'react';
import type { GitChange } from '../../../shared/types';
import {
	ArrowDown,
	ArrowUp,
	Check,
	CircleCheck,
	CloudUpload,
	GitBranch,
	RefreshCw
} from 'lucide-react';
import styles from './Git.module.css';
import GitDiff from './GitDiff';
import FileIcon from '../ui/FileIcon';
import { gitChangeKey as key, useGitPanel } from './useGitPanel';
import { listIndex } from '../ui/listNavigation';
import { useMeasuredList } from '../ui/useMeasuredList';

/** The file name of a repository path (Git uses / on every platform). */
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** The folder of a repository path. */
const folderName = (path: string): string => path.slice(0, path.lastIndexOf('/'));

const changeHeight = (change: GitChange): number => (change.path.includes('/') ? 50 : 36);

/**
 * The Git panel: commit message, changed files (staged first) and the diff of the selected
 * file. State and Git calls live in useGitPanel.
 */
export default function GitPanel({
	workspaceId,
	onBusyChange,
	message,
	setMessage
}: {
	workspaceId: string;
	onBusyChange?: (busy: boolean) => void;
	message: string;
	setMessage: (message: string) => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const messageId = useId();
	const {
		status,
		selected,
		setSelected,
		error,
		notice,
		remoteNotice,
		busy,
		changes,
		current,
		stagedCount,
		unstagedCount,
		canCommit,
		diff,
		run,
		stage,
		stageAll,
		commit,
		remoteAction
	} = useGitPanel({ workspaceId, onBusyChange, message, setMessage });
	const remote = status?.remote;
	const sync = status?.sync;
	const ahead = sync?.ahead ?? 0;
	const behind = sync?.behind ?? 0;
	const destination =
		remote?.remote && remote.branch
			? `${remote.remote}/${remote.upstream.replace(/^refs\/heads\//, '') || remote.branch}`
			: '';
	const list = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const selectedIndex = current ? changes.indexOf(current) : -1;
	const virtual = useMeasuredList(
		list,
		changes,
		selectedIndex,
		changes.length > 80,
		changeHeight
	);
	useLayoutEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selected, status]);
	useEffect(() => {
		list.current?.focus();
	}, [workspaceId]);

	/**
	 * j/k select, s/u stage or unstage, S stages all, r refreshes and c edits the message.
	 * With a remote, f fetches, p pulls and P pushes, as in lazygit.
	 */
	const listKeyDown = (event: React.KeyboardEvent): void => {
		if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) {
			return;
		}
		const commandKey = event.shiftKey && event.key === 's' ? 'S' : event.key;
		switch (commandKey) {
			case 'S': {
				event.preventDefault();
				stageAll();
				break;
			}
			case 'j':
			case 'k':
			case 'ArrowDown':
			case 'ArrowUp':
			case 'Home':
			case 'End': {
				event.preventDefault();
				const next = listIndex(event.key, selectedIndex, changes.length);
				if (changes[next]) {
					setSelected(key(changes[next]));
				}
				break;
			}
			case 's':
			case 'u': {
				event.preventDefault();
				if (current && current.staged === (event.key === 'u')) {
					stage();
				}
				break;
			}
			case 'r': {
				event.preventDefault();
				void run(async () => {});
				break;
			}
			case 'c': {
				event.preventDefault();
				input.current?.focus();
				break;
			}
			case 'f':
			case 'p':
			case 'P': {
				event.preventDefault();
				const action = event.key === 'f' ? 'fetch' : event.key === 'p' ? 'pull' : 'push';
				if (
					!busy &&
					remote &&
					(action === 'fetch' || destination) &&
					(action !== 'pull' || remote.upstream)
				) {
					remoteAction(action);
				}
				break;
			}
		}
	};

	function changeRow(index: number): React.JSX.Element {
		const change = changes[index];
		return (
			<ChangeRow
				key={key(change)}
				change={change}
				index={index}
				total={changes.length}
				heading={index === 0 || changes[index - 1].staged !== change.staged}
				count={change.staged ? stagedCount : unstagedCount}
				selected={index === selectedIndex}
				onSelect={() => {
					setSelected(key(change));
					list.current?.focus();
				}}
			/>
		);
	}

	// What the commit button does now, shown below it.
	const commitHint = (): string => {
		if (busy) {
			return t('Working…');
		}
		// Resolving every conflict to HEAD's content leaves nothing staged, yet the merge commits.
		if (status?.merging && !stagedCount) {
			return message.trim()
				? t('The merge will be committed.')
				: t('Enter a message to commit the merge.');
		}
		if (status && !changes.length) {
			return t('No changes to commit.');
		}
		if (!stagedCount) {
			return t('Stage changes to include them in the commit.');
		}
		return message.trim()
			? t('Only staged changes ({count}) will be committed.', { count: stagedCount })
			: t('Enter a message to commit staged changes ({count}).', { count: stagedCount });
	};

	return (
		<section
			className={styles.panel}
			aria-label={t('Git changes')}
			aria-busy={busy}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || event.keyCode === 229) {
					return;
				}
				if (event.ctrlKey && event.key === 'Enter') {
					event.preventDefault();
					commit();
				}
			}}
		>
			<div className={styles.toolbar}>
				<GitBranch size={16} aria-hidden="true" />
				<strong>{status?.branch || t('Source control')}</strong>
				<span title={status?.root}>{status?.root}</span>
				{remote && (
					<>
						{destination && <span title={destination}>{destination}</span>}
						<SyncChip
							upstream={remote.upstream}
							ahead={ahead}
							behind={behind}
							known={!!sync}
						/>
						<button
							disabled={busy}
							aria-keyshortcuts="f"
							onClick={() => remoteAction('fetch')}
						>
							{t('Fetch all')} <kbd>f</kbd>
						</button>
						<button
							className={behind ? styles.syncReady : undefined}
							disabled={busy || !destination || !remote.upstream}
							title={
								behind
									? t('{count} commits to pull from {upstream}', {
											count: behind,
											upstream: destination
										})
									: destination
							}
							aria-keyshortcuts="p"
							onClick={() => remoteAction('pull')}
						>
							<ArrowDown size={14} aria-hidden="true" />
							{t('Pull')}
							{behind > 0 && (
								<span className={styles.count} aria-hidden="true">
									{behind}
								</span>
							)}{' '}
							<kbd>p</kbd>
						</button>
						<button
							className={!remote.upstream || ahead ? styles.syncReady : undefined}
							disabled={busy || !destination}
							title={
								ahead
									? t('{count} commits to push to {upstream}', {
											count: ahead,
											upstream: destination
										})
									: destination
							}
							aria-keyshortcuts="Shift+P"
							onClick={() => remoteAction('push')}
						>
							{remote.upstream ? (
								<ArrowUp size={14} aria-hidden="true" />
							) : (
								<CloudUpload size={14} aria-hidden="true" />
							)}
							{remote.upstream ? t('Push') : t('Publish branch')}
							{ahead > 0 && (
								<span className={styles.count} aria-hidden="true">
									{ahead}
								</span>
							)}{' '}
							<kbd>P</kbd>
						</button>
					</>
				)}
				<button disabled={busy} onClick={() => void run(async () => {})}>
					<RefreshCw size={14} aria-hidden="true" />
					{t('Refresh')}
				</button>
			</div>
			{remoteNotice && (
				<p className={styles.remoteNotice} role="status">
					<CircleCheck size={16} aria-hidden="true" />
					{t(remoteNotice.message, remoteNotice.values)}
				</p>
			)}
			<div className={styles.content}>
				<aside className={styles.sidebar}>
					<CommitComposer
						messageId={messageId}
						input={input}
						message={message}
						setMessage={setMessage}
						busy={busy}
						stagedCount={stagedCount}
						canCommit={canCommit}
						hint={commitHint()}
						commit={commit}
					/>
					<div className={styles.listToolbar}>
						<strong>{t('Changed files')}</strong>
						<button disabled={busy || !unstagedCount} onClick={stageAll}>
							{t('Stage all (S)')}
						</button>
					</div>
					<div
						ref={list}
						className={`${styles.list} ${styles.changesList}`}
						role="listbox"
						aria-label={t('Changed files')}
						tabIndex={0}
						aria-activedescendant={
							selectedIndex >= 0 ? `git-change-${selectedIndex}` : undefined
						}
						onKeyDown={listKeyDown}
						onScroll={
							virtual.rows
								? (event) => virtual.scrolled(event.currentTarget)
								: undefined
						}
					>
						{virtual.rows ? (
							<div
								role="presentation"
								className={styles.virtualRows}
								style={{ height: virtual.height }}
							>
								{virtual.rows.map(({ index, top }) => (
									<div
										key={index}
										role="presentation"
										data-virtual-row={index}
										style={{ top }}
									>
										{changeRow(index)}
									</div>
								))}
							</div>
						) : (
							changes.map((_, index) => changeRow(index))
						)}
						{status && !changes.length && <p>{t('Working tree clean.')}</p>}
					</div>
				</aside>
				<div className={styles.preview} data-git-preview>
					<div className={styles.toolbar}>
						{current && (
							<small className={styles.currentBadge}>
								{current.staged ? t('Staged') : t('Working tree')}
							</small>
						)}
						<span
							title={
								current?.original
									? `${current.original} → ${current.path}`
									: current?.path
							}
						>
							{current?.path || t('Diff')}
						</span>
						<button disabled={busy || !current} onClick={stage}>
							{current?.staged ? t('Unstage (u)') : t('Stage (s)')}
						</button>
					</div>
					<GitDiff
						key={selected}
						workspaceId={workspaceId}
						path={current?.path || ''}
						diff={t(diff)}
						label={t('Git diff')}
						beforeLabel={current?.staged ? 'HEAD' : t('Index')}
						afterLabel={current?.staged ? t('Index · Staged') : t('Working tree')}
					/>
				</div>
			</div>
			{error && (
				<p className={styles.error} role="alert">
					{errorMessage(error)}
				</p>
			)}
			{notice && (
				<pre className={styles.notice} role="status">
					{t(notice)}
				</pre>
			)}
			<ShortcutsFooter />
		</section>
	);
}

/**
 * How the branch stands against its upstream: up to date, or how many commits there are to
 * push (↑) and to pull (↓), as of the last fetch.
 */
export function SyncChip({
	upstream,
	ahead,
	behind,
	known
}: {
	/** The upstream branch; empty while the branch is unpublished. */
	upstream: string;
	ahead: number;
	behind: number;
	/** Whether the upstream has been fetched, so the counts are known. */
	known: boolean;
}): React.JSX.Element | null {
	const t = useI18n();
	if (!upstream) {
		return <small className={styles.syncChip}>{t('Not published')}</small>;
	}
	if (!known) {
		return null;
	}
	if (!ahead && !behind) {
		return (
			<small className={styles.syncChip} data-state="synced">
				<Check size={12} aria-hidden="true" />
				{t('Up to date')}
			</small>
		);
	}
	return (
		<small
			className={styles.syncChip}
			data-state="pending"
			aria-label={t('{ahead} to push · {behind} to pull', { ahead, behind })}
		>
			{ahead > 0 && (
				<span data-direction="ahead">
					<ArrowUp size={12} aria-hidden="true" />
					{ahead}
				</span>
			)}
			{behind > 0 && (
				<span data-direction="behind">
					<ArrowDown size={12} aria-hidden="true" />
					{behind}
				</span>
			)}
		</small>
	);
}

/** The commit message and the button that commits the staged changes. */
function CommitComposer({
	messageId,
	input,
	message,
	setMessage,
	busy,
	stagedCount,
	canCommit,
	hint,
	commit
}: {
	messageId: string;
	input: RefObject<HTMLTextAreaElement | null>;
	message: string;
	setMessage: (message: string) => void;
	busy: boolean;
	stagedCount: number;
	/** Something is staged, or a merge waits for its commit. */
	canCommit: boolean;
	/** What the button does now, shown below it. */
	hint: string;
	commit: () => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<div className={styles.composer}>
			<div className={styles.composerHeading}>
				<label htmlFor={messageId}>{t('Commit message')}</label>
				<kbd>Ctrl+Enter</kbd>
			</div>
			<textarea
				id={messageId}
				ref={input}
				placeholder={t('Summarize your changes…')}
				maxLength={10000}
				value={message}
				readOnly={busy}
				onChange={(event) => setMessage(event.target.value)}
				aria-describedby={`${messageId}-hint`}
			/>
			<button
				className={styles.commitButton}
				disabled={busy || !message.trim() || !canCommit}
				onClick={commit}
				aria-describedby={`${messageId}-hint`}
			>
				<Check size={15} aria-hidden="true" />
				{t('Commit staged')}
				<span className={styles.count} aria-hidden="true">
					{stagedCount}
				</span>
			</button>
			<p id={`${messageId}-hint`} className={styles.commitHint}>
				{hint}
			</p>
		</div>
	);
}

/** A changed file, after the heading of its group (staged or not) when it starts one. */
function ChangeRow({
	change,
	index,
	total,
	heading,
	count,
	selected,
	onSelect
}: {
	change: GitChange;
	index: number;
	total: number;
	heading: boolean;
	/** The number of changes in the group. */
	count: number;
	selected: boolean;
	onSelect: () => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<div>
			{heading && (
				<h3 aria-label={change.staged ? t('Staged changes') : t('Changes')}>
					{change.staged ? t('Staged changes') : t('Changes')}
					<span className={styles.count} aria-hidden="true">
						{count}
					</span>
				</h3>
			)}
			<div
				id={`git-change-${index}`}
				role="option"
				aria-selected={selected}
				aria-posinset={index + 1}
				aria-setsize={total}
				className={`${styles.change} ${styles.fileEntry}`}
				aria-label={change.path}
				title={change.original ? `${change.original} → ${change.path}` : change.path}
				onClick={onSelect}
			>
				<FileIcon path={change.path} />
				<span className={styles.fileName}>
					<strong>{fileName(change.path)}</strong>
					{change.path.includes('/') && <small>{folderName(change.path)}</small>}
				</span>
				<b className={styles.statusBadge} data-status={change.status}>
					{change.status}
				</b>
			</div>
		</div>
	);
}

/** What the panel covers, and its keys behind a disclosure. */
function ShortcutsFooter(): React.JSX.Element {
	const t = useI18n();
	return (
		<footer className={styles.changesFooter}>
			<span>{t('Saved files only · Changes cover the entire repository.')}</span>
			<details className={styles.shortcuts}>
				<summary tabIndex={0}>{t('Keyboard shortcuts')}</summary>
				<div>
					<p>
						{t(
							'j/k Select · s Stage · S Stage all · u Unstage · r Refresh · c Message · f Fetch · p Pull · P Push · Esc Close'
						)}
					</p>
					<p>
						{t(
							'Ctrl+H/L List / Diff · j/k Scroll diff · Ctrl+D/U Half page · Ctrl+F/B Page · g/G Top / Bottom · n/N Next / Previous change'
						)}
					</p>
				</div>
			</details>
		</footer>
	);
}
