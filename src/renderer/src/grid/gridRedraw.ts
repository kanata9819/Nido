import type { Redraw } from '../../../shared/types';

/** Batch metadata shared by the editor animation and grid update. */
export interface GridRedraw {
	edited: boolean;
	bufferChanged: boolean;
	bufferColumn?: number;
	pixelOffsets: unknown[][];
	viewportScrolls: unknown[][];
	viewportReported: boolean;
	gridShifted: boolean;
	layoutReset: boolean;
	modeChanged: boolean;
	prefetched: boolean;
	descriptionChanged: boolean;
}

/** Inspect event names once, preserving the order of all viewport and pixel scroll calls. */
export function readGridRedraw(events: Redraw): GridRedraw {
	let edited = false;
	let bufferChanged = false;
	let bufferColumn: number | undefined;
	let viewportReported = false;
	let gridShifted = false;
	let layoutReset = false;
	let modeChanged = false;
	let prefetched = false;
	let lineChanged = false;
	const pixelOffsets: unknown[][] = [];
	const viewportScrolls: unknown[][] = [];
	for (const event of events) {
		switch (event[0]) {
			case 'nido_edit':
				edited = true;
				break;
			case 'nido_buffer':
				if (!bufferChanged && typeof event[1]?.[2] === 'number') {
					bufferColumn = event[1][2];
				}
				bufferChanged = true;
				break;
			case 'nido_scroll':
				viewportReported = true;
				for (let i = 1; i < event.length; i++) {
					viewportScrolls.push(event[i] as unknown[]);
				}
				break;
			case 'nido_pixel_scroll':
				for (let i = 1; i < event.length; i++) {
					pixelOffsets.push(event[i] as unknown[]);
				}
				break;
			case 'grid_scroll':
				gridShifted = true;
				break;
			case 'grid_clear':
			case 'grid_resize':
				layoutReset = true;
				break;
			case 'mode_change':
				modeChanged = true;
				break;
			case 'nido_scroll_cache':
				prefetched = true;
				break;
			case 'grid_line':
				lineChanged = true;
				break;
		}
	}
	return {
		edited,
		bufferChanged,
		bufferColumn,
		pixelOffsets,
		viewportScrolls,
		viewportReported,
		gridShifted,
		layoutReset,
		modeChanged,
		prefetched,
		descriptionChanged: gridShifted || layoutReset || lineChanged || bufferChanged
	};
}
