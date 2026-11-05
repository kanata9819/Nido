import type { Cell } from './gridTypes';
import type { gridCellStyles } from './gridCellStyles';
import type { createGridGuides } from './gridGuides';

type CellStyles = ReturnType<typeof gridCellStyles>;
type CellStyle = ReturnType<CellStyles>;

/** Measures glyphs, reusing cached metrics across paints. */
export interface GlyphMeasure {
	measure(context: CanvasRenderingContext2D, font: string, text: string): TextMetrics;
}

/** What a row painter needs to rasterize one row of cells into its row image. */
export interface RowPaint {
	/** The row image's context. */
	ctx: CanvasRenderingContext2D;
	cells: Cell[];
	columns: number;
	/** The grid's default background, which is already filled. */
	background: string;
	cellStyle: CellStyles;
	cellWidth: number;
	dpr: number;
	rowHeight: number;
	fontSize: number;
	/** Physical height of the row image. */
	imageHeight: number;
	/** Physical top of the row in document coordinates, for indent guide cuts. */
	documentTop: number;
	indentCuts: ReturnType<typeof createGridGuides>['indentCuts'];
	glyphs: GlyphMeasure;
}

/**
 * Rasterizes one row of cells into its row image. Font and fill changes are tracked so each is
 * set only when it differs, and the left ink overhang of painted text is recorded so a later
 * partial repaint can keep glyphs that cross its edge.
 */
export class RowPainter {
	/** The font the context currently uses. */
	currentFont = '';
	private currentColor = '';
	/** How far any painted glyph reaches left of its cell, in CSS pixels. */
	overhang: number;
	/** Columns with indent guides, for moving guide cuts later. */
	readonly indentColumns: number[];
	private readonly trackOverhang: boolean;
	private readonly collectIndents: boolean;
	/** Physical top and height of word highlights and bracket match boxes. */
	private readonly highlightTop: number;
	private readonly highlightHeight: number;

	constructor(
		private readonly row: RowPaint,
		options: {
			overhang: number;
			/** Record the overhang of painted text; false when a previous overhang still applies. */
			trackOverhang: boolean;
			indentColumns: number[];
			/** Add painted indent guide columns to `indentColumns`. */
			collectIndents: boolean;
		}
	) {
		this.overhang = options.overhang;
		this.trackOverhang = options.trackOverhang;
		this.indentColumns = options.indentColumns;
		this.collectIndents = options.collectIndents;
		this.highlightTop = Math.max(
			0,
			Math.round(((row.rowHeight - row.fontSize - 2) / 2) * row.dpr)
		);
		this.highlightHeight = Math.min(
			row.imageHeight - this.highlightTop,
			Math.round((row.fontSize + 2) * row.dpr)
		);
	}

	/**
	 * Clip to the damaged prefix of a row whose leading digits changed, such as line numbers,
	 * keeping the unchanged suffix and glyphs crossing the damage edge. Saves the context; the
	 * caller restores it. Returns how many columns to repaint.
	 */
	clipToPrefix(
		prefix: { end: number; highlights: Set<number> },
		digitBounds: Map<string, { left: number; right: number }>,
		previousOverhang: number | undefined
	): number {
		const { ctx, cellWidth, dpr } = this.row;
		let columns = this.row.columns;
		ctx.save();
		let right = prefix.end * cellWidth + 0.5;
		for (const id of prefix.highlights) {
			const font = this.row.cellStyle(id).font;
			let ink = digitBounds.get(font);
			if (ink === undefined) {
				ctx.font = font;
				this.currentFont = font;
				ink = { left: -Infinity, right: -Infinity };
				for (const text of '0123456789') {
					const metrics = this.row.glyphs.measure(ctx, font, text);
					ink.left = Math.max(ink.left, metrics.actualBoundingBoxLeft);
					ink.right = Math.max(ink.right, metrics.actualBoundingBoxRight);
				}
				digitBounds.set(font, ink);
			}
			this.overhang = Number.isFinite(ink.left)
				? Math.max(this.overhang, ink.left + 1.5 / dpr)
				: Infinity;
			right = Math.max(
				right,
				Math.round((prefix.end - 1) * cellWidth * dpr) / dpr + ink.right
			);
		}
		// Preserve the unchanged suffix, including glyphs crossing the damage edge.
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.beginPath();
		const edge = Math.ceil(right * dpr) + 1;
		ctx.rect(0, 0, edge, this.row.imageHeight);
		ctx.clip();
		if (previousOverhang !== undefined) {
			// A row-wide ink bound also retains distant combining glyphs.
			columns = Math.min(
				columns,
				Math.max(prefix.end, Math.ceil((edge / dpr + this.overhang) / cellWidth))
			);
		}
		return columns;
	}

