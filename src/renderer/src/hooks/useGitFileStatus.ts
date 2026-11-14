import { onNidoEvent } from '../nidoEvents';
import { useEffect, useMemo, useState } from 'react';
import type { BufferInfo } from '../../../shared/types';

import { gitFileKey, type Decoration } from '../fileDecorations';
export { gitFileKey, type Decoration } from '../fileDecorations';

const emptyDecorations: Record<string, Decoration> = {};

/** Names of Git's one-letter statuses, used in the decoration's tooltip. */
const statusLabels: Record<string, string> = {
	'?': 'Untracked',
	U: 'Conflict',
	M: 'Modified',
	A: 'Added',
	D: 'Deleted',
	R: 'Renamed',
	C: 'Copied',
	T: 'Type changed'
};

/**
 * Git status marks for the explorer and tabs, keyed by gitFileKey. Polls git status every 3
 * seconds, slowing down to 30 seconds while nothing changes, and refreshes at once when the
 * window gains focus or files change.
 */
export function useGitFileStatus(
	workspaceId: string,
	buffers: BufferInfo[]
): Record<string, Decoration> {
	const [result, setResult] = useState<{
		workspaceId: string;
		decorations: Record<string, Decoration>;
	}>();
	const files = useMemo(
		() => JSON.stringify(buffers.map(({ name, modified }) => [name, modified])),
		[buffers]
	);

	useEffect(() => {
		if (!workspaceId) {
			return;
		}
		let cancelled = false;
		let pending = false;
		let queued = false;
		let timer: number | undefined;
		let interval = 3000;
		let snapshot: string | undefined;
		const refresh = async (activity = false): Promise<void> => {
			if (cancelled) {
				return;
			}
			window.clearTimeout(timer);
			if (activity) {
				interval = 3000;
				snapshot = undefined;
			}
			if (document.hidden) {
				timer = window.setTimeout(() => void refresh(), interval);
				return;
			}
			if (pending) {
				queued = true;
				return;
			}
			pending = true;
			try {
				const status = await window.nido.gitStatus(workspaceId);
				const next: Record<string, Decoration> = {};
				// Worktree changes take precedence over the staged version of the same file.
				for (const change of [...status.changes].sort(
					(a, b) => Number(b.staged) - Number(a.staged)
				)) {
					// Untracked files (? in Git) are marked U.
					const code = change.status === '?' ? 'U' : change.status;
					const label = statusLabels[change.status] || change.status;
					next[gitFileKey(`${status.root}/${change.path}`)] = {
						code,
						title: `Git: ${label}${change.staged ? ' (staged)' : ''}`
					};
				}
				if (!cancelled) {
					const signature = JSON.stringify(next);
					interval = signature === snapshot ? Math.min(30_000, interval * 2) : 3000;
					snapshot = signature;
					setResult((previous) => {
						const paths = Object.keys(next);
						if (
							previous?.workspaceId === workspaceId &&
							Object.keys(previous.decorations).length === paths.length &&
							paths.every(
								(path) =>
									previous.decorations[path]?.code === next[path].code &&
									previous.decorations[path]?.title === next[path].title
							)
						) {
							return previous;
						}
						return { workspaceId, decorations: next };
					});
				}
			} catch {
				// A failed refresh says nothing about file status; keep the last successful snapshot.
				interval = 3000;
			} finally {
				pending = false;
				if (queued) {
					queued = false;
					void refresh();
				} else if (!cancelled) {
					timer = window.setTimeout(() => void refresh(), interval);
				}
			}
		};
		const initial = window.setTimeout(() => void refresh(), 200);
		// Back off unchanged snapshots, retaining polling for external Git commands.
		const focus = (): void => {
			void refresh(true);
		};
		window.addEventListener('focus', focus);
		document.addEventListener('visibilitychange', focus);
		const unsubscribe = onNidoEvent((event) => {
			if (event.type === 'filesChanged' && event.id === workspaceId) {
				void refresh(true);
			}
		});
		return () => {
			cancelled = true;
			window.clearTimeout(initial);
			window.clearTimeout(timer);
			window.removeEventListener('focus', focus);
			document.removeEventListener('visibilitychange', focus);
			unsubscribe();
		};
	}, [workspaceId, files]);

	return result?.workspaceId === workspaceId ? result.decorations : emptyDecorations;
}
