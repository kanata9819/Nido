import { useErrorMessage, useI18n } from '../i18n';
import type { GitView } from '../types';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { PanelHeadingSlot } from '../ui/panelHeading';
import type { GitBranchEntry, GitCommitEntry, GitStatus } from '../../../shared/types';
import GitPanel, { SyncChip } from './GitPanel';
import GitBrowserList from './GitBrowserList';
import { CommitDetails, BranchDetails } from './GitDetails';
import { useGitBrowserKeyboard } from './useGitBrowserKeyboard';
import GitDiff from './GitDiff';
import { useGitAction } from './browser/useGitAction';
import { useGitLists } from './browser/useGitLists';
import { useCommitDiff } from './browser/useCommitDiff';
import styles from './Git.module.css';

/**
 * The Git browser (Space g): the changes view (GitPanel), the commit history with each
 * commit's files and diffs, and the branches, switched with 1/2/3.
 */
export default function GitBrowser({
	workspaceId,
	onClose
}: {
	workspaceId: string;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [view, setView] = useState<GitView>('changes');
	const [message, setMessage] = useState('');
	// Grows to reload the history or branches view.
	const [revision, setRevision] = useState(0);
	// The commit opened from the history; its changed files replace the history in the list.
	const [commit, setCommit] = useState<GitCommitEntry>();
	const [files, setFiles] = useState<string[]>([]);
	const [index, setIndex] = useState(0);
	const [newBranchName, setNewBranchName] = useState('');
	const [creating, setCreating] = useState(false);
	const list = useRef<HTMLDivElement>(null);
	const branchInput = useRef<HTMLInputElement>(null);
	const action = useGitAction();
	const { run, error, setError } = action;

	useEffect(() => {
		if (creating) {
			branchInput.current?.focus();
		}
	}, [creating]);
	const lists = useGitLists({
		workspaceId,
		view,
		revision,
		setError,
		focusList: () => list.current?.focus()
	});
	const { history, branches } = lists;
	// The browser is busy while an action runs, or until the view's data has loaded.
	const busy = action.working || (view !== 'changes' && !lists.loaded);
	const path = files[index];
	const diff = useCommitDiff(workspaceId, commit, path);

	/** Leave the open commit, selecting it again in the history. */
	function closeCommit(entry: GitCommitEntry): void {
		setIndex(
			Math.max(
				0,
				history.findIndex((candidate) => candidate.hash === entry.hash)
			)
		);
		setCommit(undefined);
		setFiles([]);
	}

	/** Esc: close the new branch form, leave the open commit, or close the browser. */
	function returnToPreviousView(): void {
		if (creating) {
			setCreating(false);
		} else if (commit) {
			closeCommit(commit);
		} else {
			onClose();
			return;
		}
		list.current?.focus();
	}

	/** Switch to another view, starting it fresh. */
	function changeView(next: GitView): void {
		if (busy) {
			return;
		}
		if (next !== view) {
			setRevision((value) => value + 1);
		}
		setView(next);
		setCommit(undefined);
		setFiles([]);
		setIndex(0);
		setCreating(false);
		setError('');
	}

	/** Reload the current view from the start. */
	function refresh(): void {
		setCommit(undefined);
		setFiles([]);
		setIndex(0);
		setError('');
		setRevision((value) => value + 1);
	}

	/** Switch to (or with `create`, create) a branch, then reload the branch list. */
	function switchBranch(branch: string, create: boolean): void {
		void run(async () => {
			await window.nido.gitSwitch(workspaceId, branch, create);
			setCreating(false);
			setNewBranchName('');
			lists.setBranches(await window.nido.gitBranches(workspaceId));
			lists.setBranchName((await window.nido.gitStatus(workspaceId)).branch);
			list.current?.focus();
		});
	}

	/** Enter: switch to the selected branch, or open the selected commit's files. */
	function openSelection(): void {
		if (view === 'branches' && branches[index]) {
			const branch = branches[index];
			switchBranch(`refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`, false);
		} else if (view === 'history' && !commit && history[index]) {
			const entry = history[index];
			void run(async () => {
				const paths = await window.nido.gitCommitFiles(workspaceId, entry.hash);
				setCommit(entry);
				setFiles(paths);
				setIndex(0);
				list.current?.focus();
			});
		}
	}

	const labels = listLabels(view, commit, files, history, branches);
	const listLabel =
		view === 'branches' ? t('Branches') : commit ? t('Commit files') : t('Commit history');

	useGitBrowserKeyboard({ busy, back: returnToPreviousView, changeView });

	// The views sit in the panel's heading, beside its title, to leave more room for the diff.
	const heading = useContext(PanelHeadingSlot);
	const views = <ViewTabs view={view} busy={busy} changeView={changeView} />;

	return (
		<div className={styles.panel}>
			{heading ? createPortal(views, heading) : views}
			{view === 'changes' ? (
				<GitPanel
					workspaceId={workspaceId}
					onBusyChange={action.setWorking}
					message={message}
					setMessage={setMessage}
				/>
			) : (
				<section aria-label={t('Git browser')} aria-busy={busy}>
					<div className={styles.toolbar}>
						<strong>{lists.branchName}</strong>
						{view === 'history' && !busy && lists.commitCount !== undefined && (
							<small>{t('Commits: {count}', { count: lists.commitCount })}</small>
						)}
						{view === 'history' && !busy && !commit && lists.remote.remote && (
							<HistorySync remote={lists.remote} />
						)}
						<span>
							{commit
								? t('{hash} · {subject} · Compared with first parent', {
										hash: commit.hash.slice(0, 8),
										subject: commit.subject
									})
								: view === 'history'
									? t('History of the current branch')
									: t('Local and remote-tracking branches')}
						</span>
						{commit && (
							<button disabled={busy} onClick={returnToPreviousView}>
								{t('Back (Esc)')}
							</button>
						)}
						<button disabled={busy} onClick={refresh}>
							{t('Refresh')}
						</button>
					</div>
					<div className={styles.content}>
						<GitBrowserList
							view={view}
							busy={busy}
							commit={commit}
							history={history}
							sync={lists.remote.sync}
							branches={branches}
							labels={labels}
							listLabel={listLabel}
							index={index}
							setIndex={setIndex}
							listRef={list}
							open={openSelection}
							setCreating={setCreating}
						/>
						<div className={styles.preview} data-git-preview>
							{view === 'history' && commit ? (
								<GitDiff
									key={`${commit.hash}:${path}`}
									workspaceId={workspaceId}
									path={path}
									diff={t(diff)}
									label={t('Commit diff')}
									beforeLabel={t('First parent')}
									afterLabel={commit.hash.slice(0, 8)}
								/>
							) : view === 'history' && history[index] ? (
								<CommitDetails
									entry={history[index]}
									busy={busy}
									open={openSelection}
								/>
							) : view === 'branches' && branches[index] ? (
								<BranchDetails
									entry={branches[index]}
									busy={busy}
									open={openSelection}
								/>
							) : (
								<EmptyPreview view={view} busy={busy} />
							)}
						</div>
					</div>
					<div className={styles.toolbar}>
						{!commit && (
							<button disabled={busy || !labels.length} onClick={openSelection}>
								{view === 'history'
									? t('Open commit (Enter)')
									: t('Switch branch (Enter)')}
							</button>
						)}
						{view === 'history' && !commit && lists.hasMoreHistory && (
							<button
								disabled={busy}
								onClick={() => void run(lists.loadOlderHistory)}
							>
								{t('Load older commits')}
							</button>
						)}
						{view === 'branches' && (
							<button disabled={busy} onClick={() => setCreating(true)}>
								{t('New branch (n)')}
							</button>
						)}
					</div>
					{creating && (
						<form
							className={styles.commit}
							onSubmit={(event) => {
								event.preventDefault();
								switchBranch(newBranchName, true);
							}}
						>
							<input
								ref={branchInput}
								autoFocus
								aria-label={t('New branch name')}
								placeholder={t('New branch name')}
								value={newBranchName}
								onChange={(event) => setNewBranchName(event.target.value)}
							/>
							<button disabled={busy || !newBranchName.trim()} type="submit">
								{t('Create and switch')}
							</button>
						</form>
					)}
					{error && (
						<p role="alert" className={styles.error}>
							{errorMessage(error)}
						</p>
					)}
					<footer>
						{t(
							'1/2/3 Views · Ctrl+H/L List / Diff · j/k Select / Scroll · Ctrl+D/U Half page · Ctrl+F/B Page · g/G Top / Bottom · n/N Next / Previous change · Tab Move focus · Esc Back / Close'
						)}
					</footer>
				</section>
			)}
		</div>
	);
}

/**
 * How the history compares with the upstream branch: the commits to push and to pull, with
 * the upstream named, so the history rows' badges read against it.
 */
function HistorySync({
	remote: { remote, sync }
}: {
	remote: Pick<GitStatus, 'remote' | 'sync'>;
}): React.JSX.Element | null {
	const t = useI18n();
	if (!remote) {
		return null;
	}
	const ahead = sync?.ahead ?? 0;
	const behind = sync?.behind ?? 0;
	const summary = !remote.upstream
		? t('Not on {remote} yet', { remote: remote.remote })
		: !sync
			? t('Fetch to compare with {remote}', { remote: remote.remote })
			: !ahead && !behind
				? t('In sync with {upstream}', { upstream: sync.upstream })
				: [
						ahead &&
							t('{count} ahead of {upstream}', {
								count: ahead,
								upstream: sync.upstream
							}),
						behind && t('{count} behind', { count: behind })
					]
						.filter(Boolean)
						.join(' · ');
	return (
		<>
			{remote.upstream && sync && (
				<SyncChip upstream={remote.upstream} ahead={ahead} behind={behind} known />
			)}
			<small className={styles.syncSummary}>{summary}</small>
		</>
	);
}

/** The text of each list row, also used as its key and title. */
function listLabels(
	view: GitView,
	commit: GitCommitEntry | undefined,
	files: string[],
	history: GitCommitEntry[],
	branches: GitBranchEntry[]
): string[] {
	if (view === 'branches') {
		return branches.map(
			(branch) =>
				`${branch.current ? '● ' : ''}${branch.remote ? '[remote] ' : ''}${branch.name}`
		);
	}
	if (commit) {
		return files;
	}
	return history.map((entry) => `${entry.hash.slice(0, 8)}  ${entry.subject}`);
}

/** The buttons of the changes, history and branches views, each with its key (1, 2 or 3). */
function ViewTabs({
	view,
	busy,
	changeView
}: {
	view: GitView;
	busy: boolean;
	changeView: (view: GitView) => void;
}): React.JSX.Element {
	const t = useI18n();
	const tabs = [
		{ view: 'changes', title: t('Changes') },
		{ view: 'history', title: t('History') },
		{ view: 'branches', title: t('Branches') }
	] as const;
	return (
		<nav className={styles.viewTabs} aria-label={t('Git views')}>
			{tabs.map(({ view: tab, title }, shortcutIndex) => (
				<button
					key={title}
					disabled={busy}
					aria-current={view === tab ? 'page' : undefined}
					aria-keyshortcuts={String(shortcutIndex + 1)}
					onClick={() => changeView(tab)}
				>
					{title}
					<kbd aria-hidden="true">{shortcutIndex + 1}</kbd>
				</button>
			))}
		</nav>
	);
}

/** The preview when nothing is selected. */
function EmptyPreview({ view, busy }: { view: GitView; busy: boolean }): React.JSX.Element {
	const t = useI18n();
	const Icon = view === 'branches' ? GitBranch : GitCommitHorizontal;
	return (
		<div className={styles.emptyPreview} tabIndex={0} aria-busy={busy}>
			{!busy && <Icon size={34} aria-hidden="true" />}
			{!busy && <p>{t('Nothing to preview yet.')}</p>}
		</div>
	);
}
