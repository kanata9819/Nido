// Turns a unified diff into rows for the side-by-side diff view.

/** A line on one side of a diff, with its line number in that version. */
export interface DiffLine {
	number: number;
	text: string;
	changed?: boolean;
	missingNewline?: boolean;
}

/** Where a hunk starts on each side, and the context Git shows after its `@@` range. */
export interface DiffHunk {
	before: number;
	after: number;
	context: string;
}

/** One row of the side-by-side view: a line on each side (a gap when absent) or a heading. */
export interface DiffRow {
	before?: DiffLine;
	after?: DiffLine;
	heading?: string;
	/** Set on the first row of each hunk. */
	hunk?: DiffHunk;
}

/**
 * Split a unified diff into side-by-side rows. Unchanged lines appear on both sides; a run of
 * removed lines is paired row by row with the added lines that follow it.
 */
export function splitDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let before = 0;
	let after = 0;
	let inHunk = false;
	let previousBefore: DiffLine | undefined;
	let previousAfter: DiffLine | undefined;
	const removed: DiffLine[] = [];
	const added: DiffLine[] = [];
	// The hunk that starts, waiting for its first row.
	let hunkStart: DiffHunk | undefined;
	const push = (row: DiffRow): void => {
		if (hunkStart && !row.heading) {
			row.hunk = hunkStart;
			hunkStart = undefined;
		}
		rows.push(row);
	};
	const flush = (): void => {
		for (let i = 0; i < Math.max(removed.length, added.length); i++) {
			push({ before: removed[i], after: added[i] });
		}
		removed.length = 0;
		added.length = 0;
	};

	for (const line of diff.split('\n')) {
		// Git prefixes its localized missing-newline message with a backslash.
		if (inHunk && line.startsWith('\\ ')) {
			if (previousBefore) {
				previousBefore.missingNewline = true;
			}
			if (previousAfter) {
				previousAfter.missingNewline = true;
			}
			continue;
		}
		previousBefore = undefined;
		previousAfter = undefined;
		const hunk = line.startsWith('@@ ')
			? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line)
			: null;
		if (hunk) {
			flush();
			before = Number(hunk[1]);
			after = Number(hunk[2]);
			hunkStart = { before, after, context: hunk[3].trim() };
			inHunk = true;
			continue;
		}
		if (inHunk && line.startsWith('-')) {
			previousBefore = { number: before++, text: line.slice(1), changed: true };
			removed.push(previousBefore);
		} else if (inHunk && line.startsWith('+')) {
			previousAfter = { number: after++, text: line.slice(1), changed: true };
			added.push(previousAfter);
		} else if (inHunk && line.startsWith(' ')) {
			if (removed.length || added.length) {
				flush();
			}
			const text = line.slice(1);
			previousBefore = { number: before++, text };
			const number = after++;
			previousAfter = previousBefore.number === number ? previousBefore : { number, text };
			push({ before: previousBefore, after: previousAfter });
		} else {
			flush();
			inHunk = false;
			if (line && !/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
				rows.push({ heading: line });
			}
		}
	}
	flush();
	return rows;
}
