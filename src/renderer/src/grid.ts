// Neovimの画面を、行×列のマス目（cells）として持つクラス。
// メインプロセスから届いた 'redraw' イベントを apply() で反映し、draw() で <canvas> に描く。
// 描く処理そのものは gridCanvas.ts にある。
// なめらかなスクロールのために、画面の上下にはみ出した行（upperRows / lowerRows）も少し覚えておく。
import type { Redraw, StickyScrollState } from '../../shared/types';
import { color } from './gridColors';

import type { Cell, Highlight, BracketGuide } from './gridTypes';
import { GridCanvas } from './gridCanvas';
import { GridRowLayout } from './gridRowLayout';
import { gridHighlight } from './gridHighlight';
import { scrollGridCells } from './gridCellScroll';
export type { Cell } from './gridTypes';

/** State shared by the calls of one redraw batch. */
interface RedrawBatch {
  /** The batch refills scroll caches through `nido_scroll_cache`. */
  prefetched: boolean;
  /** Neovim moved the viewport by repainting rows rather than with grid_scroll. */
  repaintedScroll: boolean;
  /** Every viewport move in the batch was sideways. */
  sideways: boolean;
  /** Row arrays referenced before the batch, which must be copied before editing. */
  retainedRows?: Set<Cell[]>;
  retainedView?: Cell[][];
  retainedUpper: Cell[][];
  retainedLower: Cell[][];
  /** Rows gathered by a prefetch, keyed by their offset from the real viewport. */
  cacheRows?: Map<number, Cell[]>;
  cacheOffset: number;
  cacheBottom: number;
  cacheAtStart: boolean;
  cacheAtEnd: boolean;
  /** The viewport reached the start of the file. */
  atStart?: boolean;
  /** Total rows the viewport moved, for full-width vertical moves outside a prefetch. */
  shift: number;
  /** The batch includes a direct pixel-scroll reply. */
  pixelScroll: boolean;
  outgoingHeight: number;
}

export class Grid {
  // Keep enough history for fast gestures while a refill spans several display frames.
  private static readonly cacheRowLimit = 256;
  cells: Cell[][] = [];
  highlights = new Map<number, Highlight>();
  columns = 0;
  rows = 0;
  cursor = { row: 0, column: 0 };
  scrollCursor?: { row: number; column: number };
  foreground = '#d6dce2';
  background = '#191e23';
  backgroundOpacity = 1;
  mode = 'normal';
  busy = false;
  cursorVisible = true;
  cursorOpacity = 1;
  pixelScrollEnabled = false;
  scrolling = false;
  scrollFraction = 0;
  scrollPreview = 0;
  horizontalOffset = 0;
  horizontalGutter = 0;
  horizontalColumn = 0;
  /** Text area and leftcol of the window that last scrolled sideways, for row image reuse. */
  horizontalView?: { top: number; bottom: number; left: number; right: number; leftcol: number };
  // Preserve the document's raster phase when Neovim rebases the viewport.
  scrollOrigin = 0;
  cellWidth = 0;
  cellHeight = 0;
  surfaceLeft = 0;
  surfaceTop = 0;
  contentHeight = 0;
  extraRows = 0;
  bracketGuides: BracketGuide[] = [];
  stickyScroll?: StickyScrollState;
  private rowTops: number[] = [];
  private layoutDirty = true;
  private scrollPixels = 0;
  private readonly canvas = new GridCanvas(this);
  private readonly rowLayout = new GridRowLayout(this.highlights);
  private readonly rowText = new WeakMap<Cell[], string>();
  private upperRows: Cell[][] = [];
  private upperRowsAtStart = false;
  private upperTops: number[] = [0];
  private upperLayout?: Cell[][];
  private upperFontHeight = 0;
  private lowerRows: Cell[][] = [];
  private readonly cacheMembers = new WeakMap<Cell[][], Set<Cell[]>>();
  private lowerRowsAtEnd = false;
  private lowerTops: number[] = [0];
  private lowerLayout?: Cell[][];
  private lowerFontHeight = 0;

