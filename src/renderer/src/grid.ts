import type { Redraw } from '../../shared/types';
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
    cells: Cell[][] = [];
    highlights = new Map<number, Highlight>();
    columns = 0;
    rows = 0;
    cursor = { row: 0, column: 0 };
    scrollCursor?: { row: number; column: number };
    foreground = '#d6dce2';
    background = '#191e23';
    mode = 'normal';
    busy = false;
    cursorVisible = true;
    cursorOpacity = 1;
    pixelScrollEnabled = false;
    scrollFraction = 0;
    scrollPreview = 0;
    cellWidth = 0;
    cellHeight = 0;
    contentHeight = 0;
    extraRows = 0;
    bracketGuides: BracketGuide[] = [];
    private rowTops: number[] = [];
    private layoutDirty = true;
    private scrollPixels = 0;
    private rowImages = new WeakMap<Cell[], HTMLCanvasElement>();
    private imageStyle = '';
    private upperRows: Cell[][] = [];
    private upperTops: number[] = [0];
    private upperLayout?: Cell[][];
    private upperFontHeight = 0;

    get hasUpperRows(): boolean {
        return this.upperRows.length > 0;
    }

    get needsUpperRows(): boolean {
        // Refill while half of the eight-row cache still covers incoming wheel events.
        return this.upperRows.length <= 4;
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
        if (y < 0 || y >= this.contentHeight) return -1;
        if (y + this.scrollPixels < 0) return -1;
        let row = 0;
        while (row < this.rows - 1 && this.rowTop(row + 1) <= y + this.scrollPixels) row++;
        return row < this.rows - 1 ? row : -1;
    }

    apply(events: Redraw): boolean {
        if (
            events.some(
                ([name]) => name === 'nido_edit' || name === 'grid_clear' || name === 'grid_resize'
            )
        ) {
            this.upperRows = [];
        }
        let flush = false;
        const viewportScroll = events.some(([name]) => name === 'nido_scroll');
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
                // Viewport metadata also covers redraws where changing relative numbers prevents grid_scroll.
                if (name === 'nido_scroll' || (name === 'grid_scroll' && !viewportScroll)) {
                    const [grid, top, bottom, left, right, rows, columns] = args as number[];
                    if (
                        grid === 1 &&
                        top === 0 &&
                        left === 0 &&
                        right === this.columns &&
                        columns === 0
                    ) {
                        this.upperRows =
                            Math.abs(rows) >= bottom - top
                                ? []
                                : rows > 0
                                  ? [...this.upperRows, ...this.cells.slice(0, rows)].slice(-8)
                                  : this.upperRows.slice(
                                        0,
                                        Math.max(0, this.upperRows.length + rows)
                                    );
                    } else {
                        this.upperRows = [];
                    }
                }
                switch (name) {
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
                        if (row && this.upperRows.includes(row)) {
                            row = this.cells[Number(args[1])] = row.slice();
                        }
                        if (row) this.rowImages.delete(row);
                        let column = Number(args[2]);
                        let highlight = 0;
                        for (const cell of args[3] as [string, number?, number?][]) {
                            if (cell[1] !== undefined) {
                                highlight = cell[1];
                            }
                            for (let i = 0; i < (cell[2] ?? 1); i++) {
                                if (row && column < this.columns) {
                                    row[column] = { text: cell[0], highlight };
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
        return flush;
    }

    draw(
        canvas: HTMLCanvasElement,
        width: number,
        height: number,
        fontSize: number,
        fontFamily: string,
        focused: boolean,
        cursorPosition?: { row: number; column: number }
    ): { cellWidth: number; cellHeight: number } {
        // The grid paints its entire background; no transparent surface is needed.
        const ctx = canvas.getContext('2d', { alpha: false })!;
        const dpr = window.devicePixelRatio || 1;
        if (
            canvas.width !== Math.round(width * dpr) ||
            canvas.height !== Math.round(height * dpr)
        ) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const family = fontFamily;
        ctx.font = `${fontSize}px ${family}`;
        const cellWidth = ctx.measureText('M').width;
        const cellHeight = Math.ceil(fontSize * 1.65);
        const imageStyle = JSON.stringify([width, dpr, fontSize, fontFamily, cellWidth]);
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
        // ponytail: preview at most eight upper rows; deeper speculation needs a larger cache.
        this.scrollPixels = this.pixelScrollEnabled
            ? this.rowTop(
                  Math.max(
                      -this.upperRows.length,
                      Math.min(1, this.scrollFraction + this.scrollPreview)
                  )
              )
            : 0;
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, width, height);
        ctx.textBaseline = 'alphabetic';
        for (let row = this.scrollPixels < 0 ? -this.upperRows.length : 0; row < this.rows; row++) {
            const cells = row < 0 ? this.upperRows[this.upperRows.length + row] : this.cells[row];
            if (row < 0 && this.rowY(row + 1) <= 0) continue;
            const rowHeight = this.rowTop(row + 1) - this.rowTop(row);
            ctx.save();
            if (row < this.rows - 1) {
                ctx.beginPath();
                ctx.rect(0, 0, width, this.contentHeight);
                ctx.clip();
            }
            let image = this.rowImages.get(cells);
            if (!image || image.height !== Math.ceil(rowHeight * dpr)) {
                image = canvas.ownerDocument.createElement('canvas');
                image.width = canvas.width;
                image.height = Math.ceil(rowHeight * dpr);
                this.rowImages.set(cells, image);
                const ctx = image.getContext('2d', { alpha: false })!;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.textBaseline = 'alphabetic';
                const y = 0;
                ctx.fillStyle = this.background;
                ctx.fillRect(0, 0, width, image.height / dpr);
                // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
                for (let col = 0; col < this.columns; col++) {
                    const h = this.highlights.get(cells[col]?.highlight || 0) || {};
                    ctx.fillStyle = cellBackground(h, this.background, this.foreground);

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
            // Reuse rasterized text; scroll and cursor animation only composite row images.
            ctx.drawImage(image, 0, this.rowY(row), image.width / dpr, image.height / dpr);
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
                    if (column >= 0)
                        ctx.fillRect(
                            x,
                            y,
                            Math.max(1 / dpr, snap((column + 1) * cellWidth) - x),
                            1 / dpr
                        );
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

export function vimKey(
    event: Pick<
        KeyboardEvent,
        'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'
    >
): string | null {
    if (
        event.isComposing ||
        ['Shift', 'Control', 'Alt', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(event.key)
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

    let key = special[event.key] || event.key;
    if (
        /^F\d+$/.test(key) ||
        special[event.key] ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
    ) {
        if (key === ' ') {
            key = 'Space';
        }
        const modifiers =
            (event.ctrlKey ? 'C-' : '') +
            (event.altKey ? 'M-' : '') +
            (event.metaKey ? 'D-' : '') +
            (event.shiftKey &&
            (special[event.key] || /^F\d+$/.test(event.key) || event.ctrlKey || event.altKey)
                ? 'S-'
                : '');
        return `<${modifiers}${key}>`;
    }
    return key === '<' ? '<LT>' : key;
}
