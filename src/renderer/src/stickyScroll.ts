import type { StickyScrollState } from '../../shared/types';

export interface StickyRow {
    scope: StickyScrollState['scopes'][number];
    offset: number;
}

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
        const previous = rows.at(-1)?.scope;
        if (previous && (scope.line <= previous.line || scope.ending > previous.ending)) {
            continue;
        }
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
