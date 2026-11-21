import type { Cell, Highlight } from './gridTypes';

const blocked = 1 << 31;
const stale = 1 << 30;
const italic = 1 << 29;
const textMask = (1 << 17) - 1;
const maxHighlight = (1 << 12) - 1;
const continuation = 1;
const firstGrapheme = 0x10002;

type Span = [number, number];

interface Kernel {
	memory: WebAssembly.Memory;
	__heap_base: WebAssembly.Global;
	horizontal_spans(
		buffer: number,
		columns: number,
		left: number,
		right: number,
		shift: number,
		margin: number
	): number;
}

let kernel: Kernel | undefined;
let scratch: Uint32Array;
let base: number;
let loading: Promise<boolean> | undefined;

/** Warm up on the first horizontal paint. The scalar path also works when Wasm is unavailable. */
export function loadHorizontalSpans(): Promise<boolean> {
	return (loading ??= import('./horizontalSpansWasm')
		.then(async ({ default: bytes }) => {
			const binary = Uint8Array.from(atob(bytes), (byte) => byte.charCodeAt(0));
			const { instance } = await WebAssembly.instantiate(binary);
			const exports = instance.exports as unknown as Kernel;
			base = Number(exports.__heap_base.value);
			scratch = new Uint32Array(exports.memory.buffer, base);
			kernel = exports;
			return true;
		})
		.catch(() => false));
}

/** Pack 17 bits of text, 12 bits of highlight id and three repaint flags per cell. */
export class HorizontalSpans {
	private readonly graphemes = new Map<string, number>();

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
			const code =
				text.length === 0
					? continuation
					: text.length === 1
						? text.charCodeAt(0) + 2
						: this.grapheme(text);
			words[column] = style | code | (text === '│' ? stale : 0);
		}
		return indentColumns;
	}

	private grapheme(text: string): number {
		const known = this.graphemes.get(text);
		if (known !== undefined) {
			return known;
		}
		const next = firstGrapheme + this.graphemes.size;
		// Once the dictionary is full, repaint unfamiliar strings unconditionally.
		if (next > textMask) {
			return stale;
		}
		this.graphemes.set(text, next);
		return next;
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
	if (!kernel) {
		return scalarSpans(current, previous, left, right, shift, margin);
	}

	const columns = current.length;
	const words = columns * 4;
	if (words > scratch.length) {
		kernel.memory.grow(
			Math.ceil(((words - scratch.length) * Uint32Array.BYTES_PER_ELEMENT) / 65536)
		);
		scratch = new Uint32Array(kernel.memory.buffer, base);
	}
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
			(current[col] & textMask) === continuation ||
			(current[col + 1] & textMask) === continuation);
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
