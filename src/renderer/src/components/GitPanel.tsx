import { useErrorMessage, useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { Check, GitBranch, RefreshCw } from 'lucide-react';
import styles from '../assets/GitPanel.module.css';
import GitDiff from './GitDiff';
import FileIcon from './FileIcon';
import { gitChangeKey as key, useGitPanel } from '../hooks/useGitPanel';
import { listIndex } from '../listNavigation';

/** The file name of a repository path (Git uses / on every platform). */
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** The folder of a repository path. */
const folderName = (path: string): string => path.slice(0, path.lastIndexOf('/'));

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
		busy,
		changes,
		current,
		stagedCount,
		unstagedCount,
		diff,
		run,
		stage,
		stageAll,
		commit
	} = useGitPanel({ workspaceId, onBusyChange, message, setMessage });
	const list = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selected, status]);
	useEffect(() => {
		list.current?.focus();
	}, [workspaceId]);

	// What the commit button does now, shown below it.
	const commitHint = (): string => {
		if (busy) {
			return t('Working…');
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
				<button disabled={busy} onClick={() => void run(async () => {})}>
					<RefreshCw size={14} aria-hidden="true" />
					{t('Refresh')}
				</button>
			</div>
			<div className={styles.content}>
				<aside className={styles.sidebar}>
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
							disabled={busy || !message.trim() || !stagedCount}
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
							{commitHint()}
						</p>
					</div>
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
							current ? `git-change-${changes.indexOf(current)}` : undefined
						}
						onKeyDown={(event) => {
							if (
								event.ctrlKey ||
								event.altKey ||
								event.metaKey ||
								event.nativeEvent.isComposing
							) {
								return;
							}
							const index = changes.findIndex((change) => key(change) === selected);
							const commandKey =
								event.shiftKey && event.key === 's' ? 'S' : event.key;
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
									const next = listIndex(event.key, index, changes.length);
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
							}
						}}
					>
						{changes.map((change, index) => (
							<div key={key(change)}>
								{(index === 0 || changes[index - 1].staged !== change.staged) && (
									<h3
										aria-label={
											change.staged ? t('Staged changes') : t('Changes')
										}
									>
										{change.staged ? t('Staged changes') : t('Changes')}
										<span className={styles.count} aria-hidden="true">
											{change.staged ? stagedCount : unstagedCount}
										</span>
									</h3>
								)}
								<div
									id={`git-change-${index}`}
									role="option"
									aria-selected={key(change) === selected}
									className={`${styles.change} ${styles.fileEntry}`}
									aria-label={change.path}
									title={
										change.original
											? `${change.original} → ${change.path}`
											: change.path
									}
									onClick={() => {
										setSelected(key(change));
										list.current?.focus();
									}}
								>
									<FileIcon path={change.path} />
									<span className={styles.fileName}>
										<strong>{fileName(change.path)}</strong>
										{change.path.includes('/') && (
											<small>{folderName(change.path)}</small>
										)}
									</span>
									<b className={styles.statusBadge} data-status={change.status}>
										{change.status}
									</b>
								</div>
							</div>
						))}
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
					{notice}
				</pre>
			)}
			<footer className={styles.changesFooter}>
				<span>{t('Saved files only · Changes cover the entire repository.')}</span>
				<details className={styles.shortcuts}>
					<summary tabIndex={0}>{t('Keyboard shortcuts')}</summary>
					<div>
						<p>
							{t(
								'j/k Select · s Stage · S Stage all · u Unstage · r Refresh · c Message · Esc Close'
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
		</section>
	);
}
