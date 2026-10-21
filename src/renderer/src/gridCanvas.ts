import type { Grid } from './grid';
import type { Cell, Highlight } from './gridTypes';
import { color } from './gridColors';
import { LinearRowImages } from './linearRowImage';

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
    if (h.wordHighlight && h.background === 0xffffff) {
        return (
            '#ffffff' +
            Math.round(255 * (1 - (h.blend ?? 88) / 100))
                .toString(16)
                .padStart(2, '0')
        );
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

/** Paint grid snapshots, reusing rasterized row images until their content changes. */
export class GridCanvas {
    private rowImages = new WeakMap<Cell[], HTMLCanvasElement>();
    private dirtyImages = new WeakSet<HTMLCanvasElement>();
    private linearRows?: LinearRowImages;
    private imageStyle = '';
    private paintDirty = true;
    private surface?: HTMLCanvasElement;
    private scrolling = false;
    private previousCursor?: { top: number; bottom: number };
    private firstDirtyRow = Infinity;
    private lastDirtyRow = -Infinity;

    constructor(private readonly grid: Grid) {}

    invalidate(row?: number): void {
        if (row !== undefined) {
            const cells = this.grid.cells[row];
            const image = this.rowImages.get(cells);
            if (image) {
                this.linearRows?.invalidate(image);
                this.dirtyImages.add(image);
            }
            this.firstDirtyRow = Math.min(this.firstDirtyRow, row);
            this.lastDirtyRow = Math.max(this.lastDirtyRow, row);
        } else {
            this.invalidatePaint();
            this.rowImages = new WeakMap();
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
        const family = fontFamily;
        ctx.font = `${fontWeight} ${fontSize}px ${family}`;
        const cellWidth = ctx.measureText('M').width;
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
        const cursorTop = Math.min(this.grid.rowY(target.row), this.grid.rowY(position.row));
        const cursorBottom =
            Math.max(this.grid.rowY(target.row), this.grid.rowY(position.row)) + cellHeight;
        let damageTop = Math.min(cursorTop, this.previousCursor?.top ?? cursorTop);
        let damageBottom = Math.max(cursorBottom, this.previousCursor?.bottom ?? cursorBottom);
        if (this.firstDirtyRow !== Infinity) {
            damageTop = Math.min(damageTop, this.grid.rowY(this.firstDirtyRow));
            damageBottom = Math.max(damageBottom, this.grid.rowY(this.lastDirtyRow) + cellHeight);
        }
        // Include changed rows and cursor motion, snapping the clip to physical pixels
        // so acrylic and fractional DPI match a complete repaint.
        const paintTop = this.paintDirty
            ? 0
            : Math.max(0, Math.floor((damageTop - 1 / dpr) * dpr) / dpr);
        const paintBottom = this.paintDirty
            ? canvas.height / dpr
            : Math.min(canvas.height / dpr, Math.ceil((damageBottom + 1 / dpr) * dpr) / dpr);
        this.previousCursor = { top: cursorTop, bottom: cursorBottom };
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, paintTop, canvas.width / dpr, Math.max(0, paintBottom - paintTop));
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
        for (
            let row = this.grid.scrollOffset < 0 ? -this.grid.historyRows.length : 0;
            row < this.grid.rows + (this.grid.scrollOffset > 0 ? this.grid.futureRows.length : 0);
            row++
        ) {
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
            if (rowY + rowHeight + 1 / dpr < paintTop || rowY > paintBottom) {
                continue;
            }
            if (!commandLine && (rowY + rowHeight <= 0 || rowY >= this.grid.contentHeight)) {
                continue;
            }
            // Snap document origins, not scroll movement. All rows share the same
            // fractional translation, including across native viewport rebases.
            const origin = this.grid.scrollOrigin;
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
            if (this.dirtyImages.has(image)) {
                this.dirtyImages.delete(image);
                // Opaque rows allow native LCD text, matching normal DOM rendering.
                // Translucent themes need alpha surfaces and grayscale antialiasing.
                const ctx = image.getContext('2d', { alpha: translucent })!;
                if (translucent) {
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.clearRect(0, 0, image.width, image.height);
                }
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.textBaseline = 'alphabetic';
                // This row owns its context and never saves/restores text state.
                let currentFont = '';
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
                const y = 0;
                const highlightTop = Math.max(
                    0,
                    Math.round(((rowHeight - fontSize - 2) / 2) * dpr)
                );
                const highlightHeight = Math.min(
                    imageHeight - highlightTop,
                    Math.round((fontSize + 2) * dpr)
                );
                if (!translucent) {
                    foreground(this.grid.background);
                    ctx.fillRect(0, 0, width, image.height / dpr);
                }
                // Paint all cell backgrounds first so a wide glyph is not erased by its continuation cell.
                for (let col = 0; col < this.grid.columns; col++) {
                    const h = this.grid.highlights.get(cells[col]?.highlight || 0) || {};
                    const background = cellBackground(
                        h,
                        this.grid.background,
                        this.grid.foreground
                    );
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
                        const accent = color(h.special ?? h.foreground ?? 0xcccccc);
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

                for (let col = 0; col < this.grid.columns; col++) {
                    const cell = cells[col];
                    if (!cell?.text || cell.text === ' ') {
                        continue;
                    }

                    const h = this.grid.highlights.get(cell.highlight) || {};
                    if (h.codeLens) {
                        let text = cell.text;
                        const start = col;
                        while (
                            col + 1 < this.grid.columns &&
                            cells[col + 1]?.highlight === cell.highlight
                        ) {
                            text += cells[++col].text;
                        }
                        font(`${fontWeight} ${fontSize * 0.8}px ${family}`);
                        foreground(cellForeground(h, this.grid.background, this.grid.foreground));
                        ctx.fillText(
                            text,
                            Math.round(start * cellWidth * dpr) / dpr,
                            Math.round((y + (rowHeight + fontSize * 0.8) / 2 - 3) * dpr) / dpr
                        );
                        continue;
                    }
                    const textSize = h.diagnostic ? fontSize * 0.9 : fontSize;
                    font(
                        `${h.italic ? 'italic ' : ''}${h.bold ? Math.max(700, fontWeight) : fontWeight} ${textSize}px ${family}`
                    );
                    foreground(cellForeground(h, this.grid.background, this.grid.foreground));

                    const x = col * cellWidth;
                    const baseline = Math.round((y + (rowHeight + textSize) / 2 - 3) * dpr) / dpr;

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
                        ctx.fillText(cell.text, Math.round(x * dpr) / dpr, baseline);
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
                        if (h.special !== undefined) {
                            foreground(color(h.special));
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
        for (const guide of this.grid.bracketGuides) {
            const snap = (value: number): number => Math.round(value * dpr) / dpr;
            // Keep the vertical stroke outside the bracket's cell, including at fractional DPI.
            const x = snap(guide.column * cellWidth) - 1 / dpr;
            const top =
                guide.opening >= 0
                    ? this.grid.rowY(guide.top + 1) - 1 / dpr
                    : this.grid.rowY(guide.top);
            const bottom =
                guide.closing >= 0
                    ? this.grid.rowY(guide.bottom + 1) - 1 / dpr
                    : this.grid.rowY(guide.bottom);
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
        const cursor = this.grid.scrollCursor ?? this.grid.cursor;
        ctx.save();
        if (cursor.row < this.grid.rows - 1) {
            ctx.beginPath();
            ctx.rect(0, 0, width, this.grid.contentHeight);
            ctx.clip();
        }
        if (
            focused &&
            !this.grid.busy &&
            /^(normal|insert|replace|visual)/.test(this.grid.mode) &&
            cursor.row >= 0 &&
            cursor.row < this.grid.rows
        ) {
            const y = this.grid.rowY(cursor.row);
            ctx.fillStyle = '#46515c';
            ctx.fillRect(0, y, width, 1);
            ctx.fillRect(0, y + cellHeight - 1, width, 1);
        }
        this.drawCursor(ctx, cellWidth, cellHeight, focused, cursorPosition);
        ctx.restore();
        ctx.restore();
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
