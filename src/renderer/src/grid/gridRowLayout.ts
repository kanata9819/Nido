import type { Cell, Highlight } from './gridTypes';

/** Non-blank cells of a row: in CodeLens highlights and in other text. */
interface RowContent {
	lenses: number;
	text: number;
}

/** Count only changed cells instead of rescanning rows for compact CodeLens geometry. */
export class GridRowLayout {
	private rows = new WeakMap<Cell[], RowContent>();

	constructor(private readonly highlights: Map<number, Highlight>) {}

	/** Whether a row holds only CodeLens text, which is drawn in a shorter row. */
	compact(row: Cell[]): boolean {
		let content = this.rows.get(row);
		if (!content) {
			content = { lenses: 0, text: 0 };
			for (const cell of row) {
				this.count(content, cell, 1);
			}
			this.rows.set(row, content);
		}
		return content.lenses > 0 && content.text === 0;
	}

	/** Update the counts after one cell of `row` changed. */
	replace(row: Cell[], before: Cell | undefined, after: Cell): void {
		const content = this.rows.get(row);
		if (content) {
			this.count(content, before, -1);
			this.count(content, after, 1);
		}
	}

	/** Give a copied row the counts of the row it was copied from. */
	clone(before: Cell[], after: Cell[]): void {
		const content = this.rows.get(before);
		if (content) {
			this.rows.set(after, { ...content });
		}
	}

	/** Count a row (or every row) again, for example after a highlight changed. */
	invalidate(row?: Cell[]): void {
		if (row) {
			this.rows.delete(row);
		} else {
			this.rows = new WeakMap();
		}
	}

	private count(content: RowContent, cell: Cell | undefined, delta: number): void {
		if (cell?.text.trim()) {
			content[this.highlights.get(cell.highlight)?.codeLens ? 'lenses' : 'text'] += delta;
		}
	}
}
