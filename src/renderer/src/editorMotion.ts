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
  duration: number;
  targetReady?: boolean;
  offsetX?: number;
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
  reuseTarget?: boolean;
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
  backgroundOpacity,
  reuseTarget = false
}: Options): { motion?: FrameMotion; overlayOffset: number; horizontalOffset: number } {
  let overlayOffset = 0;
  let horizontalOffset = 0;

  if (motion) {
    if (motion.incomingRows) {
      const height = grid.rowTop(motion.bottom) - grid.rowTop(motion.top);
      const distance = grid.rowTop(motion.top) - grid.rowTop(motion.top + motion.incomingRows);
      motion.distance = Math.max(-height, Math.min(height, distance + motion.distance));
      motion.incomingRows = 0;
    }
    const elapsed = performance.now() - motion.start;
    const offset = scrollOffset(motion.distance, elapsed, motion.duration);
    const direct = motion.offsetX !== undefined;
    const offsetX = direct
      ? Math.max(
          Math.min(0, motion.distanceX),
          Math.min(Math.max(0, motion.distanceX), motion.offsetX ?? 0)
        )
      : scrollOffset(motion.distanceX, elapsed, motion.duration);
    if (
      (Math.abs(offset) < 0.25 && Math.abs(offsetX) < (direct ? 1e-8 : 0.25)) ||
      (!animate && !direct) ||
      previousFrame.width !== surface.width ||
      previousFrame.height !== surface.height
    ) {
      if (reuseTarget) {
        const context = surface.getContext('2d')!;
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = 'copy';
        context.drawImage(targetFrame, 0, 0);
        context.restore();
      }
      motion = undefined;
    } else {
      const snap = (value: number): number => Math.round(value * dpr) / dpr;
      overlayOffset = snap(offset);
      horizontalOffset = snap(offsetX);
      if (targetFrame.width !== surface.width || targetFrame.height !== surface.height) {
        targetFrame.width = surface.width;
        targetFrame.height = surface.height;
      }
      if (!reuseTarget) {
        const targetContext = targetFrame.getContext('2d')!;
        targetContext.globalCompositeOperation = 'copy';
        targetContext.drawImage(surface, 0, 0);
        motion.targetReady = true;
      }
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
          : [[previousFrame, offset - motion.distance, offsetX - motion.distanceX] as const]),
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
      grid.invalidatePaint();
    }
  }

  return { motion, overlayOffset, horizontalOffset };
}
