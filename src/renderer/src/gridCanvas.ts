import type { Grid } from './grid';
import type { Cell } from './gridTypes';
import { LinearRowImages } from './linearRowImage';
import { createGridGuides } from './gridGuides';
import { gridDamageBands } from './gridDamage';
import { gridCellStyles } from './gridCellStyles';

/** Paint grid snapshots, reusing rasterized row images until their content changes. */
export class GridCanvas {
  private rowImages = new WeakMap<Cell[], HTMLCanvasElement>();
  private rowOverhangs = new WeakMap<HTMLCanvasElement, number>();
  private rowIndents = new WeakMap<HTMLCanvasElement, { columns: number[]; cuts: number[] }>();
  // Cells and sideways view position each row image was last rasterized from.
  private rowSources = new WeakMap<HTMLCanvasElement, { cells: Cell[]; leftcol?: number }>();
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
  private firstDirtyRow = Infinity;
  private lastDirtyRow = -Infinity;

  constructor(private readonly grid: Grid) {}

  invalidate(row?: number, column?: number, before?: Cell, after?: Cell): void {
    if (row !== undefined) {
      const cells = this.grid.cells[row];
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
        } else {
          this.dirtyPrefixes.delete(image);
        }
        this.linearRows?.invalidate(image);
        this.dirtyImages.add(image);
      }
      this.firstDirtyRow = Math.min(this.firstDirtyRow, row);
      this.lastDirtyRow = Math.max(this.lastDirtyRow, row);
    } else {
      this.invalidatePaint();
      this.rowImages = new WeakMap();
      this.glyphMetrics.clear();
      this.glyphMetricCount = 0;
    }
  }

  /** Reuse the visible bitmap when retained scroll cells need copy-on-write. */
  moveRowImage(before: Cell[], after: Cell[]): void {
    const image = this.rowImages.get(before);
    if (image) {
      // Retained cells stay unchanged and can rasterize again if revisited.
      this.rowImages.delete(before);
      this.rowImages.set(after, image);
    }
  }

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
    cells: Cell[],
    row: number,
    cellWidth: number,
    dpr: number,
    translucent: boolean
  ): { spans: [number, number][]; margin: number } | undefined {
    const source = this.rowSources.get(image);
    const view = this.grid.horizontalView;
    const overhang = this.rowOverhangs.get(image);
    if (
      source?.leftcol === undefined ||
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
    if (!shift || Math.abs(shift) >= right - left || right > columns) {
      return undefined;
    }
    // A grid wider than the row image (e.g. before a resize reaches Neovim) would copy
    // from past the image edge, and the copy operator would clear what it cannot read.
    if (Math.round(right * cellWidth * dpr) > image.width) {
      return undefined;
    }
    // Neighbouring cells are drawn again inside each clip so overhanging ink matches.
    const margin = Math.ceil(overhang / cellWidth) + 1;
    const stale: number[] = [];
    for (let col = 0; col < columns; col++) {
      const cell = cells[col];
      const highlight = this.grid.highlights.get(cell?.highlight ?? 0);
      if (highlight?.diagnostic || highlight?.codeLens) {
        // Badges and CodeLens span several cells with rounded or measured edges.
        return undefined;
      }
      const inside = col >= left && col < right;
      const from = inside ? col + shift : col;
      const previous = source.cells[from];
      if (
        (inside && (from < left || from >= right)) ||
        previous?.text !== cell?.text ||
        previous?.highlight !== cell?.highlight ||
        // Guide cuts follow the current scope; box lines snap in CSS pixels.
        highlight?.indentGuide ||
        cell?.text === '│' ||
        // Guides and backgrounds reach one pixel across the text area's edges.
        (inside && (col < left + margin || col >= right - margin))
      ) {
        stale.push(col);
      }
    }
    const spans: [number, number][] = [];
    let width = 0;
    // Wide and slanted glyphs can cross a clip edge, where Chromium antialiases them
    // differently from an unclipped raster. Keep span edges away from both kinds.
    const crossing = (col: number): boolean => {
      if (col < 0 || col >= columns) {
        return false;
      }
      const cell = cells[col];
      return (
        cell?.text === '' ||
        cells[col + 1]?.text === '' ||
        !!this.grid.highlights.get(cell?.highlight ?? 0)?.italic
      );
    };
    for (const col of stale) {
      let from = Math.max(0, col - margin);
      let to = Math.min(columns, col + 1 + margin);
      while (from > 0 && (crossing(from - 1) || crossing(from))) {
        from--;
      }
      while (to < columns && (crossing(to - 1) || crossing(to))) {
        to++;
      }
      const last = spans.at(-1);
      if (last && from <= last[1]) {
        width += Math.max(0, to - last[1]);
        last[1] = Math.max(last[1], to);
      } else {
        spans.push([from, to]);
        width += to - from;
      }
    }
    if (width * 2 > columns) {
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
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      this.invalidatePaint();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Keep the native glyph raster; interpolate its final translation only once.
    ctx.imageSmoothingEnabled = true;
    const family = fontFamily;
    // Resolve shared highlights once per paint; the next paint sees fresh
    // definitions, theme colors and font settings without invalidation state.
    const digitBounds = new Map<string, { left: number; right: number }>();
    const measure = (
      context: CanvasRenderingContext2D,
      font: string,
      text: string
    ): TextMetrics => {
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
    };
    const cellStyle = gridCellStyles(
      this.grid.highlights,
      this.grid.background,
      this.grid.foreground,
      fontSize,
      fontFamily,
      fontWeight
    );
    ctx.font = `${fontWeight} ${fontSize}px ${family}`;
    // A fixed physical-pixel pitch keeps glyph spacing unchanged across horizontal rebases.
    const cellWidth = Math.ceil(ctx.measureText('M').width * dpr) / dpr;
    const cellHeight = lineHeight;
    const imageStyle = JSON.stringify([
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
    ]);
    if (imageStyle !== this.imageStyle) {
      this.imageStyle = imageStyle;
      this.rowImages = new WeakMap();
      this.glyphMetrics.clear();
      this.glyphMetricCount = 0;
      this.invalidatePaint();
    }
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
    const target = this.grid.scrollCursor ?? this.grid.cursor;
    const position = cursorPosition ?? target;
    const cursorRows = [target.row, position.row];
    const cursorTops = cursorRows.map((row) => this.grid.rowY(row));
    const bands = gridDamageBands(
      this.grid,
      cursorRows,
      this.previousCursorRows,
      this.firstDirtyRow,
      this.lastDirtyRow,
      cellHeight,
      this.paintDirty,
      canvas.height,
      dpr
    );
    this.previousCursorRows = cursorRows;
    // Separate rectangular clips retain native GPU antialiasing at fractional positions.
    for (const { top: paintTop, bottom: paintBottom } of bands) {
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
        this.linearRows?.begin(canvas.width, canvas.height);
      const [firstRow, lastRow] = this.rowRange(paintTop, paintBottom, dpr);
      const commandRow = this.grid.rows - 1;
      const origin = this.grid.scrollOrigin;
      const { guideRects, indentCuts, rowCuts } = createGridGuides(this.grid, cellWidth, dpr);
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
        const cells =
          row < 0
            ? this.grid.historyRows[this.grid.historyRows.length + row]
            : row >= this.grid.rows
              ? this.grid.futureRows[row - this.grid.rows]
              : this.grid.cells[row];
        const commandLine = row === this.grid.rows - 1;
        const layoutRow = row >= this.grid.rows ? row - 1 : row;
        const rowY =
          row >= this.grid.rows
            ? this.grid.rowTop(layoutRow) - this.grid.scrollOffset
            : this.grid.rowY(row);
        const rowHeight = commandLine
          ? cellHeight
          : this.grid.rowTop(layoutRow + 1) - this.grid.rowTop(layoutRow);
        if (rowY + rowHeight + 1 / dpr < paintTop || rowY >= Math.min(paintBottom, height)) {
          continue;
        }
        if (!commandLine && (rowY + rowHeight <= 0 || rowY >= this.grid.contentHeight)) {
          continue;
        }
        // Snap document origins, not scroll movement. All rows share the same
        // fractional translation, including across native viewport rebases.
        const top = commandLine
          ? Math.round(rowY * dpr)
          : Math.round((this.grid.rowTop(layoutRow) + origin) * dpr) -
            (this.grid.scrollOffset + origin) * dpr;
        ctx.save();
        if (!commandLine) {
          ctx.beginPath();
          ctx.rect(0, 0, width, this.grid.contentHeight);
          ctx.clip();
        }
        let image = this.rowImages.get(cells);
        const imageHeight = Math.ceil(rowHeight * dpr);
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
        const indentState = this.rowIndents.get(image);
        const documentTop = Math.round((this.grid.rowTop(layoutRow) + origin) * dpr);
        if (indentState?.columns.length) {
          const cuts = rowCuts(indentState.columns, documentTop, imageHeight);
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
          this.dirtyImages.delete(image);
          // Opaque rows allow native LCD text, matching normal DOM rendering.
          // Translucent themes need alpha surfaces and grayscale antialiasing.
          const ctx = image.getContext('2d', { alpha: translucent })!;
          // Track text state within this row paint, including prefix measurements.
          let currentFont = '';
          const prefix = this.dirtyPrefixes.get(image);
          this.dirtyPrefixes.delete(image);
          const shifted = prefix
            ? undefined
            : this.horizontalSpans(image, cells, row, cellWidth, dpr, translucent);
          const indentColumns = prefix
            ? (indentState?.columns ?? [])
            : shifted
              ? Array.from({ length: this.grid.columns }, (_, col) => col).filter(
                  (col) => this.grid.highlights.get(cells[col]?.highlight ?? 0)?.indentGuide
                )
              : [];
          const previousOverhang = prefix ? this.rowOverhangs.get(image) : undefined;
          // Cover snapped indent strokes and CSS-rounded box-drawing lines,
          // including their native antialias fringe at any device scale.
          let overhang = Math.max(
            previousOverhang ?? (shifted ? (this.rowOverhangs.get(image) ?? 0) : 0),
            2.5 / dpr,
            0.5 + 1 / dpr
          );
          let columns = this.grid.columns;
          if (prefix) {
            ctx.save();
            let right = prefix.end * cellWidth + 0.5;
            for (const id of prefix.highlights) {
              const font = cellStyle(id).font;
              let ink = digitBounds.get(font);
              if (ink === undefined) {
                ctx.font = font;
                currentFont = font;
                ink = { left: -Infinity, right: -Infinity };
                for (const text of '0123456789') {
                  const metrics = measure(ctx, font, text);
                  ink.left = Math.max(ink.left, metrics.actualBoundingBoxLeft);
                  ink.right = Math.max(ink.right, metrics.actualBoundingBoxRight);
                }
                digitBounds.set(font, ink);
              }
              overhang = Number.isFinite(ink.left)
                ? Math.max(overhang, ink.left + 1.5 / dpr)
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
            ctx.rect(0, 0, edge, image.height);
            ctx.clip();
            if (previousOverhang !== undefined) {
              // A row-wide ink bound also retains distant combining glyphs.
              columns = Math.min(
                columns,
                Math.max(prefix.end, Math.ceil((edge / dpr + overhang) / cellWidth))
              );
            }
          }
          if (translucent && !shifted) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, image.width, image.height);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.textBaseline = 'alphabetic';
          let currentColor = '';
          const font = (value: string): void => {
            if (value !== currentFont) {
              ctx.font = value;
              currentFont = value;
            }
          };
          const foreground = (value: string): void => {
            if (value !== currentColor) {
              ctx.fillStyle = value;
              currentColor = value;
            }
          };
          const rememberText = (text: string): void => {
            if (previousOverhang !== undefined) {
              return;
            }
            const left = measure(ctx, currentFont, text).actualBoundingBoxLeft;
            // Snapped text origins differ by at most half a physical pixel.
            overhang = Number.isFinite(left) ? Math.max(overhang, left + 1.5 / dpr) : Infinity;
          };
          const y = 0;
          const highlightTop = Math.max(0, Math.round(((rowHeight - fontSize - 2) / 2) * dpr));
          const highlightHeight = Math.min(
            imageHeight - highlightTop,
            Math.round((fontSize + 2) * dpr)
          );
          const paintRange = (from: number, to: number): void => {
            // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
            for (let col = from; col < to; col++) {
              const style = cellStyle(cells[col]?.highlight || 0);
              const h = style.highlight;
              const background = style.background;
              if (h.diagnostic && !h.reverse) {
                const start = col;
                while (
                  col + 1 < this.grid.columns &&
                  cells[col + 1]?.highlight === cells[start]?.highlight
                ) {
                  col++;
                }
                const left = Math.round(start * cellWidth * dpr) / dpr;
                const right = Math.round((col + 1) * cellWidth * dpr) / dpr;
                const inset = Math.min(2, rowHeight / 4);
                const badgeHeight = rowHeight - inset * 2;
                foreground(background);
                ctx.beginPath();
                ctx.roundRect(left, inset, right - left, badgeHeight, 4);
                ctx.fill();
                const accent = style.accent!;
                ctx.strokeStyle = accent + '30';
                ctx.lineWidth = 1 / dpr;
                ctx.stroke();
                foreground(accent);
                ctx.beginPath();
                ctx.roundRect(left + 4, inset + 4, 2, Math.max(1, badgeHeight - 8), 1);
                ctx.fill();
                continue;
              }
              // The default background is already filled (or transparent for acrylic).
              // Repainting fractional cell edges can darken their native pixels.
              if (background === this.grid.background) {
                continue;
              }
              foreground(background);
              ctx.fillRect(
                col * cellWidth,
                h.wordHighlight ? highlightTop / dpr : y,
                cellWidth + 0.5,
                h.wordHighlight ? highlightHeight / dpr : image.height / dpr
              );
            }

            for (let col = from; col < to; col++) {
              const cell = cells[col];
              if (!cell?.text || cell.text === ' ') {
                continue;
              }

              const style = cellStyle(cell.highlight);
              const h = style.highlight;
              if (h.codeLens) {
                let text = cell.text;
                const start = col;
                while (
                  col + 1 < this.grid.columns &&
                  cells[col + 1]?.highlight === cell.highlight
                ) {
                  text += cells[++col].text;
                }
                font(style.font);
                foreground(style.foreground);
                rememberText(text);
                ctx.fillText(
                  text,
                  Math.round(start * cellWidth * dpr) / dpr,
                  Math.round((y + (rowHeight + fontSize * 0.8) / 2 - 3) * dpr) / dpr
                );
                continue;
              }
              const textSize = style.textSize;
              font(style.font);
              foreground(style.foreground);

              const x = col * cellWidth;
              const baseline = Math.round((y + (rowHeight + textSize) / 2 - 3) * dpr) / dpr;

              if (h.indentGuide) {
                if (!prefix && !shifted) {
                  indentColumns.push(col);
                }
                const left = Math.round(x * dpr) / dpr - 1 / dpr;
                let start = 0;
                for (const [first, last] of indentCuts(col)) {
                  const end = Math.min(image.height, first - documentTop);
                  if (end > start) {
                    ctx.fillRect(left, start / dpr, 1 / dpr, (end - start) / dpr);
                  }
                  start = Math.max(start, last - documentTop);
                  if (start >= image.height) {
                    break;
                  }
                }
                if (start < image.height) {
                  ctx.fillRect(left, start / dpr, 1 / dpr, (image.height - start) / dpr);
                }
              } else if (h.gitSign && cell.text === '▎') {
                // Git change bars cover the full row, including line spacing.
                // Use the row image's physical height so fractional DPI leaves no gaps.
                const left = Math.round(x * dpr);
                ctx.fillRect(
                  left / dpr,
                  0,
                  Math.max(1, Math.round(2 * dpr)) / dpr,
                  image.height / dpr
                );
              } else if (cell.text === '│') {
                // Box-drawing lines must span the cell, including the line spacing.
                ctx.fillRect(Math.round(x + cellWidth / 2), y, 1, rowHeight);
              } else {
                // Keep glyph origins on physical pixels, including fractional Windows scaling.
                rememberText(cell.text);
                const left = Math.round(x * dpr);
                ctx.fillText(cell.text, left / dpr, baseline);
              }
              if (h.bracketMatch) {
                const left = Math.round(x * dpr);
                const right = Math.round((x + cellWidth) * dpr);
                ctx.strokeStyle = '#ffffff80';
                ctx.lineWidth = 1 / dpr;
                ctx.strokeRect(
                  (left + 0.5) / dpr,
                  (highlightTop + 0.5) / dpr,
                  (right - left - 1) / dpr,
                  (highlightHeight - 1) / dpr
                );
              }
              if ((!h.bracketMatch && h.underline) || h.undercurl || h.strikethrough) {
                if (style.special !== undefined) {
                  foreground(style.special);
                }
                ctx.fillRect(
                  x,
                  h.strikethrough
                    ? y + rowHeight / 2
                    : h.underline && !h.undercurl
                      ? Math.min(rowHeight - 1, baseline + 2)
                      : y + rowHeight - 3,
                  cellWidth,
                  1
                );
              }
            }
          };
          if (shifted) {
            for (const [from, to] of shifted.spans) {
              const left = Math.round(from * cellWidth * dpr);
              // Wide glyphs in the last column overflow the grid's right edge.
              const right =
                to >= this.grid.columns ? image.width : Math.round(to * cellWidth * dpr);
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.beginPath();
              ctx.rect(left, 0, right - left, image.height);
              ctx.clip();
              if (translucent) {
                ctx.clearRect(left, 0, right - left, image.height);
              } else {
                ctx.fillStyle = this.grid.background;
                ctx.fillRect(left, 0, right - left, image.height);
              }
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              currentColor = '';
              paintRange(
                Math.max(0, from - shifted.margin),
                Math.min(this.grid.columns, to + shifted.margin)
              );
              ctx.restore();
              // restore() reverts the font and fill the tracked state assumed.
              currentFont = '';
              currentColor = '';
            }
          } else {
            if (!translucent) {
              foreground(this.grid.background);
              ctx.fillRect(0, 0, width, image.height / dpr);
            }
            paintRange(0, columns);
          }
          this.rowSources.set(image, {
            cells: cells.slice(),
            leftcol:
              this.grid.horizontalView &&
              row >= this.grid.horizontalView.top &&
              row < this.grid.horizontalView.bottom
                ? this.grid.horizontalView.leftcol
                : undefined
          });
          // New digits may overhang farther; retain them for shorter prefixes.
          this.rowOverhangs.set(image, overhang);
          this.rowIndents.set(image, {
            columns: indentColumns,
            cuts: rowCuts(indentColumns, documentTop, image.height)
          });
          if (prefix) {
            ctx.restore();
          }
        }
        // Reuse rasterized text; scroll and cursor animation only composite row images.
        ctx.drawImage(image, 0, top / dpr, image.width / dpr, image.height / dpr);
        if (correctLight && !commandLine) {
          this.linearRows!.paint(image, top);
        }
        ctx.restore();
      }
      if (correctLight) {
        this.linearRows!.finish(ctx, dpr, this.grid.contentHeight);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, this.grid.contentHeight);
      ctx.clip();
      const outline = this.grid.stickyScroll;
      if (outline?.separators?.length) {
        const left = Math.round((outline.left + outline.gutter) * cellWidth * dpr) / dpr;
        const right = Math.min(width, (outline.left + outline.width) * cellWidth);
        ctx.fillStyle = this.grid.foreground;
        ctx.globalAlpha = 0.22;
        for (const separator of outline.separators) {
          const y = Math.round(this.grid.rowY(separator.row) * dpr) / dpr;
          ctx.fillRect(left, y, Math.max(0, right - left), 1 / dpr);
        }
      }
      for (const rect of guideRects) {
        ctx.fillStyle = rect.color;
        ctx.globalAlpha = rect.alpha;
        ctx.fillRect(rect.x, rect.top, rect.width, rect.bottom - rect.top);
      }
      ctx.restore();
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
        const y = this.grid.rowY(cursor.row);
        // Do not let the current-line border break Git change bars.
        const signs: number[] = [];
        this.grid.cells[cursor.row]?.forEach((cell, column) => {
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
      if (cursorTops[1] < paintBottom && cursorTops[1] + cellHeight > paintTop) {
        this.drawCursor(ctx, cellWidth, cellHeight, focused, cursorPosition);
      }
      ctx.restore();
      ctx.restore();
    }
    this.paintDirty = false;
    this.firstDirtyRow = Infinity;
    this.lastDirtyRow = -Infinity;
    return { cellWidth, cellHeight };
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
