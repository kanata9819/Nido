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
	for (let row = top; row < bottom; row++) {
		if (retainedRows?.has(cells[row])) {
			const before = cells[row];
			cells[row] = before.slice();
			canvas.moveRowImage(before, cells[row]);
		}
		canvas.invalidate(row);
		rowLayout.invalidate(cells[row]);
		rowText.delete(cells[row]);
		for (let col = left; col < right; col++) {
			const sourceRow = row + rows;
			const sourceCol = col + horizontal;
			cells[row][col] =
				sourceRow >= top && sourceRow < bottom && sourceCol >= left && sourceCol < right
					? old[sourceRow - top][sourceCol - left]
					: { text: ' ', highlight: 0 };
		}
	}
}
