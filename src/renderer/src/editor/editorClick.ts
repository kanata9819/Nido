// Moving Neovim's cursor to a clicked cell of the editor canvas.
import type { Grid } from '../grid/grid';

const nextFrame = (): Promise<void> =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// The main process orders edits once they arrive. Hold later input while a renderer click is
// still waiting for its grid position, and let unrelated sessions continue independently.
const pendingClicks = new Map<string, Promise<void>>();

export function afterEditorClick<T>(id: string, action: () => Promise<T>): Promise<T> {
	const pending = pendingClicks.get(id);
	return pending ? pending.then(action, action) : action();
}

export function queueEditorClick(id: string, action: () => Promise<void>): Promise<void> {
	const click = afterEditorClick(id, action);
	pendingClicks.set(id, click);
	const clear = (): void => {
		if (pendingClicks.get(id) === click) {
			pendingClicks.delete(id);
		}
	};
	void click.then(clear, clear);
	return click;
}

/**
 * Where a click landed, read from the grid as it was drawn at the time of the click: the
 * column under the pointer, whether it was in the text rather than the gutter, and the
 * sideways scroll then. Undefined outside the grid or before it has a cell size.
 */
export interface ClickedCell {
	y: number;
	column: number;
	body: boolean;
	gutter: number;
	horizontalColumn: number;
	horizontalOffset: number;
	cellWidth: number;
}

export function clickedCell(
	grid: Grid,
	canvas: HTMLCanvasElement,
	clientX: number,
	clientY: number
): ClickedCell | undefined {
	const { cellWidth, cellHeight, columns } = grid;
	if (!cellWidth || !cellHeight) {
		return undefined;
	}
	const bounds = canvas.getBoundingClientRect();
	const x = clientX - bounds.left;
	const horizontalOffset = grid.horizontalOffset;
	const gutter = grid.horizontalGutter;
	const body = x >= gutter * cellWidth;
	const column = Math.floor((x - (body ? horizontalOffset : 0)) / cellWidth);
	if (x < 0 || x >= columns * cellWidth) {
		return undefined;
	}
	return {
		y: clientY - bounds.top,
		column,
		body,
		gutter,
		horizontalColumn: grid.horizontalColumn,
		horizontalOffset,
		cellWidth
	};
}

/**
 * Click a cell in Neovim. It waits for scrolling to finish and a frame to be drawn, then maps
 * the position through any sideways offset: a pixel offset of more than a cell is first
 * settled into a native sideways scroll.
 */
export async function clickCell(
	id: string,
	grid: Grid,
	cell: ClickedCell,
	scrollCompletion: Promise<void>,
	mounted: () => boolean
): Promise<void> {
	await scrollCompletion;
	await nextFrame();
	if (!mounted()) {
		return;
	}
	const row = grid.rowAt(cell.y);
	if (row < 0) {
		return;
	}
	const { column, body, gutter, horizontalColumn, horizontalOffset, cellWidth } = cell;
	const currentGutter = grid.horizontalGutter;
	if (Math.abs(horizontalOffset) > cellWidth) {
		const delta =
			Math.max(0, Math.floor(horizontalColumn - horizontalOffset / cellWidth)) -
			grid.horizontalColumn;
		if (delta) {
			await window.nido.scroll(id, 0, false, true, delta);
			await nextFrame();
		}
	}
	let target = body
		? column - gutter + currentGutter + horizontalColumn - grid.horizontalColumn
		: column;
	if (body && target < currentGutter) {
		// The leftmost partial cell can still belong to the previous native frame.
		await window.nido.scroll(id, 0, false, true, target - currentGutter);
		target = currentGutter;
	}
	await window.nido.click(id, row, Math.max(0, target));
}

/** Alt+Shift+M focuses Neovim's messages and Alt+Shift+S the sticky headers. */
export function focusEditorPart(event: React.KeyboardEvent, host: HTMLElement | null): void {
	if (!event.altKey || !event.shiftKey) {
		return;
	}
	const key = event.key.toLowerCase();
	let selector: string | undefined;
	if (key === 'm') {
		selector = '[data-neovim-ui] [tabindex="0"]';
	} else if (key === 's') {
		selector = '[data-sticky-scroll] button';
	}
	const target = selector && host?.querySelector<HTMLElement>(selector);
	if (target) {
		event.preventDefault();
		event.stopPropagation();
		target.focus();
	}
}
