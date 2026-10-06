import type { Redraw, StickyScrollState } from '../../shared/types';
import { color } from './gridColors';

export interface Cell {
    text: string;
    highlight: number;
}

interface Highlight {
    codeLens?: boolean;
    indentGuide?: boolean;
    foreground?: number;
    background?: number;
    special?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    undercurl?: boolean;
    reverse?: boolean;
    strikethrough?: boolean;
}

interface BracketGuide {
    column: number;
    top: number;
    bottom: number;
    opening: number;
    closing: number;
    color: string;
    active: boolean;
}

function cellBackground(h: Highlight, background: string, foreground: string): string {
    if (h.reverse) {
        if (h.foreground === undefined) {
            return foreground;
        }
        return color(h.foreground);
    }
    if (h.background === undefined) {
        return background;
    }
    return color(h.background);
}

function cellForeground(h: Highlight, background: string, foreground: string): string {
    if (h.reverse) {
        if (h.background === undefined) {
            return background;
        }
        return color(h.background);
    }
    if (h.foreground === undefined) {
        return foreground;
    }
    return color(h.foreground);
}

export class Grid {
    private static readonly rasterPhases = 4;
    // Keep enough history for fast gestures while a refill spans several display frames.
    private static readonly upperRowLimit = 256;
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
    private rowImages = new WeakMap<Cell[], HTMLCanvasElement[]>();
    private imageStyle = '';
    private upperRows: Cell[][] = [];
    private upperRowsAtStart = false;
    private upperTops: number[] = [0];
    private upperLayout?: Cell[][];
    private upperFontHeight = 0;

    get hasUpperRows(): boolean {
        return this.upperRows.length > 0;
    }

    get canPreviewUpwardScroll(): boolean {
        return this.scrollFraction + this.scrollPreview >= -this.upperRows.length;
    }

    get needsUpperRows(): boolean {
        const remaining =
            this.upperRows.length + Math.min(0, this.scrollFraction + this.scrollPreview);
        return !this.upperRowsAtStart && remaining <= Grid.upperRowLimit * 0.75;
    }