  get cursorWidth(): number {
    const cursor = this.scrollCursor ?? this.cursor;
    // Neovim sends an empty continuation cell after a wide glyph, including emoji.
    return this.cells[cursor.row]?.[cursor.column + 1]?.text === '' ? 2 : 1;
  }

  /** Keep accessibility text current without rereading the entire viewport after every edit. */
  get description(): string {
    return this.cells
      .map((row) => {
        let text = this.rowText.get(row);
        if (text === undefined) {
          text = row.map((cell) => cell.text).join('');
          this.rowText.set(row, text);
        }
        return text;
      })
      .join('\n');
  }

  get hasUpperRows(): boolean {
    return this.upperRows.length > 0;
  }

  get canPreviewUpwardScroll(): boolean {
    return this.scrollFraction + this.scrollPreview >= -this.upperRows.length;
  }

  get needsUpperRows(): boolean {
    const remaining = this.upperRows.length + Math.min(0, this.scrollFraction + this.scrollPreview);
    return !this.upperRowsAtStart && remaining <= Grid.cacheRowLimit * 0.75;
  }

  get canPreviewDownwardScroll(): boolean {
    return (
      this.scrollFraction + this.scrollPreview <=
      this.lowerRows.length + (this.lowerRowsAtEnd ? 0 : 1)
    );
  }

  get needsLowerRows(): boolean {
    const remaining = this.lowerRows.length - Math.max(0, this.scrollFraction + this.scrollPreview);
    return !this.lowerRowsAtEnd && remaining <= Grid.cacheRowLimit * 0.75;
  }

  /** Clamp animation targets only when the cache includes the actual file boundary. */
  limitScroll(lines: number): number {
    const position = this.scrollFraction + this.scrollPreview;
    const minimum = this.upperRowsAtStart ? -this.upperRows.length - position : -Infinity;
    const maximum = this.lowerRowsAtEnd ? this.lowerRows.length - position : Infinity;
    return Math.max(minimum, Math.min(maximum, lines));
  }

  rowTop(row: number): number {
    if (row < 0) {
      const index = Math.max(0, this.upperRows.length + Math.floor(row));
      const top = this.upperTops[index] ?? row * this.cellHeight;
      const bottom = this.upperTops[index + 1] ?? top + this.cellHeight;
      return top + (row - Math.floor(row)) * (bottom - top);
    }
    if (row >= this.rows - 1 && this.lowerRows.length) {
      const index = Math.floor(row) - (this.rows - 1);
      const offset = this.lowerTops[index] ?? index * this.cellHeight;
      const top = (this.rowTops[this.rows - 1] ?? (this.rows - 1) * this.cellHeight) + offset;
      const bottom = this.lowerTops[index + 1] ?? offset + this.cellHeight;
      return top + (row - Math.floor(row)) * (bottom - offset);
    }
    const index = Math.max(0, Math.min(this.rows - 1, Math.floor(row)));
    const top = this.rowTops[index] ?? index * this.cellHeight;
    const bottom = this.rowTops[index + 1] ?? top + this.cellHeight;
    return top + (row - index) * (bottom - top);
  }

  rowY(row: number): number {
    return row === this.rows - 1 ? this.contentHeight : this.rowTop(row) - this.scrollPixels;
  }

  rowAt(y: number): number {
    if (y < 0 || y >= this.contentHeight) {
      return -1;
    }
    if (y + this.scrollPixels < 0) {
      return -1;
    }
    let row = 0;
    while (row < this.rows - 1 && this.rowTop(row + 1) <= y + this.scrollPixels) {
      row++;
    }
    return row < this.rows - 1 ? row : -1;
  }

  private cacheContains(rows: Cell[][], row: Cell[]): boolean {
    if (!rows.length) {
      return false;
    }
    let members = this.cacheMembers.get(rows);
    if (!members) {
      // Scroll caches are replaced as arrays; their membership expires with them.
      members = new Set(rows);
      this.cacheMembers.set(rows, members);
    }
    return members.has(row);
  }

