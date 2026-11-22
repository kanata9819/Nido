import type { Cell } from './gridTypes';
import { gridWasmBuffer, loadGridWasm } from './gridWasm';
import { firstGridGrapheme, GridTextIds, gridTextMask } from '../../../shared/gridTextIds';
import type { GridLine, PackedGridLine } from '../../../shared/gridLineTransport';

interface DenseLineChanges {
	packed: Uint32Array;
	words: Uint32Array;
	changed: Uint32Array;
}

// For short writes, encoding and copying costs more than comparing the cells directly.
const minimumColumns = 64;

/** Packed snapshots of rows receiving bulk redraws. Small edits keep the object path. */
export class DenseGridLines {
	private readonly rows = new WeakMap<Cell[], Uint32Array>();
	private readonly textIds = new GridTextIds();
	private readonly graphemeIds = new WeakMap<readonly string[], Uint32Array>();

	forget(row: Cell[]): void {
		this.rows.delete(row);
	}

	changes(
		row: Cell[],
		start: number,
		line: GridLine | PackedGridLine,
		columns: number,
		nativeScroll: boolean
	): DenseLineChanges | undefined {
		if (
			columns - start < minimumColumns ||
			!Number.isInteger(start) ||
			start < 0 ||
			(Array.isArray(line) &&
				line.length < minimumColumns &&
				!line.some((cell) => (cell[2] ?? 1) >= minimumColumns))
		) {
			return undefined;
		}
		let packed = this.rows.get(row);
		if (!packed && nativeScroll) {
			// Native grid_scroll already reuses retained rows and writes into fresh rows.
			return undefined;
		}
		const visible = columns - start;
		// Avoid copying an oversized batch table for each row. Near ID exhaustion,
		// keep interning only the graphemes that the visible runs actually use.
		const remainingIds = gridTextMask - firstGridGrapheme + 1 - this.textIds.graphemes.length;
		const packedLine =
			!Array.isArray(line) &&
			line.runs.length <= visible * 2 &&
			line.graphemes.length <= Math.min(visible, remainingIds)
				? line
				: undefined;
		const wasm = gridWasmBuffer(
			visible * 3 + (packedLine ? packedLine.runs.length + packedLine.graphemes.length : 0)
		);
		if (!wasm) {
			if (typeof window !== 'undefined') {
				void loadGridWasm();
			}
			return undefined;
		}
		const { kernel, base, scratch } = wasm;
		const incoming = scratch.subarray(visible, 2 * visible);
		let length: number;
		if (packedLine) {
			const { runs, graphemes } = packedLine;
			const offset = visible * 3;
			scratch.set(runs, offset);
			if (graphemes.length) {
				scratch.set(this.mapGraphemes(graphemes), offset + runs.length);
			}
			length = kernel.grid_line_expand(base, visible, runs.length, graphemes.length);
		} else {
			length = Array.isArray(line)
				? this.writeTupleRuns(line, incoming)
				: this.writePackedRuns(line, incoming);
		}
		if (length < minimumColumns) {
			return undefined;
		}
		if (!packed) {
			packed = new Uint32Array(columns);
			for (let col = 0; col < columns; col++) {
				const cell = row[col];
				const word = cell ? this.textIds.word(cell.text, cell.highlight) : 0;
				if (word === undefined) {
					return undefined;
				}
				packed[col] = word;
			}
			this.rows.set(row, packed);
		}
		scratch.set(packed.subarray(start, start + length));
		const count = kernel.grid_line_changes(base, visible, length);
		return {
			packed,
			words: incoming.subarray(0, length),
			changed: scratch.subarray(2 * visible, 2 * visible + count)
		};
	}

	commit(
		row: Cell[],
		original: Cell[],
		packed: Uint32Array,
		start: number,
		words: Uint32Array
	): void {
		const next = row === original ? packed : packed.slice();
		next.set(words, start);
		this.rows.set(row, next);
	}
	cell(word: number): Cell {
		return { text: this.textIds.text(word & gridTextMask), highlight: word >>> 17 };
	}

	private writeTupleRuns(line: GridLine, target: Uint32Array): number {
		let length = 0;
		let highlight = 0;
		for (const entry of line) {
			if (entry[1] !== undefined) {
				highlight = entry[1];
			}
			const repeat = entry[2] ?? 1;
			const word = this.textIds.word(entry[0], highlight);
			if (word === undefined || !Number.isInteger(repeat) || repeat < 0) {
				return 0;
			}
			length = writeRun(target, length, word, repeat);
			if (length === target.length) {
				break;
			}
		}
		return length;
	}

	private mapGraphemes(graphemes: readonly string[]): Uint32Array {
		let ids = this.graphemeIds.get(graphemes);
		if (!ids) {
			ids = new Uint32Array(graphemes.length);
			for (let i = 0; i < ids.length; i++) {
				ids[i] = this.textIds.id(graphemes[i]) ?? 0;
			}
			this.graphemeIds.set(graphemes, ids);
		}
		return ids;
	}

	private writePackedRuns({ runs, graphemes }: PackedGridLine, target: Uint32Array): number {
		let length = 0;
		for (let offset = 0; offset < runs.length && length < target.length; offset += 2) {
			let word = runs[offset];
			const id = word & gridTextMask;
			if (id >= firstGridGrapheme) {
				const mapped = this.textIds.id(graphemes[id - firstGridGrapheme]);
				if (mapped === undefined) {
					return 0;
				}
				word = (word & ~gridTextMask) | mapped;
			}
			length = writeRun(target, length, word, runs[offset + 1]);
		}
		return length;
	}
}

function writeRun(target: Uint32Array, start: number, word: number, repeat: number): number {
	if (repeat === 1) {
		target[start] = word;
		return start + 1;
	}
	const end = Math.min(target.length, start + repeat);
	target.fill(word, start, end);
	return end;
}
