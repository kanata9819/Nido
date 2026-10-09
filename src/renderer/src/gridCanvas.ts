import type { Grid } from './grid';
import type { Cell, Highlight } from './gridTypes';
import { color } from './gridColors';

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

/** Paint grid snapshots, reusing rasterized row images until their content changes. */
export class GridCanvas {
    private static readonly rasterPhases = 4;
    private rowImages = new WeakMap<Cell[], HTMLCanvasElement[]>();
    private imageStyle = '';
    private paintDirty = true;
    private surface?: HTMLCanvasElement;
    private scrolling = false;
    private previousCursor?: { top: number; bottom: number };

    constructor(private readonly grid: Grid) {}

    invalidate(row?: Cell[]): void {
        this.invalidatePaint();
        if (row) {
            this.rowImages.delete(row);
        } else {
            this.rowImages = new WeakMap();
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
        cursorPosition?: { row: number; column: number },
        lineHeight = Math.ceil(fontSize * 1.65)
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
        this.grid.prepareLayout(height, cellWidth, cellHeight, dpr);
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
        // Cursor motion and blinking only damage their old and new rows. Snap the clip
        // to physical pixels so acrylic and fractional DPI match a complete repaint.
        const paintTop = this.paintDirty
            ? 0
            : Math.max(
                  0,
                  Math.floor(
                      (Math.min(cursorTop, this.previousCursor?.top ?? cursorTop) - 1 / dpr) * dpr
                  ) / dpr
              );
        const paintBottom = this.paintDirty
            ? canvas.height / dpr
            : Math.min(
                  canvas.height / dpr,
                  Math.ceil(
                      (Math.max(cursorBottom, this.previousCursor?.bottom ?? cursorBottom) +
                          1 / dpr) *
                          dpr
                  ) / dpr
              );
        this.previousCursor = { top: cursorTop, bottom: cursorBottom };
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, paintTop, canvas.width / dpr, Math.max(0, paintBottom - paintTop));
        ctx.clip();
        this.paintBackground(ctx, 0, 0, width, height);
        ctx.textBaseline = 'alphabetic';
        for (
            let row = this.grid.scrollOffset < 0 ? -this.grid.historyRows.length : 0;
            row < this.grid.rows;
            row++
        ) {
            const cells =
                row < 0
                    ? this.grid.historyRows[this.grid.historyRows.length + row]
                    : this.grid.cells[row];
            const rowY = this.grid.rowY(row);
            const rowHeight = this.grid.rowTop(row + 1) - this.grid.rowTop(row);
            if (rowY + rowHeight + 1 / dpr < paintTop || rowY > paintBottom) {
                continue;
            }
            if (
                row < this.grid.rows - 1 &&
                (this.grid.rowY(row + 1) <= 0 || this.grid.rowY(row) >= this.grid.contentHeight)
            ) {
                continue;
            }
            // Resting rows at fractional DPI must not inherit scroll interpolation.
            const physicalY =
                this.grid.scrolling && this.grid.scrollOffset !== 0 && row < this.grid.rows - 1
                    ? Math.round(this.grid.rowY(row) * dpr * GridCanvas.rasterPhases) /
                      GridCanvas.rasterPhases
                    : Math.round(this.grid.rowY(row) * dpr);
            const top = Math.floor(physicalY);
            const phase = Math.round((physicalY - top) * GridCanvas.rasterPhases);
            ctx.save();
            if (row < this.grid.rows - 1) {
                ctx.beginPath();
                ctx.rect(0, 0, width, this.grid.contentHeight);
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
                    ctx.fillStyle = this.grid.background;
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
                    // The default background is already filled (or transparent for acrylic).
                    // Repainting fractional cell edges can darken their native pixels.
                    if (background === this.grid.background) {
                        continue;
                    }
                    ctx.fillStyle = background;
                    ctx.fillRect(col * cellWidth, y, cellWidth + 0.5, image.height / dpr);
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
                        ctx.font = `${fontSize * 0.8}px ${family}`;
                        ctx.fillStyle = cellForeground(
                            h,
                            this.grid.background,
                            this.grid.foreground
                        );
                        ctx.fillText(
                            text,
                            Math.round(start * cellWidth * dpr) / dpr,
                            Math.round((y + (rowHeight + fontSize * 0.8) / 2 - 3) * dpr) / dpr
                        );
                        continue;
                    }
                    ctx.font = `${h.italic ? 'italic ' : ''}${h.bold ? 'bold ' : ''}${fontSize}px ${family}`;
                    ctx.fillStyle = cellForeground(h, this.grid.background, this.grid.foreground);

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
                        shiftedContext.fillStyle = this.grid.background;
                        shiftedContext.fillRect(0, 0, shifted.width, shifted.height);
                    }
                    // Interpolate the native bitmap once per phase, then reuse its physical pixels.
                    shiftedContext.imageSmoothingEnabled = true;
                    shiftedContext.imageSmoothingQuality = 'low';
                    shiftedContext.drawImage(image, 0, phase / GridCanvas.rasterPhases);
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
        return { cellWidth, cellHeight };
    }

    private drawCursor(
        ctx: CanvasRenderingContext2D,
        cellWidth: number,
        cellHeight: number,
        focused: boolean,
        position?: { row: number; column: number }
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
            ctx.fillStyle = '#f5f5f5';
            ctx.strokeStyle = '#d4d4d4';
            ctx.globalAlpha = focused ? this.grid.cursorOpacity : 1;
            if (!focused) {
                ctx.strokeRect(x + 0.5, y + 1, cellWidth - 1, cellHeight - 2);
            } else if (this.grid.mode.startsWith('insert')) {
                ctx.fillRect(x, y + 1, 2, cellHeight - 2);
            } else {
                ctx.globalAlpha *= 0.7;
                ctx.fillRect(x, y + 1, cellWidth, cellHeight - 2);
            }
            ctx.globalAlpha = 1;
        }
    }
}
