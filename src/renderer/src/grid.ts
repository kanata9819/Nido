import type { Redraw, StickyScrollState } from '../../shared/types';
import { color } from './gridColors';

import type { Cell, Highlight, BracketGuide } from './gridTypes';
import { GridCanvas } from './gridCanvas';
export type { Cell } from './gridTypes';

export class Grid {
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
    private readonly canvas = new GridCanvas(this);
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
                                            this.canvas.invalidate(row);
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
                            this.canvas.invalidate(this.cells[row]);
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
                        this.canvas.invalidate();
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
                        this.canvas.invalidate();
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
        this.canvas.paintBackground(context, x, y, width, height);
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
        return this.canvas.draw(
            canvas,
            width,
            height,
            fontSize,
            fontFamily,
            focused,
            cursorPosition,
            lineHeight
        );
    }

    /** Compute shared row geometry before painting or hit-testing. */
    prepareLayout(height: number, cellWidth: number, cellHeight: number, dpr: number): void {
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
    }

    get historyRows(): readonly Cell[][] {
        return this.upperRows;
    }

    get scrollOffset(): number {
        return this.scrollPixels;
    }
}
