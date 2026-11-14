import type { StickyScrollState } from '../../shared/types';

/** A sticky header and how far it is pushed up (0 or negative) by the end of its scope. */
export interface StickyRow {
	scope: StickyScrollState['scopes'][number];
	offset: number;
}

/**
 * The headers to pin above the editor, outermost first: each scope that starts above the top
 * of the window and has not ended yet. At most `maxLines`, and at most a quarter of the
 * window. `rowY` gives a grid row's pixel position; `motionOffset` is the smooth-scroll offset.
 */
export function stickyRows(
	state: StickyScrollState,
	rowY: (row: number) => number,
	top: number,
	lineHeight: number,
	maxLines: number,
	motionOffset = 0
): StickyRow[] {
	const limit = Math.min(maxLines, Math.max(1, Math.floor(state.height / 4)));
	const rows: StickyRow[] = [];
	for (const scope of state.scopes) {
		// Only nested scopes stack: skip ones that are not inside the previous header's scope.
		const previous = rows.at(-1)?.scope;
		if (previous && (scope.line <= previous.line || scope.ending > previous.ending)) {
			continue;
		}
		// The header is shown while its first line is above this slot and its last line below it.
		const position = top + rows.length * lineHeight;
		const start = scope.top < 0 ? -Infinity : rowY(scope.top) + motionOffset;
		const end = rowY(scope.bottom) + motionOffset;
		if (start >= position || end <= position) {
			continue;
		}
		rows.push({ scope, offset: Math.min(0, end - position - lineHeight) });
		if (rows.length === limit) {
			break;
		}
	}
	return rows;
}
