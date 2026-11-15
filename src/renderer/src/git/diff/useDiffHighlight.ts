import { useEffect, useState } from 'react';
import type { ReferencePreview } from '../../../../shared/types';
import type { DiffRow } from './splitDiff';
import { hasLines, type SideSource } from './diffModel';

/** Syntax-highlighted lines of the before and after sides. */
export type HighlightedSides = ReferencePreview['lines'][];

/**
 * Highlight both sides of a diff with the workspace's Neovim. Until it answers, `lines` is
 * undefined and the diff is shown in plain text; `error` says when highlighting failed.
 */
export function useDiffHighlight(
	workspaceId: string,
	path: string,
	diff: string,
	rows: DiffRow[],
	sources: [SideSource, SideSource]
): { lines?: HighlightedSides; error: string } {
	const [highlighted, setHighlighted] = useState<{
		workspaceId: string;
		path: string;
		diff: string;
		lines?: HighlightedSides;
		error?: string;
	}>();
	useEffect(() => {
		let cancelled = false;
		if (!path || !hasLines(rows)) {
			return;
		}
		const result = (outcome: { lines?: HighlightedSides; error?: string }): void => {
			if (!cancelled) {
				setHighlighted({ workspaceId, path, diff, ...outcome });
			}
		};
		void window.nido.highlightSources(workspaceId, path, sources[0].text, sources[1].text).then(
			(lines) => result({ lines }),
			() => result({ error: 'Syntax highlighting unavailable' })
		);
		return () => {
			cancelled = true;
		};
	}, [workspaceId, path, diff, rows, sources]);
	// A result for another file or diff is stale.
	const current =
		highlighted?.workspaceId === workspaceId &&
		highlighted.path === path &&
		highlighted.diff === diff
			? highlighted
			: undefined;
	return { lines: current?.lines, error: current?.error || '' };
}
