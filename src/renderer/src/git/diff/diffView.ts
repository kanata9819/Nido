// Turns the rows of a split diff into the rows the diff view draws: hunk separators between the
// lines, and either side-by-side rows or a unified (inline) list of lines.
import type { DiffLine, DiffRow } from './splitDiff';

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
	// Text spans use UTF-16 offsets. Keep a surrogate pair in the same span on both sides.
	const splitsPair = (text: string, index: number): boolean =>
		index > 0 && (text.codePointAt(index - 1) ?? 0) > 0xffff;
	if (splitsPair(before, start) || splitsPair(after, start)) {
		start--;
	}
	if (
		end > 0 &&
		(splitsPair(before, before.length - end) || splitsPair(after, after.length - end))
	) {
		end--;
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

/** Compute emphasis only for replacement rows drawn by either pane. */
export function rowEmphasis(rows: DiffRow[]): (index: number) => DiffEmphasis | undefined {
	const ranges = new Map<number, DiffEmphasis | undefined>();
	return (index) => {
		const { before, after } = rows[index];
		if (!before?.changed || !after?.changed) {
			return undefined;
		}
		if (!ranges.has(index)) {
			ranges.set(index, changedRange(before.text, after.text));
		}
		return ranges.get(index);
	};
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
	const removed: DiffViewRow[] = [];
	const added: DiffViewRow[] = [];
	const flush = (): void => {
		// A large replacement block can exceed the argument limit of a single push.
		for (const row of removed) {
			view.push(row);
		}
		for (const row of added) {
			view.push(row);
		}
		removed.length = 0;
		added.length = 0;
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
			if (removed.length || added.length) {
				flush();
			}
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
