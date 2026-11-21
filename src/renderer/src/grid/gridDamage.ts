import type { Grid } from './grid';

/** A vertical range of the canvas to repaint, in CSS pixels. */
interface PaintBand {
	top: number;
	bottom: number;
}

/** Merge nearby damage while keeping distant rows in separate physical-pixel clips. */
export function gridDamageBands(
	grid: Grid,
	cursorRows: number[],
	previousCursorRows: number[],
	dirtyRows: ReadonlySet<number>,
	cellHeight: number,
	paintDirty: boolean,
	canvasHeight: number,
	dpr: number
): PaintBand[] {
	if (paintDirty) {
		return [{ top: 0, bottom: canvasHeight / dpr }];
	}
	// Keep distant damage separate; physical-pixel clips preserve acrylic and fractional DPI.
	const candidates: PaintBand[] = [];
	for (const row of new Set([...cursorRows, ...previousCursorRows, ...dirtyRows])) {
		const first = Math.floor(row);
		const y = grid.rowY(first);
		const end = row === first ? y : grid.rowY(Math.ceil(row));
		const top = Math.max(0, Math.floor((y - 1 / dpr) * dpr) / dpr);
		const bottom = Math.min(
			canvasHeight / dpr,
			Math.ceil((end + cellHeight + 1 / dpr) * dpr) / dpr
		);
		if (top < bottom) {
			candidates.push({ top, bottom });
		}
	}
	const bands: PaintBand[] = [];
	for (const band of candidates.sort((a, b) => a.top - b.top)) {
		const previous = bands[bands.length - 1];
		// Nearby bands already copy their neighboring rows for raster overscan.
		if (previous && band.top <= previous.bottom + cellHeight) {
			previous.bottom = Math.max(previous.bottom, band.bottom);
		} else {
			bands.push(band);
		}
	}
	return bands;
}