  // redrawイベントのまとまりを1つ反映する。イベントの種類ごとの処理は applyCall() から呼ばれる。
  // 最後に flush があれば true を返す。そのときに画面を描き直せばよい。
  /** Apply one redraw batch. Returns true when it ended with `flush`. */
  apply(events: Redraw): boolean {
    this.resetForBatch(events);
    const batch = this.beginBatch(events);
    let flush = false;
    for (const [name, ...calls] of events) {
      switch (name) {
        case 'flush':
          flush = true;
          break;
        case 'busy_start':
          this.busy = true;
          break;
        case 'busy_stop':
          this.busy = false;
          break;
      }
      for (const args of calls) {
        this.applyCall(name, args, batch);
      }
    }
    this.finishBatch(batch);
    return flush;
  }

  /** Drop scroll caches and preview state that cannot survive this batch. */
  private resetForBatch(events: Redraw): void {
    if (
      events.some(([name]) =>
        ['nido_buffer', 'nido_edit', 'grid_clear', 'grid_resize'].includes(name)
      )
    ) {
      this.scrollOrigin = 0;
      this.clearScrollCaches();
    }
    if (events.some(([name]) => name === 'nido_buffer')) {
      this.scrollFraction = 0;
      this.scrollPreview = 0;
      this.scrollCursor = undefined;
      this.scrolling = false;
      this.layoutDirty = true;
      this.canvas.invalidatePaint();
    }
  }

  private clearScrollCaches(): void {
    this.upperRows = [];
    this.upperRowsAtStart = false;
    this.lowerRows = [];
    this.lowerRowsAtEnd = false;
  }

  /** A `nido_scroll` of the whole main grid width that moves rows only. */
  private isFullWidthVerticalScroll(args: unknown[]): boolean {
    return (
      args[0] === 1 && args[1] === 0 && args[3] === 0 && args[4] === this.columns && args[6] === 0
    );
  }

  /** Capture what the batch needs from the grid as it was before any call applies. */
  private beginBatch(events: Redraw): RedrawBatch {
    // Neovim can repaint wrapped rows instead of emitting grid_scroll. Keep
    // rasterized rows at their new positions when the returned cells still match.
    const viewportMoves = events.flatMap(([name, ...calls]) =>
      name === 'nido_scroll' ? calls : []
    );
    const prefetched = events.some(([name]) => name === 'nido_scroll_cache');
    const verticalOnly = viewportMoves.every((args) => this.isFullWidthVerticalScroll(args));
    const retainedRows =
      prefetched || viewportMoves.length
        ? new Set([...this.upperRows, ...this.cells, ...this.lowerRows])
        : undefined;
    // A refill visits only its uncached strip. Retain the intervening rows
    // while Neovim jumps to that strip and back to the real viewport.
    const cacheRows = prefetched && verticalOnly ? new Map<number, Cell[]>() : undefined;
    const cacheBottom = this.rows - 1;
    if (cacheRows) {
      this.upperRows.forEach((row, i) => cacheRows.set(i - this.upperRows.length, row));
      this.lowerRows.forEach((row, i) => cacheRows.set(cacheBottom + i, row));
    }
    const shift =
      !prefetched && verticalOnly
        ? viewportMoves.reduce((total, args) => total + Number(args[5]), 0)
        : 0;
    const pixelScroll = events.some(
      ([name, ...calls]) => name === 'nido_pixel_scroll' && calls.some((args) => args[1] === true)
    );
    if (viewportMoves.length && !prefetched && !pixelScroll) {
      this.scrollOrigin = 0;
    }
    return {
      prefetched,
      repaintedScroll: viewportMoves.length > 0 && !events.some(([name]) => name === 'grid_scroll'),
      // Sideways moves keep every row in place; their images can shift instead of rasterizing.
      sideways: viewportMoves.length > 0 && viewportMoves.every((args) => args[5] === 0),
      retainedRows,
      retainedView: retainedRows ? this.cells.slice() : undefined,
      retainedUpper: retainedRows ? this.upperRows.slice() : [],
      retainedLower: retainedRows ? this.lowerRows.slice() : [],
      cacheRows,
      cacheOffset: 0,
      cacheBottom,
      cacheAtStart: this.upperRowsAtStart,
      cacheAtEnd: this.lowerRowsAtEnd,
      shift,
      pixelScroll,
      outgoingHeight: shift > 0 ? this.scrollHeight(shift) : 0
    };
  }

