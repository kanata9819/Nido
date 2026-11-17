import { useI18n } from '../i18n';
import type { GitView } from '../types';
import type { RefObject } from 'react';
import type { GitBranchEntry, GitCommitEntry, GitSyncState } from '../../../shared/types';
import { ArrowUp } from 'lucide-react';
import { handleListKey } from './listKeys';
import styles from './Git.module.css';

/**
 * The keyboard-driven list of the Git browser: commits, the files of a commit, or branches.
 * j/k and the arrows move, Ctrl+D/U and Ctrl+F/B page, Enter opens, and n creates a branch.
 */
export default function GitBrowserList({
	view,
	busy,
	commit,
	history,
	sync,
	branches,
	labels,
	listLabel,
	index,
	setIndex,
	listRef,
	open,
	setCreating
}: {
	view: GitView;
	busy: boolean;
	commit?: GitCommitEntry;
	history: GitCommitEntry[];
	/** How the history compares with its upstream, to mark unpushed commits and the upstream. */
	sync?: GitSyncState;
	branches: GitBranchEntry[];
	labels: string[];
	listLabel: string;
	index: number;
	setIndex: (index: number) => void;
	listRef: RefObject<HTMLDivElement | null>;
	open: () => void;
	setCreating: (creating: boolean) => void;
}): React.JSX.Element {
	const t = useI18n();
	// Commits and branches use two-line rows; a commit's files are plain one-line rows.
	const entryRows = view === 'branches' || (view === 'history' && !commit);
	const outgoing = new Set(sync?.outgoing);
	return (
		<div
			className={`${styles.list} ${entryRows ? styles.historyList : ''}`}
			ref={listRef}
			role="listbox"
			aria-label={listLabel}
			tabIndex={0}
			aria-activedescendant={labels[index] ? `git-entry-${index}` : undefined}
			onKeyDown={(event) => {
				if (busy) {
					return;
				}
				const count = labels.length;
				if (handleListKey(event, { count, index, setIndex, open })) {
					return;
				}
				if (view === 'branches' && event.key === 'n' && !event.ctrlKey && !event.altKey) {
					event.preventDefault();
					setCreating(true);
				}
			}}
		>
			{labels.map((label, position) => (
				<div
					key={label}
					id={`git-entry-${position}`}
					role="option"
					aria-selected={index === position}
					className={`${styles.change} ${entryRows ? styles.historyEntry : ''}`}
					title={label}
					aria-label={commit && view === 'history' ? label : undefined}
					ref={(node) => {
						if (node && index === position) {
							node.scrollIntoView({ block: 'nearest' });
						}
					}}
					onClick={() => {
						setIndex(position);
						listRef.current?.focus();
					}}
					onDoubleClick={open}
				>
					{view === 'history' && !commit ? (
						<>
							<strong className={styles.commitSubject}>
								{history[position].subject}
							</strong>
							<div className={styles.commitMeta}>
								<code className={styles.hashBadge}>
									{history[position].hash.slice(0, 8)}
								</code>
								<span>{history[position].author}</span>
								{outgoing.has(history[position].hash) && (
									<span className={styles.outgoingBadge}>
										<ArrowUp size={10} aria-hidden="true" />
										{t('Not pushed')}
									</span>
								)}
								{sync?.head === history[position].hash && (
									<span className={styles.upstreamBadge}>{sync.upstream}</span>
								)}
							</div>
						</>
					) : view === 'branches' ? (
						<>
							<strong className={styles.commitSubject}>
								{branches[position].name}
							</strong>
							<div className={styles.commitMeta}>
								<span className={styles.branchBadge}>
									{branches[position].remote ? t('Remote') : t('Local')}
								</span>
								{branches[position].current && (
									<span className={styles.currentBadge}>{t('Current')}</span>
								)}
							</div>
						</>
					) : commit ? (
						<FileLabel path={label} />
					) : (
						<span>{label}</span>
					)}
				</div>
			))}
			{!labels.length && !busy && (
				<p>
					{commit
						? t('No changed files.')
						: view === 'history'
							? t('No commits yet.')
							: t('No branches yet. Press n to create one.')}
				</p>
			)}
		</div>
	);
}

/** A changed file of a commit: its name first, then the folder it is in, dimmed. */
function FileLabel({ path }: { path: string }): React.JSX.Element {
	const slash = path.lastIndexOf('/');
	return (
		<span className={styles.filePath}>
			<strong>{path.slice(slash + 1)}</strong>
			{/* Long folders are cut at the start, keeping the part nearest the file. */}
			{slash > 0 && (
				<small>
					<bdi>{path.slice(0, slash)}</bdi>
				</small>
			)}
		</span>
	);
}
