import { useEffect, useState } from 'react';
import type { GitBranchEntry, GitCommitEntry, GitStatus } from '../../../../shared/types';
import type { GitView } from '../../types';

/** The commit history and branches the Git browser lists, and the current branch. */
export interface GitLists {
	history: GitCommitEntry[];
	/** How many commits the history has in all; undefined until known. */
	commitCount: number | undefined;
	hasMoreHistory: boolean;
	branches: GitBranchEntry[];
	setBranches: (branches: GitBranchEntry[]) => void;
	branchName: string;
	/** The upstream of the branch and how the history compares with it (history view only). */
	remote: Pick<GitStatus, 'remote' | 'sync'>;
	setBranchName: (name: string) => void;
	/** Whether the data of `view` at `revision` has loaded. */
	loaded: boolean;
	/** Load the next older page of history. */
	loadOlderHistory: () => Promise<void>;
}

/**
 * Load the history or branches whenever the view changes or `revision` grows. A failure is
 * shown with `setError`; `focusList` runs as each load starts.
 */
export function useGitLists({
	workspaceId,
	view,
	revision,
	setError,
	focusList
}: {
	workspaceId: string;
	view: GitView;
	revision: number;
	setError: (error: string) => void;
	focusList: () => void;
}): GitLists {
	const [history, setHistory] = useState<GitCommitEntry[]>([]);
	const [commitCount, setCommitCount] = useState<number>();
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [branches, setBranches] = useState<GitBranchEntry[]>([]);
	const [branchName, setBranchName] = useState('');
	const [remote, setRemote] = useState<Pick<GitStatus, 'remote' | 'sync'>>({});
	// The view and revision whose data has loaded.
	const [loadedView, setLoadedView] = useState<{ view: GitView; revision: number }>();

	useEffect(() => {
		if (view === 'changes') {
			return;
		}
		let cancelled = false;
		async function load(): Promise<void> {
			try {
				const status = await window.nido.gitStatus(workspaceId, view === 'history');
				if (view === 'history') {
					const { commits: entries, total } = await window.nido.gitHistory(
						workspaceId,
						0
					);
					if (!cancelled) {
						setHistory(entries);
						setCommitCount(total);
						setHasMoreHistory(entries.length < total);
					}
				} else {
					const entries = await window.nido.gitBranches(workspaceId);
					if (!cancelled) {
						setBranches(entries);
					}
				}
				if (!cancelled) {
					setBranchName(status.branch);
					setRemote({ remote: status.remote, sync: status.sync });
				}
			} catch (failure) {
				if (!cancelled) {
					setCommitCount(undefined);
					setError(String(failure));
				}
			} finally {
				if (!cancelled) {
					setLoadedView({ view, revision });
				}
			}
		}
		void load();
		focusList();
		return () => {
			cancelled = true;
		};
		// The callbacks only report and focus; a new one must not reload the lists.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view, revision, workspaceId]);

	async function loadOlderHistory(): Promise<void> {
		const { commits: entries, total } = await window.nido.gitHistory(
			workspaceId,
			history.length
		);
		setHistory([...history, ...entries]);
		setCommitCount(total);
		setHasMoreHistory(history.length + entries.length < total);
	}

	return {
		history,
		commitCount,
		hasMoreHistory,
		branches,
		setBranches,
		branchName,
		remote,
		setBranchName,
		loaded: loadedView?.view === view && loadedView.revision === revision,
		loadOlderHistory
	};
}