  private applyCall(name: string, args: unknown[], batch: RedrawBatch): void {
    switch (name) {
      case 'nido_sticky_scroll':
        this.setStickyScroll(args[0] as StickyScrollState);
        break;
      case 'nido_scroll':
        this.moveViewport(args, batch);
        break;
      case 'nido_scroll_cache':
        if (typeof args[0] === 'boolean') {
          batch.cacheAtStart = this.upperRowsAtStart = args[0];
        }
        if (typeof args[2] === 'boolean') {
          batch.cacheAtEnd = this.lowerRowsAtEnd = args[2];
        }
        if (typeof args[1] === 'boolean') {
          batch.atStart = args[1];
        }
        break;
      case 'nido_pixel_scroll':
        if (typeof args[3] === 'boolean') {
          batch.atStart = args[3];
        }
        break;
      case 'nido_bracket_guides':
        this.setBracketGuides(Array.isArray(args[0]) ? (args[0] as BracketGuide[]) : []);
        break;
      case 'grid_resize':
        if (args[0] === 1) {
          this.resize(Number(args[1]), Number(args[2]));
        }
        break;
      case 'grid_clear':
        if (args[0] === 1) {
          this.clear();
        }
        break;
      case 'grid_line':
        if (args[0] === 1) {
          this.writeLine(
            Number(args[1]),
            Number(args[2]),
            args[3] as [string, number?, number?][],
            batch
          );
        }
        break;
      case 'grid_scroll':
        if (args[0] === 1) {
          this.layoutDirty = true;
          this.canvas.invalidatePaint();
          scrollGridCells(
            this.cells,
            this.columns,
            args as number[],
            batch.retainedRows,
            this.canvas,
            this.rowLayout,
            this.rowText
          );
        }
        break;
      case 'hl_attr_define':
        this.defineHighlight(args);
        break;
      case 'default_colors_set':
        this.canvas.invalidate();
        if (Number(args[0]) >= 0) {
          this.foreground = color(Number(args[0]));
        }
        if (Number(args[1]) >= 0) {
          this.background = color(Number(args[1]));
        }
        break;
      case 'grid_cursor_goto':
        if (args[0] === 1) {
          this.cursor = { row: Number(args[1]), column: Number(args[2]) };
        }
        break;
      case 'mode_change':
        this.mode = String(args[0]);
        break;
    }
  }

  private setStickyScroll(state: StickyScrollState): void {
    const separators = Array.isArray(state.separators) ? state.separators : [];
    const previous = this.stickyScroll;
    const before = previous?.separators ?? [];
    if (
      (separators.length || before.length) &&
      (separators.length !== before.length ||
        separators.some(
          (item, i) => item.row !== before[i]?.row || item.line !== before[i]?.line
        ) ||
        state.left !== previous?.left ||
        state.gutter !== previous?.gutter ||
        state.width !== previous?.width)
    ) {
      this.canvas.invalidatePaint();
    }
    this.stickyScroll = {
      ...state,
      separators,
      scopes: Array.isArray(state.scopes) ? state.scopes : []
    };
  }

  private setBracketGuides(guides: BracketGuide[]): void {
    if (
      guides.length !== this.bracketGuides.length ||
      guides.some((guide, index) =>
        (Object.keys(guide) as (keyof BracketGuide)[]).some(
          (key) => guide[key] !== this.bracketGuides[index]?.[key]
        )
      )
    ) {
      this.bracketGuides = guides;
      this.canvas.invalidatePaint();
    }
  }