	/** Repaint the first `columns` cells over the default background. */
	paintAll(columns: number, width: number, translucent: boolean): void {
		if (!translucent) {
			this.setFill(this.row.background);
			this.row.ctx.fillRect(0, 0, width, this.row.imageHeight / this.row.dpr);
		}
		this.paint(0, columns);
	}

	/**
	 * Repaint only the column spans that a sideways shift exposed, plus `margin` columns around
	 * each so glyphs crossing a span edge are complete.
	 */
	paintSpans(
		spans: [number, number][],
		margin: number,
		translucent: boolean,
		imageWidth: number
	): void {
		const { ctx, cellWidth, dpr, columns, imageHeight } = this.row;
		for (const [from, to] of spans) {
			const left = Math.round(from * cellWidth * dpr);
			// Wide glyphs in the last column overflow the grid's right edge.
			const right = to >= columns ? imageWidth : Math.round(to * cellWidth * dpr);
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.beginPath();
			ctx.rect(left, 0, right - left, imageHeight);
			ctx.clip();
			if (translucent) {
				ctx.clearRect(left, 0, right - left, imageHeight);
			} else {
				ctx.fillStyle = this.row.background;
				ctx.fillRect(left, 0, right - left, imageHeight);
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			this.currentColor = '';
			this.paint(Math.max(0, from - margin), Math.min(columns, to + margin));
			ctx.restore();
			// restore() reverts the font and fill the tracked state assumed.
			this.currentFont = '';
			this.currentColor = '';
		}
	}

	private setFont(value: string): void {
		if (value !== this.currentFont) {
			this.row.ctx.font = value;
			this.currentFont = value;
		}
	}

	private setFill(value: string): void {
		if (value !== this.currentColor) {
			this.row.ctx.fillStyle = value;
			this.currentColor = value;
		}
	}

	private rememberText(text: string): void {
		if (!this.trackOverhang) {
			return;
		}
		const left = this.row.glyphs.measure(
			this.row.ctx,
			this.currentFont,
			text
		).actualBoundingBoxLeft;
		// Snapped text origins differ by at most half a physical pixel.
		this.overhang = Number.isFinite(left)
			? Math.max(this.overhang, left + 1.5 / this.row.dpr)
			: Infinity;
	}

	/** Paint cells [from, to): backgrounds first so a wide glyph is not erased by its continuation cell. */
	private paint(from: number, to: number): void {
		this.paintBackgrounds(from, to);
		this.paintText(from, to);
	}

	private paintBackgrounds(from: number, to: number): void {
		const { ctx, cells, cellWidth, dpr, imageHeight } = this.row;
		for (let col = from; col < to; col++) {
			const style = this.row.cellStyle(cells[col]?.highlight || 0);
			const h = style.highlight;
			if (h.diagnostic && !h.reverse) {
				col = this.paintDiagnosticBadge(col, style);
				continue;
			}
			// The default background is already filled (or transparent for acrylic).
			// Repainting fractional cell edges can darken their native pixels.
			if (style.background === this.row.background) {
				continue;
			}
			this.setFill(style.background);
			ctx.fillRect(
				col * cellWidth,
				h.wordHighlight ? this.highlightTop / dpr : 0,
				cellWidth + 0.5,
				h.wordHighlight ? this.highlightHeight / dpr : imageHeight / dpr
			);
		}
	}

	/** Diagnostic text is drawn on a rounded badge with an accent bar. Returns the badge's last column. */
	private paintDiagnosticBadge(start: number, style: CellStyle): number {
		const { ctx, cells, columns, cellWidth, dpr, rowHeight } = this.row;
		let col = start;
		while (col + 1 < columns && cells[col + 1]?.highlight === cells[start]?.highlight) {
			col++;
		}
		const left = Math.round(start * cellWidth * dpr) / dpr;
		const right = Math.round((col + 1) * cellWidth * dpr) / dpr;
		const inset = Math.min(2, rowHeight / 4);
		const badgeHeight = rowHeight - inset * 2;
		this.setFill(style.background);
		ctx.beginPath();
		ctx.roundRect(left, inset, right - left, badgeHeight, 4);
		ctx.fill();
		const accent = style.accent!;
		ctx.strokeStyle = accent + '30';
		ctx.lineWidth = 1 / dpr;
		ctx.stroke();
		this.setFill(accent);
		ctx.beginPath();
		ctx.roundRect(left + 4, inset + 4, 2, Math.max(1, badgeHeight - 8), 1);
		ctx.fill();
		return col;
	}

	private paintText(from: number, to: number): void {
		const { cells } = this.row;
		for (let col = from; col < to; col++) {
			const cell = cells[col];
			if (!cell?.text || cell.text === ' ') {
				continue;
			}
			const style = this.row.cellStyle(cell.highlight);
			if (style.highlight.codeLens) {
				col = this.paintCodeLens(col, style);
			} else {
				this.paintCell(col, cell, style);
			}
		}
	}

	/** CodeLens text is drawn as one run so proportional glyphs keep their spacing. Returns its last column. */
	private paintCodeLens(start: number, style: CellStyle): number {
		const { ctx, cells, columns, cellWidth, dpr, rowHeight, fontSize } = this.row;
		const highlight = cells[start].highlight;
		let text = cells[start].text;
		let col = start;
		while (col + 1 < columns && cells[col + 1]?.highlight === highlight) {
			text += cells[++col].text;
		}
		this.setFont(style.font);
		this.setFill(style.foreground);
		this.rememberText(text);
		ctx.fillText(
			text,
			Math.round(start * cellWidth * dpr) / dpr,
			Math.round(((rowHeight + fontSize * 0.8) / 2 - 3) * dpr) / dpr
		);
		return col;
	}

	private paintCell(col: number, cell: Cell, style: CellStyle): void {
		const { ctx, cellWidth, dpr, rowHeight, imageHeight } = this.row;
		const h = style.highlight;
		this.setFont(style.font);
		this.setFill(style.foreground);
		const x = col * cellWidth;
		const baseline = Math.round(((rowHeight + style.textSize) / 2 - 3) * dpr) / dpr;
		if (h.indentGuide) {
			this.paintIndentGuide(col, x);
		} else if (h.gitSign && cell.text === '▎') {
			// Git change bars cover the full row, including line spacing.
			// Use the row image's physical height so fractional DPI leaves no gaps.
			const left = Math.round(x * dpr);
			ctx.fillRect(left / dpr, 0, Math.max(1, Math.round(2 * dpr)) / dpr, imageHeight / dpr);
		} else if (cell.text === '│') {
			// Box-drawing lines must span the cell, including the line spacing.
			ctx.fillRect(Math.round(x + cellWidth / 2), 0, 1, rowHeight);
		} else {
			// Keep glyph origins on physical pixels, including fractional Windows scaling.
			this.rememberText(cell.text);
			const left = Math.round(x * dpr);
			ctx.fillText(cell.text, left / dpr, baseline);
		}
		this.paintDecorations(x, baseline, style);
	}

	/** A one-pixel indent guide, cut where bracket guides cross it. */
	private paintIndentGuide(col: number, x: number): void {
		const { ctx, dpr, imageHeight, documentTop } = this.row;
		if (this.collectIndents) {
			this.indentColumns.push(col);
		}
		const left = Math.round(x * dpr) / dpr - 1 / dpr;
		let start = 0;
		for (const [first, last] of this.row.indentCuts(col)) {
			const end = Math.min(imageHeight, first - documentTop);
			if (end > start) {
				ctx.fillRect(left, start / dpr, 1 / dpr, (end - start) / dpr);
			}
			start = Math.max(start, last - documentTop);
			if (start >= imageHeight) {
				break;
			}
		}
		if (start < imageHeight) {
			ctx.fillRect(left, start / dpr, 1 / dpr, (imageHeight - start) / dpr);
		}
	}

	/** The bracket match box, underlines, undercurls and strikethrough. */
	private paintDecorations(x: number, baseline: number, style: CellStyle): void {
		const { ctx, cellWidth, dpr, rowHeight } = this.row;
		const h = style.highlight;
		if (h.bracketMatch) {
			const left = Math.round(x * dpr);
			const right = Math.round((x + cellWidth) * dpr);
			ctx.strokeStyle = '#ffffff80';
			ctx.lineWidth = 1 / dpr;
			ctx.strokeRect(
				(left + 0.5) / dpr,
				(this.highlightTop + 0.5) / dpr,
				(right - left - 1) / dpr,
				(this.highlightHeight - 1) / dpr
			);
		}
		if ((!h.bracketMatch && h.underline) || h.undercurl || h.strikethrough) {
			if (style.special !== undefined) {
				this.setFill(style.special);
			}
			ctx.fillRect(
				x,
				h.strikethrough
					? rowHeight / 2
					: h.underline && !h.undercurl
						? Math.min(rowHeight - 1, baseline + 2)
						: rowHeight - 3,
				cellWidth,
				1
			);
		}
	}
}
