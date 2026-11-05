import type { CanvasSurface } from './canvasSurface';
import type { Grid } from './grid';

/** Align the hidden editing input with the painted cursor without waking layout observers. */
export function positionEditorInput(
	input: HTMLTextAreaElement | null,
	bounds: CanvasSurface,
	grid: Grid,
	cellWidth: number,
	dpr: number
): void {
	if (input && !input.hasAttribute('data-nvim-command-active')) {
		const left =
			bounds.left +
			grid.cursor.column * cellWidth +
			(grid.cursor.column >= grid.horizontalGutter ? grid.horizontalOffset : 0);
		const top = bounds.top + grid.rowY(grid.cursor.row);
		const maxWidth = `${Math.max(2, bounds.left + bounds.width - left)}px`;
		if (input.style.maxWidth !== maxWidth) {
			input.style.maxWidth = maxWidth;
		}
		// Unchanged styles wake popup observers and force layout during cursor blinking.
		if (!(Math.abs(parseFloat(input.style.left) - left) * dpr < 0.01)) {
			input.style.left = `${left}px`;
		}
		if (!(Math.abs(parseFloat(input.style.top) - top) * dpr < 0.01)) {
			input.style.top = `${top}px`;
		}
	}
}