  /**
   * A viewport move reported by Neovim. grid_scroll can also move decorations inside a
   * stationary viewport, so only these moves feed the scroll preview caches.
   */
  private moveViewport(args: unknown[], batch: RedrawBatch): void {
    const [grid, top, bottom, left, right, rows, columns] = args as number[];
    if (grid === 1 && rows === 0 && columns !== 0 && typeof args[8] === 'number') {
      // Sideways moves report the text area after line numbers and signs.
      this.horizontalView = { top, bottom, left, right, leftcol: args[8] };
    }
    if (typeof args[7] === 'boolean') {
      // Virtual-line changes can move the grid at BOF without a wheel reply.
      batch.atStart = args[7];
    }
    if (!this.isFullWidthVerticalScroll(args)) {
      this.clearScrollCaches();
      return;
    }
    batch.cacheBottom = bottom;
    this.rememberCacheRows(batch);
    batch.cacheOffset += rows;
    this.shiftScrollCaches(rows, bottom - top, bottom);
  }

  /** Move rows that left the viewport into the matching cache, and trim the other one. */
  private shiftScrollCaches(rows: number, height: number, bottom: number): void {
    if (rows > 0 && (rows >= height || this.upperRows.length + rows > Grid.cacheRowLimit)) {
      this.upperRowsAtStart = false;
    }
    // Upward page-sized moves can still reuse the prefetched history.
    // Downward page jumps skip rows we have never received.
    this.upperRows =
      rows > 0
        ? rows >= height
          ? []
          : [...this.upperRows, ...this.cells.slice(0, rows)].slice(-Grid.cacheRowLimit)
        : this.upperRows.slice(0, Math.max(0, this.upperRows.length + rows));
    if (rows < 0 && (-rows >= height || this.lowerRows.length - rows > Grid.cacheRowLimit)) {
      this.lowerRowsAtEnd = false;
    }
    this.lowerRows =
      rows < 0
        ? -rows >= height
          ? []
          : [...this.cells.slice(bottom + rows, bottom), ...this.lowerRows].slice(
              0,
              Grid.cacheRowLimit
            )
        : this.lowerRows.slice(rows);
  }

  /** Record the current viewport rows at their document offset within a prefetch. */
  private rememberCacheRows(batch: RedrawBatch): void {
    if (!batch.cacheRows) {
      return;
    }
    for (let row = 0; row < batch.cacheBottom; row++) {
      const cells = this.cells[row];
      if (cells) {
        // Prepare newly fetched row geometry in the redraw handler,
        // so animation frames only read the cached counts.
        this.rowLayout.compact(cells);
        batch.cacheRows.set(batch.cacheOffset + row, cells);
        batch.retainedRows?.add(cells);
      }
    }
  }

  private resize(columns: number, rows: number): void {
    this.layoutDirty = true;
    this.canvas.invalidatePaint();
    this.columns = columns;
    this.rows = rows;
    this.cells = Array.from({ length: this.rows }, (_, row) =>
      Array.from(
        { length: this.columns },
        (_, col) => this.cells[row]?.[col] || { text: ' ', highlight: 0 }
      )
    );
  }

