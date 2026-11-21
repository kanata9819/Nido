// What the diff view derives from the rows of a split diff. Pure functions, so GitDiff only
// memoizes them.
import { maxDiffHighlightLength } from '../../../../shared/nidoApi';
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

/** Prepare source text only for diffs within the highlighting limit. */
export function sideSources(rows: DiffRow[]): [SideSource, SideSource] | undefined {
	const sides = {
		before: { lines: [] as string[], positions: [] as number[] },
		after: { lines: [] as string[], positions: [] as number[] }
	};
	const names = ['before', 'after'] as const;
	let remaining = maxDiffHighlightLength;
	for (const row of rows) {
		for (const side of names) {
			const line = row[side];
			const { lines, positions } = sides[side];
			positions.push(line ? lines.length : -1);
			if (line) {
				remaining -= line.text.length + (lines.length ? 1 : 0);
				if (remaining < 0) {
					return undefined;
				}
				lines.push(line.text);
			}
		}
	}
	const { before, after } = sides;
	if (!before.lines.length && !after.lines.length) {
		return undefined;
	}
	return [
		{ text: before.lines.join('\n'), positions: before.positions },
		{ text: after.lines.join('\n'), positions: after.positions }
	];
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
