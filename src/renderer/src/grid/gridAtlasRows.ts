import type { Cell } from './gridTypes';
import type { gridCellStyles } from './gridCellStyles';
import type { createGridGuides } from './gridGuides';
import { GlyphAtlas, type Page } from './glyphAtlas';
import { RowPainter, type GlyphMeasure } from './gridRowPainter';

type CellStyles = ReturnType<typeof gridCellStyles>;
type GridGuides = ReturnType<typeof createGridGuides>;

/** What every row of one atlas frame shares. */
export interface AtlasFrame {
	ctx: CanvasRenderingContext2D;
	canvas: HTMLCanvasElement;
	dpr: number;
	fontSize: number;
	cellWidth: number;
	cellHeight: number;
	background: string;
	cellStyle: CellStyles;
	guides: GridGuides;
	/** Font, size and theme, without the canvas size. */
	style: string;
}

/** A row's tile slots, valid while its page keeps the same generation. */
interface RowTiles {
	page: Page;
	generation: number;
	/** One slot per drawn column; 0 leaves the background showing. */
	slots: Uint32Array;
	/** Columns with indent guides, which must not be cut by bracket guides to use the atlas. */
	indentColumns: number[];
}

/** Rows whose content the atlas cannot represent exactly; see build(). */
const unsupported = Symbol('unsupported');

// The tile window reaches two cells either side, which covers wide glyphs and normal fringes.
const reach = 2;
// Antialiased edges extend slightly beyond the measured outline.
const fringe = 2;

/**
 * Draws grid rows from the glyph atlas when their content allows it. A row the atlas cannot draw
 * is left to the caller's row image path.
 */
export class GridAtlasRows {
	private rows = new WeakMap<Cell[], RowTiles | typeof unsupported>();
	private readonly signatures = new Map<string, number>();
	/** Ids of a highlight signature and text together, for short tile keys. */
	private readonly looks = new Map<string, number>();
	private frame?: AtlasFrame & { page: Page; atlas: GlyphAtlas; ids: Map<number, number> };
	private previous?: { slots: Uint32Array; top: number };
	private queued = 0;
	/**
	 * Device-pixel lines last painted by row images in this band. Overlapping rows of
	 * fractional height belong to the later row, so the atlas composite leaves these lines alone.
	 */
	private owned: [number, number][] = [];
	/** Measures glyph ink without touching the canvases being painted. */
	private measureCanvas?: CanvasRenderingContext2D;

	constructor(private readonly glyphs: GlyphMeasure) {}

	/** Forget one row's tiles after its cells changed, or every row's. */
	forget(cells?: Cell[]): void {
		if (cells) {
			this.rows.delete(cells);
		} else {
			this.rows = new WeakMap();
		}
	}

	/** Keep a row's tiles when its cells move to a new array. */
	move(before: Cell[], after: Cell[]): void {
		const tiles = this.rows.get(before);
		if (tiles) {
			this.rows.delete(before);
			this.rows.set(after, tiles);
		}
	}

	/** Start a band. Returns false when the atlas is unavailable. */
	begin(frame: AtlasFrame): boolean {
		const atlas = GlyphAtlas.forDocument(frame.canvas.ownerDocument);
		const pitch = Math.round(frame.cellWidth * frame.dpr);
		const page = atlas.page(frame.style, pitch, Math.ceil(frame.cellHeight * frame.dpr));
		if (!page) {
			this.frame = undefined;
			return false;
		}
		atlas.begin(frame.canvas.width, frame.canvas.height);
		this.frame = { ...frame, page, atlas, ids: new Map() };
		this.previous = undefined;
		this.queued = 0;
		this.owned = [];
		return true;
	}

