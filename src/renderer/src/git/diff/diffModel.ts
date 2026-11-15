// What the diff view derives from the rows of a split diff. Pure functions, so GitDiff only
// memoizes them.
import type { DiffRow } from './splitDiff';
import type { DiffLayout, DiffViewRow } from './diffView';

const layoutKey = 'nido.diffLayout';

/** The saved layout of diffs, side by side unless the inline layout was chosen. */
export function savedLayout(): DiffLayout {
	try {
		return localStorage.getItem(layoutKey) === 'unified' ? 'unified' : 'split';
	} catch {
		return 'split';
	}
}

export function saveLayout(layout: DiffLayout): void {
	try {
		localStorage.setItem(layoutKey, layout);
	} catch {
		// The layout is a convenience; it still switches for this diff.
	}
}

/** The first drawn row of each diff row, to scroll to a change. */
export function firstPositions(display: DiffViewRow[]): Map<number, number> {
	const first = new Map<number, number>();
	display.forEach((entry, position) => {
		if (entry.kind !== 'separator' && !first.has(entry.index)) {
			first.set(entry.index, position);
		}
	});
	return first;
}

/** The text of one side, for syntax highlighting, and for each row its line in that text. */
export interface SideSource {
	text: string;
	/** The line of each diff row in `text`, or -1 when the row has none on this side. */
	positions: number[];
}

/** The source of the before and after sides, in that order. */
export function sideSources(rows: DiffRow[]): [SideSource, SideSource] {
	const source = (side: 'before' | 'after'): SideSource => {
		const lines: string[] = [];
		const positions = rows.map((row) => {
			if (!row[side]) {
				return -1;
			}
			lines.push(row[side].text);
			return lines.length - 1;
		});
		return { text: lines.join('\n'), positions };
	};
	return [source('before'), source('after')];
}

const changed = (row: DiffRow | undefined): boolean =>
	!!(row?.before?.changed || row?.after?.changed);

/** The first row of every block of changed rows, for n/N. */
export function changeStarts(rows: DiffRow[]): number[] {
	return rows.flatMap((row, index) => (changed(row) && !changed(rows[index - 1]) ? [index] : []));
}

/** The longest line, so both panes scroll horizontally the same distance. */
export function longestLine(rows: DiffRow[]): number {
	return rows.reduce(
		(max, row) =>
			Math.max(
				max,
				row.before?.text.length || 0,
				row.after?.text.length || 0,
				row.heading?.length || 0
			),
		0
	);
}

/** Whether a diff has source lines; without them it is only a message (loading, binary, ...). */
export function hasLines(rows: DiffRow[]): boolean {
	return rows.some((row) => row.before || row.after);
}
