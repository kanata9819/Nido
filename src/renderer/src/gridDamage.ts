import type { Grid } from './grid';

interface PaintBand {
  top: number;
  bottom: number;
}

/** Merge adjacent damage while keeping distant rows in separate physical-pixel clips. */
export function gridDamageBands(
  grid: Grid,
  cursorRows: number[],
  previousCursorRows: number[],
  firstDirtyRow: number,
  lastDirtyRow: number,
  cellHeight: number,
  paintDirty: boolean,
  canvasHeight: number,
  dpr: number
): PaintBand[] {
  const damage = [...new Set([...cursorRows, ...previousCursorRows])].map((row) => ({
    top: grid.rowY(Math.floor(row)),
    bottom: grid.rowY(Math.ceil(row)) + cellHeight
  }));
  if (firstDirtyRow !== Infinity) {
    damage.push({
      top: grid.rowY(firstDirtyRow),
      bottom: grid.rowY(lastDirtyRow) + cellHeight
    });
  }
  // Keep distant damage separate; physical-pixel clips preserve acrylic and fractional DPI.
  const candidates = paintDirty
    ? [{ top: 0, bottom: canvasHeight / dpr }]
    : damage
        .map(({ top, bottom }) => ({
          top: Math.max(0, Math.floor((top - 1 / dpr) * dpr) / dpr),
          bottom: Math.min(canvasHeight / dpr, Math.ceil((bottom + 1 / dpr) * dpr) / dpr)
        }))
        .filter(({ top, bottom }) => top < bottom);
  const bands: { top: number; bottom: number }[] = [];
  for (const band of candidates.sort((a, b) => a.top - b.top)) {
    const previous = bands[bands.length - 1];
    if (previous && band.top <= previous.bottom) {
      previous.bottom = Math.max(previous.bottom, band.bottom);
    } else {
      bands.push(band);
    }
  }
  return bands;
}
