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
import type { GitChange, GitStatus } from '../../../shared/types';
import { useGitDiff } from './useGitDiff';

export const gitChangeKey = (change: GitChange): string => `${change.staged}:${change.path}`;
const key = gitChangeKey;

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
} {
	const [status, setStatus] = useState<GitStatus>();
	const [selected, setSelected] = useState('');
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [busy, setBusy] = useState(true);
	const locked = useRef(false);
	const changes = useMemo(
		() => [...(status?.changes || [])].sort((a, b) => Number(b.staged) - Number(a.staged)),
		[status]
	);
	const current = changes.find((change) => key(change) === selected);
	const stagedCount = changes.filter((change) => change.staged).length;
	const unstagedCount = changes.length - stagedCount;

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

	async function refresh(): Promise<void> {
		applyStatus(await window.nido.gitStatus(workspaceId));
	}

	async function run(action: () => Promise<unknown>): Promise<void> {
		if (locked.current) {
			return;
		}
		locked.current = true;
		setBusy(true);
		setError('');
		setNotice('');
		try {
			await action();
			await refresh();
		} catch (failure) {
			setError(
				String(failure).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
			);
		} finally {
			locked.current = false;
			setBusy(false);
		}
	}

	useLayoutEffect(() => {
		onBusyChange?.(busy);
	}, [busy, onBusyChange]);

	useEffect(() => {
		let cancelled = false;
		locked.current = true;
		void window.nido
			.gitStatus(workspaceId)
			.then(
				(next) => {
					if (!cancelled) {
						applyStatus(next);
					}
				},
				(failure) => {
					if (!cancelled) {
						setError(
							String(failure).replace(
								/^Error: Error invoking remote method '[^']+': Error: /,
								''
							)
						);
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

	return {
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
	};
}