  private clear(): void {
    this.layoutDirty = true;
    this.canvas.invalidatePaint();
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.columns }, () => ({
        text: ' ',
        highlight: 0
      }))
    );
  }

  private writeLine(
    rowIndex: number,
    startColumn: number,
    line: [string, number?, number?][],
    batch: RedrawBatch
  ): void {
    let row = this.cells[rowIndex];
    let changed = false;
    let column = startColumn;
    let highlight = 0;
    for (const cell of line) {
      if (cell[1] !== undefined) {
        highlight = cell[1];
      }
      for (let i = 0; i < (cell[2] ?? 1); i++) {
        if (row && column < this.columns) {
          if (row[column]?.text !== cell[0] || row[column]?.highlight !== highlight) {
            if (!changed) {
              this.layoutDirty = true;
              if (this.isShared(row, batch)) {
                row = this.detachRow(rowIndex, row, batch);
              }
              changed = true;
            }
            const next = { text: cell[0], highlight };
            this.canvas.invalidate(rowIndex, column, row[column], next);
            if (row[column]?.text !== next.text) {
              this.rowText.delete(row);
            }
            this.rowLayout.replace(row, row[column], next);
            row[column] = next;
          }
        }
        column++;
      }
    }
  }

  /** Whether a scroll cache or a retained frame still references this row array. */
  private isShared(row: Cell[], batch: RedrawBatch): boolean {
    return (
      !!batch.retainedRows?.has(row) ||
      this.cacheContains(this.upperRows, row) ||
      this.cacheContains(this.lowerRows, row)
    );
  }

  /** Copy a shared row before editing it, carrying its cached image, layout and text. */
  private detachRow(rowIndex: number, previous: Cell[], batch: RedrawBatch): Cell[] {
    const row = (this.cells[rowIndex] = previous.slice());
    // Prefetch and wrapped redraws restore retained cells after applying the frame.
    if (!batch.prefetched && (!batch.repaintedScroll || batch.sideways)) {
      this.canvas.moveRowImage(previous, row);
    }
    this.rowLayout.clone(previous, row);
    const text = this.rowText.get(previous);
    if (text !== undefined) {
      this.rowText.set(row, text);
    }
    return row;
  }

  private defineHighlight(args: unknown[]): void {
    // New IDs cannot affect previously laid out or rasterized rows.
    if (this.highlights.has(Number(args[0]))) {
      this.layoutDirty = true;
      this.upperLayout = undefined;
      this.lowerLayout = undefined;
      this.rowLayout.invalidate();
      this.canvas.invalidate();
    }
    this.highlights.set(Number(args[0]), gridHighlight(args));
  }

  private finishBatch(batch: RedrawBatch): void {
    if (batch.cacheRows && batch.cacheOffset === 0) {
      this.restorePrefetchedCaches(batch, batch.cacheRows);
    }
    if (batch.atStart) {
      // Decoration redraws can emit grid_scroll without moving the viewport.
      // At BOF none of those outgoing rows belong above the current view.
      this.upperRows = [];
      this.upperRowsAtStart = true;
    }
    if (batch.retainedView) {
      this.restoreRetainedRows(batch, batch.retainedView);
    }
    if (batch.pixelScroll && batch.shift) {
      this.scrollOrigin +=
        batch.shift > 0 ? batch.outgoingHeight : -this.scrollHeight(-batch.shift);
    }
  }

  /** After a prefetch returns to the real viewport, rebuild both caches around it. */
  private restorePrefetchedCaches(batch: RedrawBatch, cacheRows: Map<number, Cell[]>): void {
    this.rememberCacheRows(batch);
    this.upperRows = [];
    this.lowerRows = [];
    for (let i = -1; i >= -Grid.cacheRowLimit && cacheRows.has(i); i--) {
      this.upperRows.push(cacheRows.get(i)!);
    }
    this.upperRows.reverse();
    const bottom = batch.cacheBottom;
    for (let i = bottom; i < bottom + Grid.cacheRowLimit && cacheRows.has(i); i++) {
      this.lowerRows.push(cacheRows.get(i)!);
    }
    this.upperRowsAtStart = batch.cacheAtStart;
    this.lowerRowsAtEnd = batch.cacheAtEnd;
  }

  /** Reuse row arrays (and their rasters) whose cells came back unchanged after a move. */
  private restoreRetainedRows(batch: RedrawBatch, retainedView: Cell[][]): void {
    this.canvas.invalidatePaint();
    const { shift, retainedUpper, retainedLower } = batch;
    for (let row = 0; row < this.rows; row++) {
      const source = row < this.rows - 1 ? row + shift : row;
      const before =
        source < 0
          ? retainedUpper[retainedUpper.length + source]
          : row < this.rows - 1 && source >= this.rows - 1
            ? retainedLower[source - (this.rows - 1)]
            : retainedView[source];
      const after = this.cells[row];
      if (
        before !== after &&
        before &&
        after &&
        before.length === after.length &&
        before.every(
          (cell, col) => cell.text === after[col].text && cell.highlight === after[col].highlight
        )
      ) {
        this.cells[row] = before;
      }
    }
  }

  /** CodeLens-only rows are compact and take 70% of a line. */
  private rowHeight(cells: Cell[], cellHeight: number): number {
    return this.rowLayout.compact(cells) ? Math.ceil(cellHeight * 0.7) : cellHeight;
  }

  private scrollHeight(rows: number): number {
    let height = rows * this.cellHeight;
    for (let row = 0; row < Math.min(rows, this.rows - 1); row++) {
      height -= this.cellHeight - this.rowHeight(this.cells[row], this.cellHeight);
    }
    return height;
  }

  paintBackground(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    this.canvas.paintBackground(context, x, y, width, height);
  }

  /** External animation overlays must be erased before the next cursor-only paint. */
  invalidatePaint(): void {
    this.canvas.invalidatePaint();
  }

  // マス目を <canvas> に描く。実際の処理は GridCanvas（gridCanvas.ts）にある。
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
    return this.canvas.draw(
      canvas,
      width,
      height,
      fontSize,
      fontFamily,
      focused,
      cursorPosition,
      lineHeight,
      fontWeight
    );
  }

  /** Compute shared row geometry before painting or hit-testing. */
  prepareLayout(height: number, cellWidth: number, cellHeight: number): void {
    this.cellWidth = cellWidth;
    if (this.layoutDirty || this.cellHeight !== cellHeight) {
      const previousTops = this.rowTops;
      this.rowTops = [0];
      for (let row = 0; row < this.rows; row++) {
        const cells = this.cells[row];
        // The last row is the command line, which never compacts.
        this.rowTops.push(
          this.rowTops[row] + (row < this.rows - 1 ? this.rowHeight(cells, cellHeight) : cellHeight)
        );
        // Compact rows shift every row below them.
        if (this.rowTops[row + 1] !== previousTops[row + 1]) {
          this.canvas.invalidatePaint();
        }
      }
      this.layoutDirty = false;
    }
    this.cellHeight = cellHeight;
    this.contentHeight = this.pixelScrollEnabled
      ? height
      : Math.max(0, (Math.floor(height / cellHeight) - 1) * cellHeight);
    const compactRows = ((this.rows - 1) * cellHeight - this.rowTop(this.rows - 1)) / cellHeight;
    this.extraRows = this.pixelScrollEnabled ? Math.ceil(compactRows) : Math.floor(compactRows);
    if (this.upperRows !== this.upperLayout || this.upperFontHeight !== cellHeight) {
      this.upperTops = new Array(this.upperRows.length + 1);
      this.upperTops[this.upperRows.length] = 0;
      for (let index = this.upperRows.length - 1; index >= 0; index--) {
        this.upperTops[index] =
          this.upperTops[index + 1] - this.rowHeight(this.upperRows[index], cellHeight);
      }
      this.upperLayout = this.upperRows;
      this.upperFontHeight = cellHeight;
    }
    if (this.lowerRows !== this.lowerLayout || this.lowerFontHeight !== cellHeight) {
      this.lowerTops = [0];
      for (const cells of this.lowerRows) {
        this.lowerTops.push(
          this.lowerTops[this.lowerTops.length - 1] + this.rowHeight(cells, cellHeight)
        );
      }
      this.lowerLayout = this.lowerRows;
      this.lowerFontHeight = cellHeight;
    }
    // Only preview rows whose text and decorations are already available.
    this.scrollPixels = this.pixelScrollEnabled
      ? this.rowTop(
          Math.max(
            -this.upperRows.length,
            Math.min(
              this.lowerRows.length + (this.lowerRowsAtEnd ? 0 : 1),
              this.scrollFraction + this.scrollPreview
            )
          )
        )
      : 0;
    // Keep the accumulated fraction through pauses and native viewport rebases.
    // The painter snaps each destination once, without changing scroll geometry.
  }

  get historyRows(): readonly Cell[][] {
    return this.upperRows;
  }

  get futureRows(): readonly Cell[][] {
    return this.lowerRows;
  }

  get scrollOffset(): number {
    return this.scrollPixels;
  }
}
