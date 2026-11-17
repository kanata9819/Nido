import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction
} from 'react';
import type { GitChange, GitRemoteAction, GitRemoteInfo, GitStatus } from '../../../shared/types';
import { useGitDiff } from './useGitDiff';

/** The outcome of the last remote action, shown as a banner: an English message and its values. */
export interface GitRemoteNotice {
	message: string;
	values: Record<string, string | number>;
}

/** Identifies a change in the list; a file can be both staged and unstaged. */
export const gitChangeKey = (change: GitChange): string => `${change.staged}:${change.path}`;
const key = gitChangeKey;

/** State and Git actions of the Git panel. */
export function useGitPanel({
	workspaceId,
	onBusyChange,
	message,
	setMessage
}: {
	workspaceId: string;
	onBusyChange?: (busy: boolean) => void;
	message: string;
	setMessage: (message: string) => void;
}): {
	status: GitStatus | undefined;
	selected: string;
	setSelected: Dispatch<SetStateAction<string>>;
	error: string;
	notice: string;
	remoteNotice: GitRemoteNotice | undefined;
	busy: boolean;
	changes: GitChange[];
	current: GitChange | undefined;
	stagedCount: number;
	unstagedCount: number;
	diff: string;
	run: (action: () => Promise<unknown>) => Promise<void>;
	stage: () => void;
	stageAll: () => void;
	commit: () => void;
	remoteAction: (action: GitRemoteAction) => void;
} {
	const [status, setStatus] = useState<GitStatus>();
	const [selected, setSelected] = useState('');
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [remoteNotice, setRemoteNotice] = useState<GitRemoteNotice>();
	const [busy, setBusy] = useState(true);
	// Set while an action runs, so a second one cannot start before React re-renders.
	const locked = useRef(false);
	// Staged changes first, then unstaged ones.
	const changes = useMemo(
		() => [...(status?.changes || [])].sort((a, b) => Number(b.staged) - Number(a.staged)),
		[status]
	);
	const current = changes.find((change) => key(change) === selected);
	const stagedCount = changes.filter((change) => change.staged).length;
	const unstagedCount = changes.length - stagedCount;

	// Show a new status, keeping the selection on the same change, or the same file on the other
	// side when it was staged or unstaged, or else the first change.
	const applyStatus = useCallback((next: GitStatus): void => {
		setStatus(next);
		setSelected((previous) => {
			const first =
				next.changes.find((change) => key(change) === previous) ||
				next.changes.find(
					(change) => change.path === previous.slice(previous.indexOf(':') + 1)
				) ||
				next.changes[0];
			if (first) {
				return key(first);
			}
			return '';
		});
	}, []);

	async function refresh(): Promise<GitStatus> {
		const next = await window.nido.gitStatus(workspaceId, true);
		applyStatus(next);
		return next;
	}

	/** Run one Git action at a time, then reload the status and pass it to `after`. */
	async function run<T>(
		action: () => Promise<T>,
		after?: (next: GitStatus, result: T) => void
	): Promise<void> {
		if (locked.current) {
			return;
		}
		locked.current = true;
		setBusy(true);
		setError('');
		setNotice('');
		setRemoteNotice(undefined);
		try {
			const result = await action();
			const next = await refresh();
			after?.(next, result);
		} catch (failure) {
			setError(String(failure));
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}

	useLayoutEffect(() => {
		onBusyChange?.(busy);
	}, [busy, onBusyChange]);

	// Load the status when the panel opens or the workspace changes.
	useEffect(() => {
		let cancelled = false;
		locked.current = true;
		void window.nido
			.gitStatus(workspaceId, true)
			.then(
				(next) => {
					if (!cancelled) {
						applyStatus(next);
					}
				},
				(failure) => {
					if (!cancelled) {
						setError(String(failure));
					}
				}
			)
			.finally(() => {
				if (!cancelled) {
					locked.current = false;
					setBusy(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, applyStatus]);

	const diff = useGitDiff(workspaceId, current, status);

	/** Stage the selected change, or unstage it when it is staged. */
	function stage(): void {
		if (current) {
			void run(() => window.nido.gitStage(workspaceId, current.path, current.staged));
		}
	}

	function commit(): void {
		if (!message.trim() || !stagedCount) {
			return;
		}
		void run(async () => {
			const result = await window.nido.gitCommit(workspaceId, message);
			setMessage('');
			setNotice(result);
		});
	}

	function stageAll(): void {
		if (unstagedCount) {
			void run(() => window.nido.gitStageAll(workspaceId));
		}
	}

	/** A rejected Pull can still fetch, and Fetch all can update some remotes before failing. */
	const runRemote: typeof run = (action, after) =>
		run(
			() =>
				action().catch(async (failure) => {
					// Keep the action's error if refreshing the comparison also fails.
					await refresh().catch(() => {});
					throw failure;
				}),
			after
		);

	function remoteAction(action: GitRemoteAction): void {
		const target = status?.remote;
		const before = status?.sync;
		if (target) {
			void runRemote(
				() => window.nido.gitRemoteAction(workspaceId, action, target),
				(next, pulled) =>
					setRemoteNotice(remoteResult(action, target, before, next, pulled))
			);
		}
	}

	return {
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
		diff,
		run,
		stage,
		stageAll,
		commit,
		remoteAction
	};
}

/** What a finished push, pull or fetch did, from the sync state before and after it. */
function remoteResult(
	action: GitRemoteAction,
	target: GitRemoteInfo,
	before: GitStatus['sync'],
	next: GitStatus,
	pulled: number | undefined
): GitRemoteNotice {
	const sync = next.sync;
	const destination = sync?.upstream || '';
	if (action === 'push') {
		if (!target.upstream) {
			return {
				message: destination ? 'Published {branch} to {upstream}.' : 'Published {branch}.',
				values: { branch: next.branch, upstream: destination }
			};
		}
		const count = before?.ahead ?? 0;
		return count
			? {
					message:
						count === 1
							? 'Pushed 1 commit to {upstream}.'
							: 'Pushed {count} commits to {upstream}.',
					values: { count, upstream: destination }
				}
			: {
					message: 'Push complete. {upstream} is up to date.',
					values: { upstream: destination }
				};
	}
	if (action === 'pull') {
		if (pulled === undefined) {
			return { message: 'Pull complete.', values: {} };
		}
		const count = pulled;
		return count
			? {
					message:
						count === 1
							? 'Pulled 1 commit from {upstream}.'
							: 'Pulled {count} commits from {upstream}.',
					values: {
						count,
						upstream:
							destination ||
							`${target.remote}/${target.upstream.slice('refs/heads/'.length)}`
					}
				}
			: { message: 'Pull complete. Already up to date.', values: {} };
	}
	const behind = sync?.behind ?? 0;
	return behind
		? {
				message:
					behind === 1
						? 'Fetch complete. 1 commit to pull.'
						: 'Fetch complete. {count} commits to pull.',
				values: { count: behind }
			}
		: { message: 'Fetch complete.', values: {} };
}