	/**
	 * Queue a row at `top` device pixels. Returns false when the row must use a row image
	 * instead.
	 */
	paint(cells: Cell[], top: number, imageHeight: number, documentTop: number): boolean {
		const frame = this.frame;
		if (!frame || imageHeight !== frame.page.height || !cells) {
			this.previous = undefined;
			return false;
		}
		const tiles = this.tiles(cells);
		if (!tiles) {
			this.previous = undefined;
			return false;
		}
		if (
			tiles.indentColumns.length &&
			frame.guides.rowCuts(tiles.indentColumns, documentTop, imageHeight).length
		) {
			this.previous = undefined;
			return false;
		}
		const { page, atlas } = frame;
		// Row images of fractional height overlap by a pixel; the later row covers the
		// earlier one, as with row images, so every cell is drawn, including blank ones.
		const gap = this.previous ? top - this.previous.top : 0;
		const above = gap > 0 && gap <= imageHeight + 1 ? this.previous!.slots : undefined;
		const line = Math.min(imageHeight - 1, Math.max(0, Math.floor(gap - 1e-6)));
		const { slots } = tiles;
		for (let column = 0; column < slots.length; column++) {
			atlas.push(
				column * page.pitch,
				top,
				slots[column],
				above ? above[column] * 256 + line : 0
			);
		}
		this.queued += slots.length;
		this.previous = { slots, top };
		// This row now covers any row image lines it overlaps.
		const start = Math.floor(top);
		const end = start + imageHeight;
		this.owned = this.owned.flatMap(([from, to]): [number, number][] =>
			to <= start || from >= end
				? [[from, to]]
				: (
						[
							[from, start],
							[end, to]
						] as [number, number][]
					).filter(([a, b]) => b > a)
		);
		return true;
	}

	/** Record a row painted from a row image at `top` device pixels instead of the atlas. */
	skip(top: number, imageHeight: number): void {
		this.previous = undefined;
		if (this.frame) {
			this.owned.push([Math.floor(top), Math.ceil(top + imageHeight)]);
		}
	}

