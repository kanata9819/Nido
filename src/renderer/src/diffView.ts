// Turns the rows of a split diff into the rows the diff view draws: hunk separators between the
// lines, and either side-by-side rows or a unified (inline) list of lines.
import type { DiffLine, DiffRow } from './gitDiff';

/** How a diff is laid out: two panes side by side, or one pane with lines inline. */
export type DiffLayout = 'split' | 'unified';

/** The changed part of a replaced line: [start, end) on each side. */
export interface DiffEmphasis {
	before: [number, number];
	after: [number, number];
}

/** A row the diff view draws. `index` is the row of `splitDiff` it shows, for n/N. */
export type DiffViewRow =
	| { kind: 'separator'; hidden: number; context: string }
	| { kind: 'row'; index: number; row: DiffRow }
	| {
			kind: 'line';
			index: number;
			side: 'before' | 'after' | 'both';
			line: DiffLine;
			before?: number;
			after?: number;
	  };

/**
 * The part of a replaced line that changed, found from the text both versions share at the
 * start and end. Undefined when the lines share nothing, so a rewritten line is not marked
 * as one large change.
 */
export function changedRange(before: string, after: string): DiffEmphasis | undefined {
	const limit = Math.min(before.length, after.length);
	let start = 0;
	while (start < limit && before[start] === after[start]) {
		start++;
	}
	let end = 0;
	while (
		end < limit - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	) {
		end++;
	}
	// Where the change cuts through a word, widen it to the whole word, so `false` → `true`
	// marks both words rather than `fals` and `tru`.
	const word = (text: string, index: number): boolean =>
		index >= 0 && index < text.length && /[\p{L}\p{N}_]/u.test(text[index]);
	const cutsWord = (beforeIndex: number, afterIndex: number): boolean =>
		word(before, beforeIndex) || word(after, afterIndex);
	while (start > 0 && word(before, start - 1) && cutsWord(start, start)) {
		start--;
	}
	while (
		end > 0 &&
		word(before, before.length - end) &&
		cutsWord(before.length - end - 1, after.length - end - 1)
	) {
		end--;
	}
	if (!start && !end) {
		return undefined;
	}
	return {
		before: [start, before.length - end],
		after: [start, after.length - end]
	};
}

/** The emphasis of each row that replaces a line with another. */
export function rowEmphasis(rows: DiffRow[]): (DiffEmphasis | undefined)[] {
	return rows.map((row) =>
		row.before?.changed && row.after?.changed
			? changedRange(row.before.text, row.after.text)
			: undefined
	);
}

/**
 * The number of unchanged lines a hunk skips since the previous one (or the start of the
 * file), from the first line number of the hunk on a side that has one.
 */
function skippedLines(
	rows: DiffRow[],
	start: number,
	last: { before: number; after: number }
): number {
	for (let index = start; index < rows.length; index++) {
		if (index > start && rows[index].hunk) {
			break;
		}
		for (const side of ['after', 'before'] as const) {
			const number = rows[index][side]?.number;
			if (number !== undefined) {
				return Math.max(0, number - last[side] - 1);
			}
		}
	}
	return 0;
}

/**
 * The rows to draw for a layout. A separator comes before each hunk that skips lines, with
 * the count and Git's context. Side by side, each row shows its two lines; inline, each block
 * of changes shows its removed lines and then its added lines.
 */
export function diffViewRows(rows: DiffRow[], layout: DiffLayout): DiffViewRow[] {
	const view: DiffViewRow[] = [];
	const last = { before: 0, after: 0 };
	let removed: DiffViewRow[] = [];
	let added: DiffViewRow[] = [];
	const flush = (): void => {
		view.push(...removed, ...added);
		removed = [];
		added = [];
	};
	rows.forEach((row, index) => {
		if (row.hunk) {
			flush();
			const hidden = skippedLines(rows, index, last);
			if (hidden || index > 0) {
				view.push({ kind: 'separator', hidden, context: row.hunk.context });
			}
		}
		if (row.before) {
			last.before = row.before.number;
		}
		if (row.after) {
			last.after = row.after.number;
		}
		if (layout === 'split' || row.heading) {
			flush();
			view.push({ kind: 'row', index, row });
			return;
		}
		if (row.before?.changed || row.after?.changed) {
			if (row.before) {
				removed.push({
					kind: 'line',
					index,
					side: 'before',
					line: row.before,
					before: row.before.number
				});
			}
			if (row.after) {
				added.push({
					kind: 'line',
					index,
					side: 'after',
					line: row.after,
					after: row.after.number
				});
			}
			return;
		}
		flush();
		if (row.after) {
			view.push({
				kind: 'line',
				index,
				side: 'both',
				line: row.after,
				before: row.before?.number,
				after: row.after.number
			});
		}
	});
	flush();
	return view;
}
