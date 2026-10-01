import type { Redraw } from '../../shared/types';
import { color } from './gridColors';

export interface Cell {
    text: string;
    highlight: number;
}

interface Highlight {
    codeLens?: boolean;
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
    cellWidth = 0;
    cellHeight = 0;
    contentHeight = 0;
    extraRows = 0;
    private rowTops: number[] = [];
    private layoutDirty = true;
    private scrollPixels = 0;

    rowTop(row: number): number {
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
        let row = 0;
        while (row < this.rows - 1 && this.rowTop(row + 1) <= y + this.scrollPixels) row++;
        return row < this.rows - 1 ? row : -1;
    }

    apply(events: Redraw): boolean {
        let flush = false;
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
                switch (name) {
                    case 'grid_resize': {
                        if (args[0] !== 1) {
                            break;
                        }
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
                        const row = this.cells[Number(args[1])];
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
                        const [, top, bottom, left, right, rows, columns] = args as number[];
                        const old = this.cells.map((row) => row.slice());
                        for (let row = top; row < bottom; row++) {
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
                        const info = args[3] as { hi_name?: string }[] | undefined;
                        this.highlights.set(Number(args[0]), {
                            ...(args[1] as Highlight),
                            codeLens: info?.some(
                                (item) =>
                                    item.hi_name === 'NidoCodeLens' ||
                                    item.hi_name === 'NidoCodeLensHint'
                            )
                        });
                        break;
                    }
                    case 'default_colors_set': {
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
        if (flush) this.layoutDirty = true;
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
        this.scrollPixels = this.pixelScrollEnabled
            ? Math.round(this.rowTop(this.scrollFraction) * dpr) / dpr
            : 0;
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, width, height);
        ctx.textBaseline = 'alphabetic';
        for (let row = 0; row < this.rows; row++) {
            const y = this.rowY(row);
            const rowHeight = this.rowTop(row + 1) - this.rowTop(row);
            ctx.save();
            if (row < this.rows - 1) {
                ctx.beginPath();
                ctx.rect(0, 0, width, this.contentHeight);
                ctx.clip();
            }
            // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
            for (let col = 0; col < this.columns; col++) {
                const h = this.highlights.get(this.cells[row]?.[col]?.highlight || 0) || {};
                ctx.fillStyle = cellBackground(h, this.background, this.foreground);

                ctx.fillRect(col * cellWidth, y, cellWidth + 0.5, rowHeight);
            }

            for (let col = 0; col < this.columns; col++) {
                const cell = this.cells[row]?.[col];
                if (!cell?.text || cell.text === ' ') {
                    continue;
                }

                const h = this.highlights.get(cell.highlight) || {};
                if (h.codeLens) {
                    let text = cell.text;
                    const start = col;
                    while (
                        col + 1 < this.columns &&
                        this.cells[row]?.[col + 1]?.highlight === cell.highlight
                    ) {
                        text += this.cells[row][++col].text;
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

                if (cell.text === '│') {
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
            ctx.restore();
        }
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
