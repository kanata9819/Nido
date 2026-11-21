import type { Cell, Highlight } from './gridTypes';
import { gridWasmBuffer } from './gridWasm';
import { GridTextIds, gridTextMask } from '../../../shared/gridTextIds';
export { loadGridWasm as loadHorizontalSpans } from './gridWasm';

const blocked = 1 << 31;
const stale = 1 << 30;
const italic = 1 << 29;
const maxHighlight = (1 << 12) - 1;
const continuation = 1;

type Span = [number, number];

/** Pack 17 bits of text, 12 bits of highlight id and three repaint flags per cell. */
export class HorizontalSpans {
	private readonly textIds = new GridTextIds();

	pack(cells: Cell[], highlights: Map<number, Highlight>, words: Uint32Array): number[] {
		const indentColumns: number[] = [];
		let lastId: number | undefined;
		let style = 0;
		let indent = false;
		for (let column = 0; column < words.length; column++) {
			const cell = cells[column];
			if (!cell) {
				words[column] = 0;
				continue;
			}
			const id = cell.highlight;
			if (id !== lastId) {
				const h = highlights.get(id);
				style = id >= 0 && id <= maxHighlight && Number.isInteger(id) ? id << 17 : stale;
				if (h?.italic) {
					style |= italic;
				}
				indent = !!h?.indentGuide;
				if (indent) {
					style |= stale;
				}
				if (h?.codeLens || h?.diagnostic) {
					style |= blocked;
				}
				lastId = id;
			}
			if (indent) {
				indentColumns.push(column);
			}
			const text = cell.text;
			const code = this.textIds.id(text) ?? stale;
			words[column] = style | code | (text === '│' ? stale : 0);
		}
		return indentColumns;
	}
}

export function horizontalSpans(
	current: Uint32Array,
	previous: Uint32Array,
	left: number,
	right: number,
	shift: number,
	margin: number
): Span[] | undefined {
	const columns = current.length;
	const wasm = gridWasmBuffer(columns * 4);
	if (!wasm) {
		return scalarSpans(current, previous, left, right, shift, margin);
	}
	const { kernel, base, scratch } = wasm;
	scratch.set(current);
	scratch.set(previous, columns);
	const count = kernel.horizontal_spans(base, columns, left, right, shift, margin);
	if (count < 0) {
		return undefined;
	}
	const spans: Span[] = [];
	for (let i = columns * 2; i < columns * 2 + count * 2; i += 2) {
		spans.push([scratch[i], scratch[i + 1]]);
	}
	return spans;
}

function scalarSpans(
	current: Uint32Array,
	previous: Uint32Array,
	left: number,
	right: number,
	shift: number,
	margin: number
): Span[] | undefined {
	const columns = current.length;
	const spans: Span[] = [];
	let width = 0;
	const crossing = (col: number): boolean =>
		col >= 0 &&
		col < columns &&
		((current[col] & italic) !== 0 ||
			(current[col] & gridTextMask) === continuation ||
			(current[col + 1] & gridTextMask) === continuation);
	for (let col = 0; col < columns; col++) {
		const cell = current[col];
		if (cell & blocked) {
			return undefined;
		}
		const inside = col >= left && col < right;
		const from = inside ? col + shift : col;
		if (
			!(cell & stale) &&
			cell === previous[from] &&
			(!inside ||
				(from >= left && from < right && col >= left + margin && col < right - margin))
		) {
			continue;
		}
		let start = Math.max(0, col - margin);
		let stop = Math.min(columns, col + 1 + margin);
		const last = spans.at(-1);
		if (last && stop <= last[1]) {
			continue;
		}
		while (
			start > 0 &&
			(!last || start > last[1]) &&
			(crossing(start - 1) || crossing(start))
		) {
			start--;
		}
		while (stop < columns && (crossing(stop - 1) || crossing(stop))) {
			stop++;
		}
		if (last && start <= last[1]) {
			width += stop - last[1];
			last[1] = stop;
		} else {
			width += stop - start;
			spans.push([start, stop]);
		}
		if (width * 2 > columns) {
			return undefined;
		}
	}
	return spans;
}
