import type { Cell } from './gridTypes';
import type { GridCanvas } from './gridCanvas';
import type { GridRowLayout } from './gridRowLayout';

/** Apply a native grid scroll while preserving copy-on-write rows and cached images. */
export function scrollGridCells(
	cells: Cell[][],
	columns: number,
	args: number[],
	retainedRows: Set<Cell[]> | undefined,
	canvas: GridCanvas,
	rowLayout: GridRowLayout,
	rowText: WeakMap<Cell[], string>
): void {
	const [, top, bottom, left, right, rows, horizontal] = args;
	if (left === 0 && right === columns && horizontal === 0) {
		const old = cells.slice();
		for (let row = top; row < bottom; row++) {
			const source = row + rows;
			cells[row] =
				source >= top && source < bottom
					? old[source]
					: Array.from({ length: columns }, () => ({
							text: ' ',
							highlight: 0
						}));
		}
		return;
	}
	// Partial scrolls only read their rectangle, not the entire viewport.
	const old = cells.slice(top, bottom).map((row) => row.slice(left, right));
	const first = Math.min(right, Math.max(left, left - horizontal));
	const last = Math.max(first, Math.min(right, right - horizontal));
	const offset = horizontal - left;
	for (let row = top; row < bottom; row++) {
		if (retainedRows?.has(cells[row])) {
			const before = cells[row];
			cells[row] = before.slice();
			canvas.moveRowImage(before, cells[row]);
		}
		canvas.invalidate(row);
		rowLayout.invalidate(cells[row]);
		rowText.delete(cells[row]);
		const destination = cells[row];
		const source = old[row + rows - top];
		if (!source) {
			for (let col = left; col < right; col++) {
				destination[col] = { text: ' ', highlight: 0 };
			}
			continue;
		}
		for (let col = left; col < first; col++) {
			destination[col] = { text: ' ', highlight: 0 };
		}
		for (let col = first; col < last; col++) {
			destination[col] = source[col + offset];
		}
		for (let col = last; col < right; col++) {
			destination[col] = { text: ' ', highlight: 0 };
		}
	}
}