    rowTop(row: number): number {
        if (row < 0) {
            const index = Math.max(0, this.upperRows.length + Math.floor(row));
            const top = this.upperTops[index] ?? row * this.cellHeight;
            const bottom = this.upperTops[index + 1] ?? top + this.cellHeight;
            return top + (row - Math.floor(row)) * (bottom - top);
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

    apply(events: Redraw): boolean {
        // Neovim can repaint wrapped rows instead of emitting grid_scroll. Keep
        // rasterized rows at their new positions when the returned cells still match.
        const viewportMoves = events.flatMap(([name, ...calls]) =>
            name === 'nido_scroll' ? calls : []
        );
        const prefetched = events.some(([name]) => name === 'nido_scroll_cache');
        const retainedRows =
            prefetched || viewportMoves.length
                ? new Set([...this.upperRows, ...this.cells])
                : undefined;
        const retainedView = retainedRows ? this.cells.slice() : undefined;
        const retainedUpper = retainedRows ? this.upperRows.slice() : [];
        const shift =
            !prefetched &&
            viewportMoves.every(
                (args) =>
                    args[0] === 1 &&
                    args[1] === 0 &&
                    args[3] === 0 &&
                    args[4] === this.columns &&
                    args[6] === 0
            )
                ? viewportMoves.reduce((total, args) => total + Number(args[5]), 0)
                : 0;
        if (
            events.some(
                ([name]) => name === 'nido_edit' || name === 'grid_clear' || name === 'grid_resize'
            )
        ) {
            this.upperRows = [];
            this.upperRowsAtStart = false;
        }
        let flush = false;
        let atStart: boolean | undefined;
        for (const [name, ...calls] of events) {
            switch (name) {
                case 'flush': {
                    flush = true;
                    break;
                }
                case 'busy_start': {
                    this.busy = true;
                    break;
                }
                case 'busy_stop': {
                    this.busy = false;
                    break;
                }
            }

            for (const args of calls) {
                if (name === 'nido_sticky_scroll') {
                    const state = args[0] as StickyScrollState;
                    this.stickyScroll = {
                        ...state,
                        scopes: Array.isArray(state.scopes) ? state.scopes : []
                    };
                    continue;
                }
                // grid_scroll can also move decorations inside a stationary viewport.
                // Only actual viewport movement contributes to the preview history.
                if (name === 'nido_scroll') {
                    const [grid, top, bottom, left, right, rows, columns] = args as number[];
                    if (
                        grid === 1 &&
                        top === 0 &&
                        left === 0 &&
                        right === this.columns &&
                        columns === 0
                    ) {
                        if (
                            rows > 0 &&
                            (rows >= bottom - top ||
                                this.upperRows.length + rows > Grid.upperRowLimit)
                        ) {
                            this.upperRowsAtStart = false;
                        }
                        // Upward page-sized moves can still reuse the prefetched history.
                        // Downward page jumps skip rows we have never received.
                        this.upperRows =
                            rows > 0
                                ? rows >= bottom - top
                                    ? []
                                    : [...this.upperRows, ...this.cells.slice(0, rows)].slice(
                                          -Grid.upperRowLimit
                                      )
                                : this.upperRows.slice(
                                      0,
                                      Math.max(0, this.upperRows.length + rows)
                                  );
                    } else {
                        this.upperRows = [];
                        this.upperRowsAtStart = false;
                    }
                }
                switch (name) {
                    case 'nido_scroll_cache': {
                        this.upperRowsAtStart = args[0] === true;
                        if (typeof args[1] === 'boolean') {
                            atStart = args[1];
                        }
                        break;
                    }
                    case 'nido_pixel_scroll': {
                        if (typeof args[3] === 'boolean') {
                            atStart = args[3];
                        }
                        break;
                    }
                    case 'nido_bracket_guides': {
                        this.bracketGuides = Array.isArray(args[0])
                            ? (args[0] as BracketGuide[])
                            : [];
                        break;
                    }
                    case 'grid_resize': {
                        if (args[0] !== 1) {
                            break;
                        }
                        this.layoutDirty = true;
                        this.columns = Number(args[1]);
                        this.rows = Number(args[2]);
                        this.cells = Array.from({ length: this.rows }, (_, row) =>
                            Array.from(
                                { length: this.columns },
                                (_, col) => this.cells[row]?.[col] || { text: ' ', highlight: 0 }
                            )
                        );
                        break;
                    }
                    case 'grid_clear': {
                        if (args[0] !== 1) {
                            break;
                        }
                        this.layoutDirty = true;
                        this.cells = Array.from({ length: this.rows }, () =>
                            Array.from({ length: this.columns }, () => ({
                                text: ' ',
                                highlight: 0
                            }))
                        );
                        break;
                    }
                    case 'grid_line': {
                        if (args[0] !== 1) {
                            break;
                        }
                        this.layoutDirty = true;
                        let row = this.cells[Number(args[1])];
                        let changed = false;
                        let column = Number(args[2]);
                        let highlight = 0;
                        for (const cell of args[3] as [string, number?, number?][]) {
                            if (cell[1] !== undefined) {
                                highlight = cell[1];
                            }
                            for (let i = 0; i < (cell[2] ?? 1); i++) {
                                if (row && column < this.columns) {
                                    if (
                                        row[column]?.text !== cell[0] ||
                                        row[column]?.highlight !== highlight
                                    ) {
                                        if (!changed) {
                                            if (
                                                this.upperRows.includes(row) ||
                                                retainedRows?.has(row)
                                            ) {
                                                row = this.cells[Number(args[1])] = row.slice();
                                            }
                                            this.rowImages.delete(row);
                                            changed = true;
                                        }
                                        row[column] = { text: cell[0], highlight };
                                    }
                                }

                                column++;
                            }
                        }
                        break;
                    }
                    case 'grid_scroll': {
                        if (args[0] !== 1) {
                            break;
                        }
                        this.layoutDirty = true;
                        const [, top, bottom, left, right, rows, columns] = args as number[];
                        if (left === 0 && right === this.columns && columns === 0) {
                            const old = this.cells.slice();
                            for (let row = top; row < bottom; row++) {
                                const source = row + rows;
                                this.cells[row] =
                                    source >= top && source < bottom
                                        ? old[source]
                                        : Array.from({ length: this.columns }, () => ({
                                              text: ' ',
                                              highlight: 0
                                          }));
                            }
                            break;
                        }
                        const old = this.cells.map((row) => row.slice());
                        for (let row = top; row < bottom; row++) {
                            if (retainedRows?.has(this.cells[row])) {
                                this.cells[row] = this.cells[row].slice();
                            }
                            this.rowImages.delete(this.cells[row]);
                            for (let col = left; col < right; col++) {
                                const sourceRow = row + rows;
                                const sourceCol = col + columns;
                                this.cells[row][col] =
                                    sourceRow >= top &&
                                    sourceRow < bottom &&
                                    sourceCol >= left &&
                                    sourceCol < right
                                        ? old[sourceRow][sourceCol]
                                        : { text: ' ', highlight: 0 };
                            }
                        }
                        break;
                    }
                    case 'hl_attr_define': {
                        this.layoutDirty = true;
                        this.upperLayout = undefined;
                        this.rowImages = new WeakMap();
                        const info = args[3] as { hi_name?: string }[] | undefined;
                        this.highlights.set(Number(args[0]), {
                            ...(args[1] as Highlight),
                            codeLens: info?.some(
                                (item) =>
                                    item.hi_name === 'NidoCodeLens' ||
                                    item.hi_name === 'NidoCodeLensHint'
                            ),
                            indentGuide: info?.some((item) =>
                                /^NidoIndent\d+$/.test(item.hi_name || '')
                            )
                        });
                        break;
                    }
                    case 'default_colors_set': {
                        this.rowImages = new WeakMap();
                        if (Number(args[0]) >= 0) {
                            this.foreground = color(Number(args[0]));
                        }
                        if (Number(args[1]) >= 0) {
                            this.background = color(Number(args[1]));
                        }
                        break;
                    }
                    case 'grid_cursor_goto': {
                        if (args[0] !== 1) {
                            break;
                        }
                        this.cursor = { row: Number(args[1]), column: Number(args[2]) };
                        break;
                    }
                    case 'mode_change': {
                        this.mode = String(args[0]);
                        break;
                    }
                }
            }
        }
        if (atStart) {
            // Decoration redraws can emit grid_scroll without moving the viewport.
            // At BOF none of those outgoing rows belong above the current view.
            this.upperRows = [];
            this.upperRowsAtStart = true;
        }
        if (retainedView) {
            for (let row = 0; row < this.rows; row++) {
                const source = row < this.rows - 1 ? row + shift : row;
                const before =
                    source < 0
                        ? retainedUpper[retainedUpper.length + source]
                        : retainedView[source];
                const after = this.cells[row];
                if (
                    before &&
                    after &&
                    before.length === after.length &&
                    before.every(
                        (cell, col) =>
                            cell.text === after[col].text && cell.highlight === after[col].highlight
                    )
                ) {
                    this.cells[row] = before;
                }
            }
        }
        return flush;
    }

    paintBackground(
        context: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        if (this.backgroundOpacity < 1) {
            // Replace the previous frame so repeated paints never accumulate opacity.
            context.clearRect(x, y, width, height);
        }
        context.fillStyle =
            this.backgroundOpacity < 1
                ? this.background +
                  Math.round(this.backgroundOpacity * 255)
                      .toString(16)
                      .padStart(2, '0')
                : this.background;
        context.fillRect(x, y, width, height);
    }

    draw(
        canvas: HTMLCanvasElement,
        width: number,
        height: number,
        fontSize: number,
        fontFamily: string,
        focused: boolean,
        cursorPosition?: { row: number; column: number },
        lineHeight = Math.ceil(fontSize * 1.65)
    ): { cellWidth: number; cellHeight: number } {
        const translucent = this.backgroundOpacity < 1;
        const ctx = canvas.getContext('2d', { alpha: translucent })!;
        const dpr = window.devicePixelRatio || 1;
        if (
            canvas.width !== Math.round(width * dpr) ||
            canvas.height !== Math.round(height * dpr)
        ) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Cached glyphs are already antialiased; compositing must not blur them again.
        ctx.imageSmoothingEnabled = false;
        const family = fontFamily;
        ctx.font = `${fontSize}px ${family}`;
        const cellWidth = ctx.measureText('M').width;
        const cellHeight = lineHeight;
        const imageStyle = JSON.stringify([
            width,
            dpr,
            fontSize,
            fontFamily,
            cellWidth,
            translucent
        ]);
        if (imageStyle !== this.imageStyle) {
            this.imageStyle = imageStyle;
            this.rowImages = new WeakMap();
        }
        this.cellWidth = cellWidth;
        if (this.layoutDirty || this.cellHeight !== cellHeight) {
            this.rowTops = [0];
            for (let row = 0; row < this.rows; row++) {
                const cells = this.cells[row];
                const compact =
                    row < this.rows - 1 &&
                    cells.some(
                        (cell) => cell.text.trim() && this.highlights.get(cell.highlight)?.codeLens
                    ) &&
                    cells.every(
                        (cell) => !cell.text.trim() || this.highlights.get(cell.highlight)?.codeLens
                    );
                this.rowTops.push(
                    this.rowTops[row] + (compact ? Math.ceil(cellHeight * 0.7) : cellHeight)
                );
            }
            this.layoutDirty = false;
        }
        this.cellHeight = cellHeight;
        this.contentHeight = Math.max(0, (Math.floor(height / cellHeight) - 1) * cellHeight);
        this.extraRows = Math.floor(
            ((this.rows - 1) * cellHeight - this.rowTop(this.rows - 1)) / cellHeight
        );
        if (this.upperRows !== this.upperLayout || this.upperFontHeight !== cellHeight) {
            this.upperTops = [0];
            for (const cells of this.upperRows.slice().reverse()) {
                const compact =
                    cells.some(
                        (cell) => cell.text.trim() && this.highlights.get(cell.highlight)?.codeLens
                    ) &&
                    cells.every(
                        (cell) => !cell.text.trim() || this.highlights.get(cell.highlight)?.codeLens
                    );
                this.upperTops.unshift(
                    this.upperTops[0] - (compact ? Math.ceil(cellHeight * 0.7) : cellHeight)
                );
            }
            this.upperLayout = this.upperRows;
            this.upperFontHeight = cellHeight;
        }
        // Only preview rows whose text and decorations are already available.
        this.scrollPixels = this.pixelScrollEnabled
            ? this.rowTop(
                  Math.max(
                      -this.upperRows.length,
                      Math.min(1, this.scrollFraction + this.scrollPreview)
                  )
              )
            : 0;
        // A wheel gesture can stop between pixels; do not leave filtered text on screen.
        if (!this.scrolling) {
            this.scrollPixels = Math.round(this.scrollPixels * dpr) / dpr;
        }
        this.paintBackground(ctx, 0, 0, width, height);
        ctx.textBaseline = 'alphabetic';
        for (let row = this.scrollPixels < 0 ? -this.upperRows.length : 0; row < this.rows; row++) {
            const cells = row < 0 ? this.upperRows[this.upperRows.length + row] : this.cells[row];
            if (
                row < this.rows - 1 &&
                (this.rowY(row + 1) <= 0 || this.rowY(row) >= this.contentHeight)
            ) {
                continue;
            }
            const rowHeight = this.rowTop(row + 1) - this.rowTop(row);
            // Resting rows at fractional DPI must not inherit scroll interpolation.
            const physicalY =
                this.scrolling && this.scrollPixels !== 0 && row < this.rows - 1
                    ? Math.round(this.rowY(row) * dpr * Grid.rasterPhases) / Grid.rasterPhases
                    : Math.round(this.rowY(row) * dpr);
            const top = Math.floor(physicalY);
            const phase = Math.round((physicalY - top) * Grid.rasterPhases);
            ctx.save();
            if (row < this.rows - 1) {
                ctx.beginPath();
                ctx.rect(0, 0, width, this.contentHeight);
                ctx.clip();
            }
            let images = this.rowImages.get(cells) ?? [];
            let image = images[0];
            const imageHeight = Math.ceil(rowHeight * dpr);
            if (!image || image.height !== imageHeight) {
                images = [];
                this.rowImages.set(cells, images);
                image = canvas.ownerDocument.createElement('canvas');
                image.width = canvas.width;
                image.height = imageHeight;
                images[0] = image;
                // Alpha surfaces use grayscale antialiasing, avoiding colored LCD fringes.
                // Opaque themes still fill the row background before drawing text.
                const ctx = image.getContext('2d', { alpha: true })!;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.textBaseline = 'alphabetic';
                const y = 0;
                if (!translucent) {
                    ctx.fillStyle = this.background;
                    ctx.fillRect(0, 0, width, image.height / dpr);
                }
                // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
                for (let col = 0; col < this.columns; col++) {
                    const h = this.highlights.get(cells[col]?.highlight || 0) || {};
                    const background = cellBackground(h, this.background, this.foreground);
                    // The default background is already filled (or transparent for acrylic).
                    // Repainting fractional cell edges can darken their native pixels.
                    if (background === this.background) {
                        continue;
                    }
                    ctx.fillStyle = background;
                    ctx.fillRect(col * cellWidth, y, cellWidth + 0.5, image.height / dpr);
                }

                for (let col = 0; col < this.columns; col++) {
                    const cell = cells[col];
                    if (!cell?.text || cell.text === ' ') {
                        continue;
                    }

                    const h = this.highlights.get(cell.highlight) || {};
                    if (h.codeLens) {
                        let text = cell.text;
                        const start = col;
                        while (
                            col + 1 < this.columns &&
                            cells[col + 1]?.highlight === cell.highlight
                        ) {
                            text += cells[++col].text;
                        }
                        ctx.font = `${fontSize * 0.8}px ${family}`;
                        ctx.fillStyle = cellForeground(h, this.background, this.foreground);
                        ctx.fillText(
                            text,
                            Math.round(start * cellWidth * dpr) / dpr,
                            Math.round((y + (rowHeight + fontSize * 0.8) / 2 - 3) * dpr) / dpr
                        );
                        continue;
                    }
                    ctx.font = `${h.italic ? 'italic ' : ''}${h.bold ? 'bold ' : ''}${fontSize}px ${family}`;
                    ctx.fillStyle = cellForeground(h, this.background, this.foreground);

                    const x = col * cellWidth;

                    if (h.indentGuide) {
                        // Use the same physical-pixel boundary as bracket pair guides.
                        ctx.fillRect(
                            Math.round(x * dpr) / dpr - 1 / dpr,
                            y,
                            1 / dpr,
                            image.height / dpr
                        );
                    } else if (cell.text === '│') {
                        // Box-drawing lines must span the cell, including the line spacing.
                        ctx.fillRect(Math.round(x + cellWidth / 2), y, 1, rowHeight);
                    } else {
                        // Keep glyph origins on physical pixels, including fractional Windows scaling.
                        ctx.fillText(
                            cell.text,
                            Math.round(x * dpr) / dpr,
                            Math.round((y + (rowHeight + fontSize) / 2 - 3) * dpr) / dpr
                        );
                    }
                    if (h.underline || h.undercurl || h.strikethrough) {
                        if (h.special !== undefined) {
                            ctx.fillStyle = color(h.special);
                        }
                        ctx.fillRect(
                            x,
                            y + (h.strikethrough ? rowHeight / 2 : rowHeight - 3),
                            cellWidth,
                            1
                        );
                    }
                }
            }
            if (phase) {
                let shifted = images[phase];
                if (!shifted) {
                    shifted = canvas.ownerDocument.createElement('canvas');
                    shifted.width = image.width;
                    shifted.height = image.height + 1;
                    const shiftedContext = shifted.getContext('2d', { alpha: translucent })!;
                    if (!translucent) {
                        shiftedContext.fillStyle = this.background;
                        shiftedContext.fillRect(0, 0, shifted.width, shifted.height);
                    }
                    // Interpolate the native bitmap once per phase, then reuse its physical pixels.
                    shiftedContext.imageSmoothingEnabled = true;
                    shiftedContext.imageSmoothingQuality = 'low';
                    shiftedContext.drawImage(image, 0, phase / Grid.rasterPhases);
                    images[phase] = shifted;
                }
                image = shifted;
            }
            // Reuse rasterized text; scroll and cursor animation only composite row images.
            ctx.drawImage(image, 0, top / dpr, image.width / dpr, image.height / dpr);
            ctx.restore();
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, this.contentHeight);
        ctx.clip();
        for (const guide of this.bracketGuides) {
            const snap = (value: number): number => Math.round(value * dpr) / dpr;
            // Keep the vertical stroke outside the bracket's cell, including at fractional DPI.
            const x = snap(guide.column * cellWidth) - 1 / dpr;
            const top =
                guide.opening >= 0 ? this.rowY(guide.top + 1) - 1 / dpr : this.rowY(guide.top);
            const bottom =
                guide.closing >= 0
                    ? this.rowY(guide.bottom + 1) - 1 / dpr
                    : this.rowY(guide.bottom);
            ctx.fillStyle = guide.color;
            ctx.globalAlpha = guide.active ? 0.9 : 0.3;
            ctx.fillRect(x, top, 1 / dpr, bottom - top);
            if (guide.active) {
                for (const [column, y] of [
                    [guide.opening, top],
                    [guide.closing, bottom]
                ]) {
                    if (column >= 0) {
                        ctx.fillRect(
                            x,
                            y,
                            Math.max(1 / dpr, snap((column + 1) * cellWidth) - x),
                            1 / dpr
                        );
                    }
                }
            }
        }
        ctx.restore();
        const cursor = this.scrollCursor ?? this.cursor;
        ctx.save();
        if (cursor.row < this.rows - 1) {
            ctx.beginPath();
            ctx.rect(0, 0, width, this.contentHeight);
            ctx.clip();
        }
        if (
            focused &&
            !this.busy &&
            /^(normal|insert|replace|visual)/.test(this.mode) &&
            cursor.row >= 0 &&
            cursor.row < this.rows
        ) {
            const y = this.rowY(cursor.row);
            ctx.fillStyle = '#46515c';
            ctx.fillRect(0, y, width, 1);
            ctx.fillRect(0, y + cellHeight - 1, width, 1);
        }
        this.drawCursor(ctx, cellWidth, cellHeight, focused, cursorPosition);
        ctx.restore();
        return { cellWidth, cellHeight };
    }

    private drawCursor(
        ctx: CanvasRenderingContext2D,
        cellWidth: number,
        cellHeight: number,
        focused: boolean,
        position?: { row: number; column: number }
    ): void {
        const cursor = position ?? this.scrollCursor ?? this.cursor;
        if (
            !this.busy &&
            cursor.row >= 0 &&
            cursor.row < this.rows &&
            (!focused || this.cursorVisible)
        ) {
            const x = cursor.column * cellWidth;
            const y = this.rowY(cursor.row);
            ctx.fillStyle = '#f5f5f5';
            ctx.strokeStyle = '#d4d4d4';
            ctx.globalAlpha = focused ? this.cursorOpacity : 1;
            if (!focused) {
                ctx.strokeRect(x + 0.5, y + 1, cellWidth - 1, cellHeight - 2);
            } else if (this.mode.startsWith('insert')) {
                ctx.fillRect(x, y + 1, 2, cellHeight - 2);
            } else {
                ctx.globalAlpha *= 0.7;
                ctx.fillRect(x, y + 1, cellWidth, cellHeight - 2);
            }
            ctx.globalAlpha = 1;
        }
    }
}

export function isAltGraph(event: Partial<Pick<KeyboardEvent, 'getModifierState'>>): boolean {
    return event.getModifierState?.('AltGraph') === true;
}

export function vimKey(
    event: Pick<
        KeyboardEvent,
        'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'
    > &
        Partial<Pick<KeyboardEvent, 'getModifierState'>>
): string | null {
    if (
        event.isComposing ||
        ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(
            event.key
        )
    ) {
        return null;
    }

    const special: Record<string, string> = {
        Escape: 'Esc',
        Enter: 'CR',
        Backspace: 'BS',
        Delete: 'Del',
        Tab: 'Tab',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        Insert: 'Insert'
    };

    const altGraph = isAltGraph(event);
    const ctrlKey = event.ctrlKey && !altGraph;
    const altKey = event.altKey && !altGraph;
    let key = special[event.key] || event.key;
    if (/^F\d+$/.test(key) || special[event.key] || ctrlKey || altKey || event.metaKey) {
        if (key === ' ') {
            key = 'Space';
        }
        const modifiers =
            (ctrlKey ? 'C-' : '') +
            (altKey ? 'M-' : '') +
            (event.metaKey ? 'D-' : '') +
            (event.shiftKey && (special[event.key] || /^F\d+$/.test(event.key) || ctrlKey || altKey)
                ? 'S-'
                : '');
        return `<${modifiers}${key}>`;
    }
    return key === '<' ? '<LT>' : key;
}
