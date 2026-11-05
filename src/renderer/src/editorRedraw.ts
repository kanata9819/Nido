import type { Redraw } from '../../shared/types';
import type { Grid } from './grid';
import type { FrameMotion } from './editorMotion';

/** A `nido_scroll` call: which region of which grid moved by how many rows/columns. */
export interface ViewportScroll {
	grid: number;
	top: number;
	bottom: number;
	left: number;
	right: number;
	rows: number;
	columns: number;
}

function viewportScroll(call: number[]): ViewportScroll {
	const [grid, top, bottom, left, right, rows, columns] = call;
	return { grid, top, bottom, left, right, rows, columns };
}

/** What one redraw batch means for scrolling, the cursor and the accessible description. */
export interface RedrawSummary {
	edited: boolean;
	bufferChanged: boolean;
	/** Horizontal scroll column of a newly entered buffer, if reported. */
	bufferColumn?: number;
	pixelOffsets: unknown[][];
	viewportScrolls: unknown[][];
	/** The viewport scroll, when the batch holds exactly one. */
	scroll?: ViewportScroll;
	/** Horizontal scroll column reported by the last viewport scroll. */
	lastScrollColumn?: number;
	gridShifted: boolean;
	/** The grid was cleared or resized. */
	layoutReset: boolean;
	/** Cursor animation must restart from its current cell rather than glide. */
	cursorJumped: boolean;
	/** Rows may have moved into view from above. */
	viewportMoved: boolean;
	descriptionChanged: boolean;
}

export function summarizeRedraw(events: Redraw): RedrawSummary {
	const names = new Set(events.map(([name]) => name));
	const callsOf = (target: string): unknown[][] =>
		events.flatMap(([name, ...calls]) => (name === target ? calls : []));
	const buffer = events.find(([name]) => name === 'nido_buffer')?.[1];
	const viewportScrolls = callsOf('nido_scroll');
	const lastScroll = viewportScrolls.at(-1);
	const gridShifted = names.has('grid_scroll');
	const layoutReset = names.has('grid_clear') || names.has('grid_resize');
	return {
		edited: names.has('nido_edit'),
		bufferChanged: names.has('nido_buffer'),
		bufferColumn: typeof buffer?.[2] === 'number' ? buffer[2] : undefined,
		pixelOffsets: callsOf('nido_pixel_scroll'),
		viewportScrolls,
		// Grid row shifts also describe edits and decorations, not viewport movement.
		scroll:
			viewportScrolls.length === 1
				? viewportScroll(viewportScrolls[0] as number[])
				: undefined,
		lastScrollColumn: typeof lastScroll?.[8] === 'number' ? lastScroll[8] : undefined,
		gridShifted,
		layoutReset,
		cursorJumped:
			viewportScrolls.length > 0 || gridShifted || layoutReset || names.has('mode_change'),
		viewportMoved: names.has('nido_scroll') || gridShifted,
		descriptionChanged:
			gridShifted || layoutReset || names.has('grid_line') || names.has('nido_buffer')
	};
}

/** A purely horizontal scroll smaller than the visible width, which can slide frames. */
export function isHorizontalStep(scroll: ViewportScroll): boolean {
	return (
		scroll.rows === 0 &&
		!!scroll.columns &&
		Math.abs(scroll.columns) < scroll.right - scroll.left
	);
}

/** A scroll over a real region of the main grid that has something to animate. */
export function isAnimatableScroll(scroll: ViewportScroll): boolean {
	return (
		scroll.grid === 1 &&
		scroll.bottom > scroll.top &&
		scroll.right > scroll.left &&
		(scroll.rows !== 0 || scroll.columns !== 0)
	);
}

/** Starts a horizontal slide driven by the scroll offset rather than by time. */
export function horizontalMotion(
	scroll: ViewportScroll,
	cellWidth: number,
	offsetX: number,
	now: number
): FrameMotion {
	return {
		top: scroll.top,
		bottom: scroll.bottom,
		left: scroll.left,
		right: scroll.right,
		distance: 0,
		distanceX: scroll.columns * cellWidth,
		incomingRows: 0,
		start: now,
		duration: 0,
		offsetX
	};
}

/** Starts a timed scroll animation, carrying over what is left of the previous one. */
export function scrollMotion(
	scroll: ViewportScroll,
	grid: Pick<Grid, 'rowTop'>,
	cellWidth: number,
	remaining: { y: number; x: number },
	now: number,
	lastScrollTime: number | undefined
): FrameMotion {
	const height = grid.rowTop(scroll.bottom) - grid.rowTop(scroll.top);
	const distance = grid.rowTop(scroll.top + scroll.rows) - grid.rowTop(scroll.top);
	const width = (scroll.right - scroll.left) * cellWidth;
	return {
		top: scroll.top,
		bottom: scroll.bottom,
		left: scroll.left,
		right: scroll.right,
		// Large jumps use at most one viewport so the animation never exposes an empty gap.
		distance:
			scroll.rows < 0
				? remaining.y
				: Math.max(-height, Math.min(height, distance + remaining.y)),
		incomingRows: Math.max(0, -scroll.rows),
		distanceX:
			scroll.rows === 0
				? Math.max(-width, Math.min(width, scroll.columns * cellWidth + remaining.x))
				: 0,
		start: now,
		duration: Math.max(1, Math.min(120, now - (lastScrollTime ?? now - 120)))
	};
}

/** The Neovim grid size that fills the editor surface. */
export function editorGridSize(
	bounds: { width: number; height: number },
	metrics: { cellWidth: number; cellHeight: number },
	pixelScroll: boolean,
	extraRows: number
): { columns: number; rows: number } {
	const columns = Math.max(20, Math.floor(bounds.width / metrics.cellWidth));
	// External command UI needs no visible slot; retain a document row for scroll overscan.
	const visibleRows = bounds.height / metrics.cellHeight;
	const rows =
		Math.max(4, pixelScroll ? Math.ceil(visibleRows) : Math.floor(visibleRows)) +
		extraRows +
		(pixelScroll ? 2 : 0);
	return { columns, rows };
}
