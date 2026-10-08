import type { Grid } from './grid';
import { scrollOffset } from './scroll';

export interface FrameMotion {
    top: number;
    bottom: number;
    left: number;
    right: number;
    distance: number;
    distanceX: number;
    incomingRows: number;
    start: number;
    edit: boolean;
}

interface Options {
    motion?: FrameMotion;
    grid: Grid;
    surface: HTMLCanvasElement;
    previousFrame: HTMLCanvasElement;
    targetFrame: HTMLCanvasElement;
    cellWidth: number;
    dpr: number;
    animate: boolean;
    backgroundOpacity: number;
}

/** Composite old and incoming frame regions for scroll and deletion transitions. */
export function paintEditorMotion({
    motion,
    grid,
    surface,
    previousFrame,
    targetFrame,
    cellWidth,
    dpr,
    animate,
    backgroundOpacity
}: Options): { motion?: FrameMotion; overlayOffset: number } {
    let overlayOffset = 0;

    if (motion) {
        if (motion.incomingRows) {
            const height = grid.rowTop(motion.bottom) - grid.rowTop(motion.top);
            const distance =
                grid.rowTop(motion.top) - grid.rowTop(motion.top + motion.incomingRows);
            motion.distance = Math.max(-height, Math.min(height, distance + motion.distance));
            motion.incomingRows = 0;
        }
        const elapsed = (performance.now() - motion.start) * (motion.edit ? 120 / 90 : 1);
        const offset = scrollOffset(motion.distance, elapsed);
        const offsetX = scrollOffset(motion.distanceX, elapsed);
        if (
            (Math.abs(offset) < 0.25 && Math.abs(offsetX) < 0.25) ||
            !animate ||
            previousFrame.width !== surface.width ||
            previousFrame.height !== surface.height
        ) {
            motion = undefined;
        } else {
            const snap = (value: number): number => Math.round(value * dpr) / dpr;
            overlayOffset = snap(offset);
            if (targetFrame.width !== surface.width || targetFrame.height !== surface.height) {
                targetFrame.width = surface.width;
                targetFrame.height = surface.height;
            }
            const targetContext = targetFrame.getContext('2d')!;
            targetContext.globalCompositeOperation = 'copy';
            targetContext.drawImage(surface, 0, 0);
            const ctx = surface.getContext('2d')!;
            const top = snap(grid.rowY(motion.top));
            const bottom = snap(
                Math.min(
                    grid.contentHeight,
                    grid.rowY(motion.top) + grid.rowTop(motion.bottom) - grid.rowTop(motion.top)
                )
            );
            const height = bottom - top;
            const left = snap(motion.left * cellWidth);
            const width = snap(motion.right * cellWidth) - left;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            grid.paintBackground(ctx, left, top, width, height);
            // Deleted rows disappear; the remaining rows slide into the gap without an old-frame overlay.
            const layers = [
                ...(motion.edit
                    ? []
                    : [
                          [
                              previousFrame,
                              offset - motion.distance,
                              offsetX - motion.distanceX
                          ] as const
                      ]),
                [targetFrame, offset, offsetX]
            ] as const;
            for (const [image, shift, shiftX] of layers) {
                const destinationLeft = left + snap(shiftX);
                const destinationTop = top + snap(shift);
                ctx.save();
                if (backgroundOpacity < 1) {
                    // Copy only this layer's destination; translucent overlap must not double text or tint.
                    ctx.beginPath();
                    ctx.rect(destinationLeft, destinationTop, width, height);
                    ctx.clip();
                    ctx.globalCompositeOperation = 'copy';
                }
                ctx.drawImage(
                    image,
                    left * dpr,
                    top * dpr,
                    width * dpr,
                    height * dpr,
                    destinationLeft,
                    destinationTop,
                    width,
                    height
                );
                ctx.restore();
            }
            ctx.restore();
        }
    }

    return { motion, overlayOffset };
}
