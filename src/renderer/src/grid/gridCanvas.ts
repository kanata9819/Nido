import type { Grid } from './grid';
import type { Cell } from './gridTypes';
import { LinearRowImages } from './linearRowImage';
import { createGridGuides } from './gridGuides';
import { gridDamageBands } from './gridDamage';
import { gridCellStyles } from './gridCellStyles';
import { RowPainter, type GlyphMeasure } from './gridRowPainter';
import { HorizontalSpans, horizontalSpans, loadHorizontalSpans } from './horizontalSpans';
import { GridAtlasRows } from './gridAtlasRows';

// Paints the grid onto the canvas: changed rows are rasterized into row images, which are
// then copied to the canvas at their scrolled positions (see the comments in draw()).
type GridGuides = ReturnType<typeof createGridGuides>;

/** Everything one draw() call shares between its bands and rows. */
interface Frame {
	ctx: CanvasRenderingContext2D;
	canvas: HTMLCanvasElement;
	/** Canvas size in CSS pixels. */
	width: number;
	height: number;
	dpr: number;
	fontSize: number;
	cellWidth: number;
	cellHeight: number;
	translucent: boolean;
	cellStyle: ReturnType<typeof gridCellStyles>;
	guides: GridGuides;
	/** Ink bounds of digits per font, measured once per paint. */
	digitBounds: Map<string, { left: number; right: number }>;
	/** Font, size and theme of the glyph atlas page, without the canvas size. */
	atlasStyle: string;
}

/** Paint grid snapshots, reusing rasterized row images until their content changes. */
export class GridCanvas implements GlyphMeasure {
	private rowImages = new WeakMap<Cell[], HTMLCanvasElement>();
	private rowOverhangs = new WeakMap<HTMLCanvasElement, number>();
	private rowIndents = new WeakMap<HTMLCanvasElement, { columns: number[]; cuts: number[] }>();
	// Cell snapshots are only used to reuse rasters across horizontal moves.
	private rowSources = new WeakMap<HTMLCanvasElement, { cells: Uint32Array; leftcol: number }>();
	private readonly horizontalPlanner = new HorizontalSpans();
	private packedScratch?: Uint32Array;
	private shiftScratch?: HTMLCanvasElement;
	private glyphMetrics = new Map<string, Map<string, TextMetrics>>();
	private glyphMetricCount = 0;
	private dirtyImages = new WeakSet<HTMLCanvasElement>();
	private dirtyPrefixes = new WeakMap<
		HTMLCanvasElement,
		{ end: number; highlights: Set<number> }
	>();
	private linearRows?: LinearRowImages;
	private imageStyle = '';
	private paintDirty = true;
	private surface?: HTMLCanvasElement;
	private scrolling = false;
	private previousCursorRows: number[] = [];
	// The rows that changed since the last paint.
	private readonly dirtyRows = new Set<number>();
	private readonly atlasRows = new GridAtlasRows(this);

	constructor(private readonly grid: Grid) {}

	/**
	 * Mark a row (or with no row, everything) for repainting. A change of digits in an otherwise
	 * unchanged row, such as a line number, marks only that prefix of the row image.
	 */
	invalidate(row?: number, column?: number, before?: Cell, after?: Cell): boolean {
		let prefixCanGrow = false;
		if (row !== undefined) {
			const cells = this.grid.cells[row];
			this.atlasRows.forget(cells);
			const image = this.rowImages.get(cells);
			if (image) {
				let prefix = this.dirtyPrefixes.get(image);
				const highlight = this.grid.highlights.get(after?.highlight ?? 0);
				if (
					(!this.dirtyImages.has(image) || prefix) &&
					column !== undefined &&
					before &&
					after &&
					/^[\d ]$/.test(before.text) &&
					/^[\d ]$/.test(after.text) &&
					before.highlight === after.highlight &&
					!highlight?.codeLens &&
					!highlight?.indentGuide &&
					!highlight?.diagnostic
				) {
					prefix ??= { end: 0, highlights: new Set() };
					prefix.end = Math.max(prefix.end, column + 1);
					prefix.highlights.add(after.highlight);
					this.dirtyPrefixes.set(image, prefix);
					prefixCanGrow = true;
				} else {
					this.dirtyPrefixes.delete(image);
					this.linearRows?.invalidate(image);
				}
				this.dirtyImages.add(image);
			}
			if (!this.paintDirty) {
				this.dirtyRows.add(row);
			}
		} else {
			this.invalidatePaint();
			this.rowImages = new WeakMap();
			this.atlasRows.forget();
			this.glyphMetrics.clear();
			this.glyphMetricCount = 0;
		}
		return prefixCanGrow;
	}