	/** Draw the queued rows onto the editor canvas, clipped to the document area. */
	finish(contentHeight: number, width: number): void {
		const frame = this.frame;
		this.frame = undefined;
		if (!frame || !this.queued || !frame.atlas.finish(frame.page, frame.background)) {
			return;
		}
		const { ctx, canvas, dpr } = frame;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, width, contentHeight);
		ctx.clip();
		if (this.owned.length) {
			ctx.beginPath();
			let from = 0;
			for (const [start, end] of this.owned.sort((a, b) => a[0] - b[0])) {
				if (start > from) {
					ctx.rect(0, from / dpr, width, (start - from) / dpr);
				}
				from = Math.max(from, end);
			}
			if (from < canvas.height) {
				ctx.rect(0, from / dpr, width, (canvas.height - from) / dpr);
			}
			ctx.clip();
		}
		ctx.drawImage(frame.atlas.canvas, 0, 0, canvas.width / dpr, canvas.height / dpr);
		ctx.restore();
	}

	/** The tiles of a row, building them on first use; undefined when the row needs a row image. */
	private tiles(cells: Cell[]): RowTiles | undefined {
		const frame = this.frame!;
		const cached = this.rows.get(cells);
		if (cached === unsupported) {
			return undefined;
		}
		const columns = Math.ceil(frame.canvas.width / frame.page.pitch);
		if (
			cached &&
			cached.page === frame.page &&
			cached.generation === frame.page.generation &&
			cached.slots.length === columns
		) {
			return cached;
		}
		const built = this.build(cells, columns);
		if (built === unsupported) {
			this.rows.set(cells, unsupported);
			return undefined;
		}
		if (built) {
			this.rows.set(cells, built);
		}
		return built;
	}

	/** A small id for a highlight's appearance, shared by every grid with the same theme. */
	private signature(id: number): number {
		const ids = this.frame!.ids;
		let signature = ids.get(id);
		if (signature === undefined) {
			const key = JSON.stringify(this.frame!.cellStyle(id).highlight);
			signature = this.signatures.get(key);
			if (signature === undefined) {
				signature = this.signatures.size;
				this.signatures.set(key, signature);
			}
			ids.set(id, signature);
		}
		return signature;
	}

	private build(cells: Cell[], columns: number): RowTiles | typeof unsupported | undefined {
		const frame = this.frame!;
		const { page, atlas, dpr, background, cellStyle } = frame;
		const pitch = page.pitch;
		const measure = this.measureContext();
		// Setting a canvas font parses it, even when it is unchanged.
		let font = measure.font;
		// Ink extents of each cell's content relative to its left edge, in device pixels.
		const left = new Float64Array(columns);
		const right = new Float64Array(columns);
		// Each cell's text and highlight as a small id, and what it paints besides text.
		const looks = new Int32Array(columns);
		const filled = new Uint8Array(columns);
		const marked = new Uint8Array(columns);
		const indentColumns: number[] = [];
		for (let column = 0; column < columns; column++) {
			const cell = cells[column];
			left[column] = right[column] = NaN;
			if (!cell) {
				continue;
			}
			const style = cellStyle(cell.highlight);
			const h = style.highlight;
			const look = `${this.signature(cell.highlight)}:${cell.text === ' ' ? '' : cell.text}`;
			let id = this.looks.get(look);
			if (id === undefined) {
				id = this.looks.size;
				this.looks.set(look, id);
			}
			looks[column] = id;
			filled[column] = Number(style.background !== background);
			marked[column] = Number(!!(h.underline || h.strikethrough));
			// CodeLens text and diagnostic badges span several cells. Undercurls are curves, whose
			// GPU antialiasing changes slightly with their position on the canvas.
			if (h.codeLens || (h.diagnostic && !h.reverse) || h.undercurl) {
				return unsupported;
			}
			if (!cell.text || cell.text === ' ') {
				continue;
			}
			if (h.indentGuide) {
				indentColumns.push(column);
				// The guide is drawn one device pixel left of its cell.
				left[column] = -1;
				right[column] = 0;
			} else if ((h.gitSign && cell.text === '▎') || cell.text === '│') {
				left[column] = 0;
				right[column] = pitch;
			} else {
				if (font !== style.font) {
					measure.font = style.font;
					font = style.font;
				}
				const metrics = this.glyphs.measure(measure, style.font, cell.text);
				left[column] = -metrics.actualBoundingBoxLeft * dpr - fringe;
				right[column] = metrics.actualBoundingBoxRight * dpr + fringe;
				if (
					!Number.isFinite(left[column]) ||
					!Number.isFinite(right[column]) ||
					left[column] < -reach * pitch ||
					right[column] > (reach + 1) * pitch
				) {
					return unsupported;
				}
			}
		}
		const slots = new Uint32Array(columns);
		const window: Cell[] = [];
		const blank: Cell = { text: ' ', highlight: 0 };
		for (let column = 0; column < columns; column++) {
			const own = cells[column];
			let key = own ? `${looks[column]}` : '';
			let plain = !own || (Number.isNaN(left[column]) && !filled[column] && !marked[column]);
			window.length = 0;
			for (let offset = -reach; offset <= reach; offset++) {
				const index = column + offset;
				const cell = cells[index];
				if (offset === 0) {
					window.push(cell ?? blank);
					continue;
				}
				const x = offset * pitch;
				if (
					cell &&
					index >= 0 &&
					((x + left[index] < pitch && x + right[index] > 0) ||
						// A background is filled half a pixel into the next cell.
						(offset === -1 && filled[index]))
				) {
					plain = false;
					key += `,${offset}:${looks[index]}`;
					window.push(cell);
				} else {
					window.push(blank);
				}
			}
			if (plain) {
				continue;
			}
			const slot =
				page.tiles.get(key) ??
				atlas.slot(
					page,
					key,
					(context) => this.paintTile(context, window),
					(2 * reach + 1) * pitch,
					reach * pitch
				);
			if (slot === undefined) {
				// The page is full; it starts again next frame.
				return undefined;
			}
			slots[column] = slot;
		}
		return { page, generation: page.generation, slots, indentColumns };
	}

	private measureContext(): CanvasRenderingContext2D {
		this.measureCanvas ??=
			this.frame!.canvas.ownerDocument.createElement('canvas').getContext('2d')!;
		return this.measureCanvas;
	}

	/** Paint a tile's window of cells with the same painter as a row image. */
	private paintTile(context: CanvasRenderingContext2D, cells: Cell[]): void {
		const frame = this.frame!;
		const { dpr, cellWidth, cellHeight, fontSize, background, cellStyle } = frame;
		context.scale(dpr, dpr);
		context.textBaseline = 'alphabetic';
		const painter = new RowPainter(
			{
				ctx: context,
				cells,
				columns: cells.length,
				background,
				cellStyle,
				cellWidth,
				dpr,
				rowHeight: cellHeight,
				fontSize,
				imageHeight: frame.page.height,
				documentTop: 0,
				indentCuts: () => [],
				glyphs: this.glyphs
			},
			{ overhang: 0, trackOverhang: false, indentColumns: [], collectIndents: false }
		);
		painter.paintAll(cells.length, cells.length * cellWidth, false);
	}
}
