import type { Redraw } from './types';
import { GridTextIds, gridTextFromId, gridTextMask } from './gridTextIds';

export type GridLine = [string, number?, number?][];

export interface PackedGridLine {
	/** Interleaved cell words and repeat counts. */
	runs: Uint32Array;
	graphemes: readonly string[];
}

export const packedGridLineEvent = 'nido_packed_grid_line';

/** Pack large grid_line groups before they cross IPC and the isolated preload world. */
export function packGridLineRedraw(events: Redraw): Redraw {
	let result: Redraw | undefined;
	let pending = 0;
	for (let first = 0; first < events.length;) {
		let end = first;
		let runCount = 0;
		// Neovim can split a single repaint across many RPC notifications before flush.
		while (end < events.length) {
			const count = countGridRuns(events[end]);
			if (count < 0) {
				break;
			}
			runCount += count;
			end++;
		}
		// Small updates and already compressed lines are cheap to transfer as tuples.
		if (runCount >= 512) {
			const lines: unknown[][] = [];
			for (let i = first; i < end; i++) {
				const event = events[i];
				for (let line = 1; line < event.length; line++) {
					lines.push(event[line] as unknown[]);
				}
			}
			const packed = packLines(lines, runCount);
			if (packed) {
				result ??= [];
				for (; pending < first; pending++) {
					result.push(events[pending]);
				}
				result.push(packed);
				pending = end;
			}
		}
		first = Math.max(first + 1, end);
	}
	if (result) {
		for (; pending < events.length; pending++) {
			result.push(events[pending]);
		}
	}
	return result ?? events;
}

function countGridRuns(event: Redraw[number]): number {
	if (event[0] !== 'grid_line') {
		return -1;
	}
	let count = 0;
	for (let i = 1; i < event.length; i++) {
		const line = event[i] as unknown[];
		if (line[0] !== 1 || !Array.isArray(line[3])) {
			return -1;
		}
		count += line[3].length;
	}
	return count;
}

function packLines(lines: unknown[][], runCount: number): Redraw[number] | undefined {
	const words = new Uint32Array(lines.length * 3 + runCount * 2);
	const textIds = new GridTextIds();
	let offset = 0;
	for (const line of lines) {
		const [, row, column, cells] = line as [number, number, number, GridLine];
		if (row >>> 0 !== row || column >>> 0 !== column) {
			return undefined;
		}
		words[offset++] = row;
		words[offset++] = column;
		words[offset++] = cells.length;
		let highlight = 0;
		for (const cell of cells) {
			if (cell[1] !== undefined) {
				highlight = cell[1];
			}
			const repeat = cell[2] ?? 1;
			if (typeof cell[0] !== 'string') {
				return undefined;
			}
			const word = textIds.word(cell[0], highlight);
			if (word === undefined || repeat >>> 0 !== repeat) {
				return undefined;
			}
			words[offset++] = word;
			words[offset++] = repeat;
		}
	}
	return [packedGridLineEvent, [words.buffer, textIds.graphemes]];
}

export function unpackGridLine({ runs, graphemes }: PackedGridLine): GridLine {
	const cells: GridLine = [];
	for (let offset = 0; offset < runs.length; offset += 2) {
		const word = runs[offset];
		cells.push([gridTextFromId(word & gridTextMask, graphemes), word >>> 17, runs[offset + 1]]);
	}
	return cells;
}