	/** Reuse the visible bitmap when retained scroll cells need copy-on-write. */
	moveRowImage(before: Cell[], after: Cell[]): void {
		this.atlasRows.move(before, after);
		const image = this.rowImages.get(before);
		if (image) {
			// Retained cells stay unchanged and can rasterize again if revisited.
			this.rowImages.delete(before);
			this.rowImages.set(after, image);
		}
	}

	/** Repaint the whole canvas on the next frame, reusing the row images. */
	invalidatePaint(): void {
		this.paintDirty = true;
	}

	/**
	 * Shift a dirty row image by its window's sideways movement and return the column
	 * spans that still need text, or undefined when the whole row must rasterize again.
	 * Reuse is decided from the final cells, so a wrong shift only costs a full repaint.
	 */
	private horizontalSpans(
		image: HTMLCanvasElement,
		cells: Uint32Array,
		row: number,
		cellWidth: number,
		dpr: number,
		translucent: boolean
	): { spans: [number, number][]; margin: number } | undefined {
		const source = this.rowSources.get(image);
		const view = this.grid.horizontalView;
		const overhang = this.rowOverhangs.get(image);
		if (
			!source ||
			!view ||
			row < view.top ||
			row >= view.bottom ||
			overhang === undefined ||
			!Number.isFinite(overhang)
		) {
			return undefined;
		}
		const { left, right } = view;
		const shift = view.leftcol - source.leftcol;
		const columns = this.grid.columns;
		if (
			!Number.isInteger(shift) ||
			!shift ||
			Math.abs(shift) >= right - left ||
			source.cells.length !== columns
		) {
			return undefined;
		}
		// Neighbouring cells are drawn again inside each clip so overhanging ink matches.
		const margin = Math.ceil(overhang / cellWidth) + 1;
		const spans = horizontalSpans(cells, source.cells, left, right, shift, margin);
		if (!spans) {
			return undefined;
		}
		const x = (column: number): number => Math.round(column * cellWidth * dpr);
		const length = x(right - Math.abs(shift)) - x(left);
		const from = shift > 0 ? x(left + shift) : x(left);
		// Overlapping self-copies are not reliable on GPU canvases; stage the kept text.
		const scratch = (this.shiftScratch ??= image.ownerDocument.createElement('canvas'));
		if (scratch.width < length || scratch.height < image.height) {
			scratch.width = Math.max(scratch.width, length);
			scratch.height = Math.max(scratch.height, image.height);
		}
		const staging = scratch.getContext('2d')!;
		staging.globalCompositeOperation = 'copy';
		staging.drawImage(image, from, 0, length, image.height, 0, 0, length, image.height);
		const ctx = image.getContext('2d', { alpha: translucent })!;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.beginPath();
		ctx.rect(x(left), 0, x(right) - x(left), image.height);
		ctx.clip();
		// The cell pitch is a whole number of physical pixels, so text moves without resampling.
		ctx.globalCompositeOperation = 'copy';
		ctx.drawImage(
			scratch,
			0,
			0,
			length,
			image.height,
			shift > 0 ? x(left) : x(left - shift),
			0,
			length,
			image.height
		);
		ctx.restore();
		return { spans, margin };
	}

	/** Locate document rows intersecting the paint band without visiting the scroll cache. */
	private rowRange(top: number, bottom: number, dpr: number): [number, number] {
		if (!this.grid.rows) {
			return [0, 0];
		}
		const offset = this.grid.scrollOffset;
		const command = this.grid.rows - 1;
		const end = command + (offset > 0 ? this.grid.futureRows.length : 0);
		let low = offset < 0 ? -this.grid.historyRows.length : 0;
		let high = end;
		// Match the painter's physical-pixel overscan at the top of the damage band.
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const rowTop = this.grid.rowTop(middle);
			const rowHeight = this.grid.rowTop(middle + 1) - rowTop;
			// Preserve the painter's operation order at fractional-pixel boundaries.
			if (rowTop - offset + rowHeight + 1 / dpr < top) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		const first = low;
		high = end;
		const maximum = Math.min(bottom, this.grid.contentHeight);
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (this.grid.rowTop(middle) - offset <= maximum) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		// Future document rows follow the fixed command-line slot in the cell arrays.
		return [first >= command ? first + 1 : first, low > command ? low + 1 : low];
	}

	paintBackground(
		context: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number
	): void {
		if (this.grid.backgroundOpacity < 1) {
			// Replace the previous frame so repeated paints never accumulate opacity.
			context.clearRect(x, y, width, height);
		}
		context.fillStyle =
			this.grid.backgroundOpacity < 1
				? this.grid.background +
					Math.round(this.grid.backgroundOpacity * 255)
						.toString(16)
						.padStart(2, '0')
				: this.grid.background;
		context.fillRect(x, y, width, height);
	}

	draw(
		canvas: HTMLCanvasElement,
		width: number,
		height: number,
		fontSize: number,
		fontFamily: string,
		focused: boolean,
		cursorPosition?: { row: number; column: number; width?: number },
		lineHeight = Math.ceil(fontSize * 1.65),
		fontWeight = 400
	): { cellWidth: number; cellHeight: number } {
		const translucent = this.grid.backgroundOpacity < 1;
		const ctx = canvas.getContext('2d', { alpha: translucent })!;
		const dpr = window.devicePixelRatio || 1;
		if (
			canvas.width !== Math.round(width * dpr) ||
			canvas.height !== Math.round(height * dpr)
		) {
			this.invalidatePaint();
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// Keep the native glyph raster; interpolate its final translation only once.
		ctx.imageSmoothingEnabled = true;
		// Resolve shared highlights once per paint; the next paint sees fresh
		// definitions, theme colors and font settings without invalidation state.
		const cellStyle = gridCellStyles(
			this.grid.highlights,
			this.grid.background,
			this.grid.foreground,
			fontSize,
			fontFamily,
			fontWeight
		);
		ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
		// A fixed physical-pixel pitch keeps glyph spacing unchanged across horizontal rebases.
		const cellWidth = Math.round(ctx.measureText('M').width * dpr) / dpr;
		const cellHeight = lineHeight;
		this.updateImageStyle(
			JSON.stringify([
				width,
				dpr,
				fontSize,
				fontFamily,
				fontWeight,
				cellWidth,
				lineHeight,
				this.grid.foreground,
				this.grid.background,
				this.grid.backgroundOpacity
			])
		);
		this.updateLayout(canvas, height, cellWidth, cellHeight);
		const target = this.grid.scrollCursor ?? this.grid.cursor;
		const position = cursorPosition ?? target;
		const cursorRows = [target.row, position.row];
		const cursorTops = cursorRows.map((row) => this.grid.rowY(row));
		const bands = gridDamageBands(
			this.grid,
			cursorRows,
			this.previousCursorRows,
			this.dirtyRows,
			cellHeight,
			this.paintDirty,
			canvas.height,
			dpr
		);
		this.previousCursorRows = cursorRows;
		if (bands.length) {
			const frame: Frame = {
				ctx,
				canvas,
				width,
				height,
				dpr,
				fontSize,
				cellWidth,
				cellHeight,
				translucent,
				cellStyle,
				guides: createGridGuides(this.grid, cellWidth, dpr),
				digitBounds: new Map(),
				atlasStyle: JSON.stringify([
					dpr,
					fontSize,
					fontFamily,
					fontWeight,
					cellWidth,
					lineHeight,
					this.grid.foreground,
					this.grid.background
				])
			};
			// Separate rectangular clips retain native GPU antialiasing at fractional positions.
			for (const { top, bottom } of bands) {
				this.paintBand(frame, top, bottom, focused, cursorPosition, cursorTops);
			}
		}
		this.paintDirty = false;
		this.dirtyRows.clear();
		return { cellWidth, cellHeight };
	}

	/** Glyph metrics, cached across paints but bounded so visited CodeLens text is not kept forever. */
	measure(context: CanvasRenderingContext2D, font: string, text: string): TextMetrics {
		let glyphs = this.glyphMetrics.get(font);
		if (!glyphs) {
			glyphs = new Map();
			this.glyphMetrics.set(font, glyphs);
		}
		let metrics = glyphs.get(text);
		if (!metrics) {
			// Reuse native ink metrics across scroll frames without retaining
			// every visited CodeLens string for the life of the editor.
			if (this.glyphMetricCount >= 1024) {
				this.glyphMetrics.clear();
				this.glyphMetricCount = 0;
				glyphs = new Map();
				this.glyphMetrics.set(font, glyphs);
			}
			metrics = context.measureText(text);
			glyphs.set(text, metrics);
			this.glyphMetricCount++;
		}
		return metrics;
	}

	/** Drop every row image when anything that changes their pixels changes, such as the font. */
	private updateImageStyle(imageStyle: string): void {
		if (imageStyle !== this.imageStyle) {
			this.imageStyle = imageStyle;
			this.rowImages = new WeakMap();
			this.glyphMetrics.clear();
			this.glyphMetricCount = 0;
			this.invalidatePaint();
		}
	}

	/** Lay out rows and repaint everything if the viewport, surface or scroll mode changed. */
	private updateLayout(
		canvas: HTMLCanvasElement,
		height: number,
		cellWidth: number,
		cellHeight: number
	): void {
		const previousOffset = this.grid.scrollOffset;
		const previousHeight = this.grid.contentHeight;
		this.grid.prepareLayout(height, cellWidth, cellHeight);
		if (
			previousOffset !== this.grid.scrollOffset ||
			previousHeight !== this.grid.contentHeight ||
			this.surface !== canvas ||
			this.scrolling !== this.grid.scrolling
		) {
			this.invalidatePaint();
		}
		this.surface = canvas;
		this.scrolling = this.grid.scrolling;
	}

	/**
	 * Repaint one damaged horizontal band: the rows it crosses, then the overlays and the cursor
	 * on top.
	 */
	private paintBand(
		frame: Frame,
		paintTop: number,
		paintBottom: number,
		focused: boolean,
		cursorPosition: { row: number; column: number; width?: number } | undefined,
		cursorTops: number[]
	): void {
		const { ctx, canvas, width, height, dpr, translucent, guides } = frame;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, paintTop, canvas.width / dpr, paintBottom - paintTop);
		ctx.clip();
		this.paintBackground(ctx, 0, 0, width, height);
		ctx.textBaseline = 'alphabetic';
		if (!translucent && this.grid.pixelScrollEnabled) {
			this.linearRows ??= LinearRowImages.forDocument(canvas.ownerDocument);
		}
		const correctLight =
			!translucent &&
			this.grid.pixelScrollEnabled &&
			!!this.linearRows?.begin(canvas.width, canvas.height);
		// Opaque rows can come from the glyph atlas; the rest keep their row images.
		const atlas =
			!translucent &&
			this.grid.glyphAtlasEnabled &&
			this.atlasRows.begin({
				ctx,
				canvas,
				dpr,
				fontSize: frame.fontSize,
				cellWidth: frame.cellWidth,
				cellHeight: frame.cellHeight,
				background: this.grid.background,
				cellStyle: frame.cellStyle,
				guides,
				style: frame.atlasStyle
			});
		const [firstRow, lastRow] = this.rowRange(paintTop, paintBottom, dpr);
		const commandRow = this.grid.rows - 1;
		for (
			let row = Math.min(firstRow, Math.max(0, commandRow));
			row < Math.max(lastRow, this.grid.rows);
			row++
		) {
			// Retain the original document / command / future paint order, skipping
			// either gap around the fixed command line without inspecting its rows.
			if (row < firstRow && row !== commandRow) {
				row = firstRow - 1;
				continue;
			}
			if (row >= lastRow && row < commandRow) {
				row = commandRow - 1;
				continue;
			}
			this.paintRow(frame, row, paintTop, paintBottom, guides, correctLight, atlas);
		}
		if (atlas) {
			this.atlasRows.finish(this.grid.contentHeight, width, paintTop, paintBottom);
		}
		if (correctLight) {
			this.linearRows!.finish(ctx, dpr, this.grid.contentHeight);
		}
		this.paintOverlays(frame, paintTop, paintBottom);
		this.paintCursorLayer(frame, paintTop, paintBottom, focused, cursorPosition, cursorTops);
		ctx.restore();
	}

	/**
	 * Composite one row's image at its scrolled position, rasterizing the image first if its
	 * cells changed. Rows outside the band or the text area are skipped.
	 */
	private paintRow(
		frame: Frame,
		row: number,
		paintTop: number,
		paintBottom: number,
		guides: GridGuides,
		correctLight: boolean,
		atlas: boolean
	): void {
		const { ctx, canvas, width, height, dpr, cellHeight } = frame;
		const grid = this.grid;
		// Negative rows come from the history above the viewport, and rows past the command
		// line from the cache below it.
		const cells =
			row < 0
				? grid.historyRows[grid.historyRows.length + row]
				: row >= grid.rows
					? grid.futureRows[row - grid.rows]
					: grid.cells[row];
		const commandLine = row === grid.rows - 1;
		const layoutRow = row >= grid.rows ? row - 1 : row;
		const rowY = row >= grid.rows ? grid.rowTop(layoutRow) - grid.scrollOffset : grid.rowY(row);
		const rowHeight = commandLine
			? cellHeight
			: grid.rowTop(layoutRow + 1) - grid.rowTop(layoutRow);
		if (rowY + rowHeight + 1 / dpr < paintTop || rowY >= Math.min(paintBottom, height)) {
			return;
		}
		if (!commandLine && (rowY + rowHeight <= 0 || rowY >= grid.contentHeight)) {
			return;
		}
		const origin = grid.scrollOrigin;
		// Snap document origins, not scroll movement. All rows share the same
		// fractional translation, including across native viewport rebases.
		const top = commandLine
			? Math.round(rowY * dpr)
			: Math.round((grid.rowTop(layoutRow) + origin) * dpr) -
				(grid.scrollOffset + origin) * dpr;
		const documentTop = Math.round((grid.rowTop(layoutRow) + origin) * dpr);
		if (atlas) {
			if (
				!commandLine &&
				this.atlasRows.paint(cells, top, Math.ceil(rowHeight * dpr), documentTop)
			) {
				return;
			}
			this.atlasRows.skip(top, Math.ceil(rowHeight * dpr));
		}
		const image = this.rowImage(cells, canvas, Math.ceil(rowHeight * dpr));
		const indentState = this.rowIndents.get(image);
		if (indentState?.columns.length) {
			const cuts = guides.rowCuts(indentState.columns, documentTop, image.height);
			if (
				cuts.length !== indentState.cuts.length ||
				cuts.some((value, index) => value !== indentState.cuts[index])
			) {
				// Guide motion changes only the rows whose covered indent pixels changed.
				this.dirtyPrefixes.delete(image);
				this.dirtyImages.add(image);
				this.linearRows?.invalidate(image);
			}
		}
		if (this.dirtyImages.has(image)) {
			this.rasterizeRow(
				frame,
				image,
				cells,
				row,
				rowHeight,
				documentTop,
				indentState,
				guides
			);
		}
		// Rows inside the document already fit the band's clip.
		const clipDocument =
			!commandLine &&
			(top + image.height > grid.contentHeight * dpr || image.width > width * dpr);
		if (clipDocument) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, width, grid.contentHeight);
			ctx.clip();
		}
		// Reuse rasterized text; scroll and cursor animation only composite row images.
		ctx.drawImage(image, 0, top / dpr, image.width / dpr, image.height / dpr);
		if (clipDocument) {
			ctx.restore();
		}
		if (correctLight && !commandLine) {
			this.linearRows!.paint(image, top);
		}
	}

	/** The row image for these cells, replaced by a new dirty image if missing or resized. */
	private rowImage(
		cells: Cell[],
		canvas: HTMLCanvasElement,
		imageHeight: number
	): HTMLCanvasElement {
		let image = this.rowImages.get(cells);
		if (!image || image.height !== imageHeight) {
			if (image) {
				this.linearRows?.invalidate(image);
			}
			image = canvas.ownerDocument.createElement('canvas');
			image.width = canvas.width;
			image.height = imageHeight;
			this.rowImages.set(cells, image);
			this.dirtyImages.add(image);
		}
		return image;
	}

	/**
	 * Paint a dirty row image. Depending on what changed, this repaints the whole row, only the
	 * spans a sideways shift exposed, or only a prefix of changed digits.
	 */
	private rasterizeRow(
		frame: Frame,
		image: HTMLCanvasElement,
		cells: Cell[],
		row: number,
		rowHeight: number,
		documentTop: number,
		indentState: { columns: number[]; cuts: number[] } | undefined,
		guides: GridGuides
	): void {
		const { width, dpr, cellWidth, translucent } = frame;
		this.dirtyImages.delete(image);
		// Opaque rows allow native LCD text, matching normal DOM rendering.
		// Translucent themes need alpha surfaces and grayscale antialiasing.
		const ctx = image.getContext('2d', { alpha: translucent })!;
		const prefix = this.dirtyPrefixes.get(image);
		this.dirtyPrefixes.delete(image);
		const view = this.grid.horizontalView;
		const columns = this.grid.columns;
		let packed: Uint32Array | undefined;
		let packedIndentColumns: number[] | undefined;
		// A grid wider than its row image cannot safely copy from the off-canvas columns.
		if (
			view &&
			row >= view.top &&
			row < view.bottom &&
			Number.isInteger(view.left) &&
			Number.isInteger(view.right) &&
			view.left >= 0 &&
			view.right <= columns &&
			Math.round(view.right * cellWidth * dpr) <= image.width
		) {
			void loadHorizontalSpans();
			packed =
				this.packedScratch?.length === columns
					? this.packedScratch
					: new Uint32Array(columns);
			packedIndentColumns = this.horizontalPlanner.pack(cells, this.grid.highlights, packed);
		}
		const shifted =
			!prefix && packed
				? this.horizontalSpans(image, packed, row, cellWidth, dpr, translucent)
				: undefined;
		const indentColumns = prefix
			? (indentState?.columns ?? [])
			: (shifted && packedIndentColumns) || [];
		const previousOverhang = prefix ? this.rowOverhangs.get(image) : undefined;
		const painter = new RowPainter(
			{
				ctx,
				cells,
				columns: this.grid.columns,
				background: this.grid.background,
				cellStyle: frame.cellStyle,
				cellWidth,
				dpr,
				rowHeight,
				fontSize: frame.fontSize,
				imageHeight: image.height,
				documentTop,
				indentCuts: guides.indentCuts,
				glyphs: this
			},
			{
				// Cover snapped indent strokes and CSS-rounded box-drawing lines,
				// including their native antialias fringe at any device scale.
				overhang: Math.max(
					previousOverhang ?? (shifted ? (this.rowOverhangs.get(image) ?? 0) : 0),
					2.5 / dpr,
					0.5 + 1 / dpr
				),
				trackOverhang: previousOverhang === undefined,
				indentColumns,
				collectIndents: !prefix && !shifted
			}
		);
		const clip = prefix && painter.clipToPrefix(prefix, frame.digitBounds, previousOverhang);
		if (translucent && !shifted) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, image.width, image.height);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.textBaseline = 'alphabetic';
		if (shifted) {
			painter.paintSpans(shifted.spans, shifted.margin, translucent, image.width);
		} else {
			painter.paintAll(clip?.columns ?? this.grid.columns, width, translucent);
		}
		if (view && packed) {
			this.packedScratch = this.rowSources.get(image)?.cells;
			this.rowSources.set(image, { cells: packed, leftcol: view.leftcol });
		} else {
			this.rowSources.delete(image);
		}
		// New digits may overhang farther; retain them for shorter prefixes.
		this.rowOverhangs.set(image, painter.overhang);
		this.rowIndents.set(image, {
			columns: indentColumns,
			cuts: guides.rowCuts(indentColumns, documentTop, image.height)
		});
		if (clip) {
			ctx.restore();
			this.linearRows?.invalidate(image, clip.width);
		}
	}

	/** Paint method separators and bracket guides that cross the damaged band. */
	private paintOverlays(frame: Frame, paintTop: number, paintBottom: number): void {
		const { ctx, width, dpr, cellWidth, guides } = frame;
		const { contentHeight, stickyScroll: outline } = this.grid;
		if (
			paintTop >= contentHeight ||
			(!outline?.separators?.length && !guides.guideRects.length)
		) {
			return;
		}
		// Keep a device-pixel fringe around the clip for fractional scroll positions.
		const pixel = 1 / dpr;
		const top = paintTop - pixel;
		const bottom = Math.min(paintBottom, contentHeight) + pixel;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, width, contentHeight);
		ctx.clip();
		if (outline?.separators?.length) {
			const left = Math.round((outline.left + outline.gutter) * cellWidth * dpr) / dpr;
			const right = Math.min(width, (outline.left + outline.width) * cellWidth);
			ctx.fillStyle = this.grid.foreground;
			ctx.globalAlpha = 0.22;
			for (const separator of outline.separators) {
				const y = Math.round(this.grid.rowY(separator.row) * dpr) / dpr;
				if (y < bottom && y + pixel > top) {
					ctx.fillRect(left, y, Math.max(0, right - left), pixel);
				}
			}
		}
		for (const rect of guides.guideRects) {
			if (
				Math.min(rect.top, rect.bottom) >= bottom ||
				Math.max(rect.top, rect.bottom) <= top
			) {
				continue;
			}
			ctx.fillStyle = rect.color;
			ctx.globalAlpha = rect.alpha;
			ctx.fillRect(rect.x, rect.top, rect.width, rect.bottom - rect.top);
		}
		ctx.restore();
	}

	/** The current-line border and the cursor, where they cross the band. */
	private paintCursorLayer(
		frame: Frame,
		paintTop: number,
		paintBottom: number,
		focused: boolean,
		cursorPosition: { row: number; column: number; width?: number } | undefined,
		cursorTops: number[]
	): void {
		const { ctx, width, cellWidth, cellHeight } = frame;
		const cursor = this.grid.scrollCursor ?? this.grid.cursor;
		ctx.save();
		if (cursor.row < this.grid.rows - 1) {
			ctx.beginPath();
			ctx.rect(0, 0, width, this.grid.contentHeight);
			ctx.clip();
		}
		if (
			focused &&
			/^(normal|insert|replace|visual)/.test(this.grid.mode) &&
			cursor.row >= 0 &&
			cursor.row < this.grid.rows &&
			cursorTops[0] < paintBottom &&
			cursorTops[0] + cellHeight > paintTop
		) {
			this.paintCurrentLine(frame, cursor.row);
		}
		if (cursorTops[1] < paintBottom && cursorTops[1] + cellHeight > paintTop) {
			this.drawCursor(ctx, cellWidth, cellHeight, focused, cursorPosition);
		}
		ctx.restore();
	}

	/** Thin borders above and below the cursor's line, leaving gaps for Git change bars. */
	private paintCurrentLine(frame: Frame, row: number): void {
		const { ctx, width, height, dpr, cellWidth, cellHeight } = frame;
		const y = this.grid.rowY(row);
		// Do not let the current-line border break Git change bars.
		const signs: number[] = [];
		this.grid.cells[row]?.forEach((cell, column) => {
			if (cell.text === '▎' && this.grid.highlights.get(cell.highlight)?.gitSign) {
				signs.push(column);
			}
		});
		if (signs.length) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, width, height);
			for (const column of signs) {
				const left = Math.round(column * cellWidth * dpr);
				ctx.rect(left / dpr, 0, Math.max(1, Math.round(2 * dpr)) / dpr, height);
			}
			ctx.clip('evenodd');
		}
		ctx.fillStyle = '#46515c';
		ctx.fillRect(0, y, width, 1);
		ctx.fillRect(0, y + cellHeight - 1, width, 1);
		if (signs.length) {
			ctx.restore();
		}
	}

	private drawCursor(
		ctx: CanvasRenderingContext2D,
		cellWidth: number,
		cellHeight: number,
		focused: boolean,
		position?: { row: number; column: number; width?: number }
	): void {
		const cursor = position ?? this.grid.scrollCursor ?? this.grid.cursor;
		if (
			!this.grid.busy &&
			!this.grid.mode.startsWith('cmdline') &&
			cursor.row >= 0 &&
			cursor.row < this.grid.rows &&
			(!focused || this.grid.cursorVisible)
		) {
			const x = cursor.column * cellWidth;
			const y = this.grid.rowY(cursor.row);
			const width = (position?.width ?? this.grid.cursorWidth) * cellWidth;
			ctx.fillStyle = '#f5f5f5';
			ctx.strokeStyle = '#d4d4d4';
			ctx.globalAlpha = focused ? this.grid.cursorOpacity : 1;
			if (!focused) {
				ctx.strokeRect(x + 0.5, y + 1, width - 1, cellHeight - 2);
			} else if (this.grid.mode.startsWith('insert')) {
				ctx.fillRect(x, y + 1, 2, cellHeight - 2);
			} else {
				ctx.globalAlpha *= 0.7;
				ctx.fillRect(x, y + 1, width, cellHeight - 2);
			}
			ctx.globalAlpha = 1;
		}
	}
}
