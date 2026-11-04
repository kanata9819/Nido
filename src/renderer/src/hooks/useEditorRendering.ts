import { onNidoEvent } from '../nidoEvents';
import { useEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../grid';
import { scrollOffset } from '../scroll';
import { EditorScroll } from '../editorScroll';
import { alignCanvasSurface } from '../canvasSurface';
import { positionEditorInput } from '../editorInputPosition';
import { createEditorResizer } from '../editorResizer';
import { EditorCursor } from '../editorCursor';
import { paintEditorMotion, type FrameMotion } from '../editorMotion';
import {
  editorGridSize,
  horizontalMotion,
  isAnimatableScroll,
  isHorizontalStep,
  scrollMotion,
  summarizeRedraw
} from '../editorRedraw';

interface UseEditorRenderingOptions {
  backgroundOpacity: number;
  animations: boolean;
  smoothCursor: boolean;
  smoothBlink: boolean;
  pixelScroll: boolean;
  id: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  blocked: boolean;
  active: boolean;
  focusTick: number;
  onError: (message: string) => void;
  onReady?: (id: string) => void;
  errorRef: RefObject<(message: string) => void>;
  hostRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  gridRef: RefObject<Grid>;
  attachedRef: RefObject<boolean>;
  paintRef: RefObject<() => void>;
  afterPaintRef: RefObject<(motionOffset: number) => void>;
  scrollRef: RefObject<
    (lines: number, follow: boolean, discrete: boolean, columns?: number) => void
  >;
  scrollCompletionRef: RefObject<Promise<void>>;
  fontFamily: string;
}

export function useEditorRendering({
  backgroundOpacity,
  animations,
  smoothCursor,
  smoothBlink,
  pixelScroll,
  id,
  fontSize,
  fontWeight,
  lineHeight,
  blocked,
  active,
  focusTick,
  onError,
  onReady,
  errorRef,
  hostRef,
  canvasRef,
  inputRef,
  gridRef,
  attachedRef,
  paintRef,
  afterPaintRef,
  scrollRef,
  scrollCompletionRef,
  fontFamily
}: UseEditorRenderingOptions): void {
  const animationsRef = useRef(animations);
  const smoothCursorRef = useRef(smoothCursor);
  const scrollEnabledRef = useRef(active && !blocked);
  useEffect(() => {
    scrollEnabledRef.current = active && !blocked;
    paintRef.current();
  }, [active, blocked, paintRef]);
  useEffect(() => {
    smoothCursorRef.current = smoothCursor;
    paintRef.current();
  }, [smoothCursor, paintRef]);
  useEffect(() => {
    animationsRef.current = animations;
    paintRef.current();
  }, [animations, paintRef]);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError, errorRef]);

  useEffect(() => {
    const grid = gridRef.current;
    const element = hostRef.current!;
    const surface = canvasRef.current!;
    grid.backgroundOpacity = backgroundOpacity;
    grid.pixelScrollEnabled = pixelScroll;

    let frame = 0;
    let disposed = false;
    let directScroll = false;
    let descriptionDirty = true;
    let hasFrame = grid.rows > 0 && grid.columns > 0;
    let ready = false;
    let preparingMotion = false;
    let cellWidth = 0;
    const input = inputRef.current!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cursor = new EditorCursor(grid, element, input, reducedMotion, smoothBlink, () =>
      schedule()
    );
    const scrolling = new EditorScroll({
      id,
      grid,
      enabled: () => scrollEnabledRef.current && !element.hidden && !document.hidden,
      schedule: () => schedule(),
      onError: (error) => errorRef.current(String(error)),
      onCompletion: (promise) => {
        scrollCompletionRef.current = promise;
      }
    });
    scrolling.observeHorizontal(grid.horizontalColumn);
    const previousFrame = document.createElement('canvas');
    const targetFrame = document.createElement('canvas');
    let motion: FrameMotion | undefined;
    let deferredScroll:
      { lines: number; columns: number; follow: boolean; discrete: boolean } | undefined;
    let lastScrollTime: number | undefined;
    let metrics = { cellWidth: 0, cellHeight: 0 };
    let paintedFocus = false;
    let paintedCursorVisible = true;
    let paintedCursorOpacity = 1;

    const resizer = createEditorResizer(id, attachedRef, errorRef, () => disposed);

    const stopMotion = (): void => {
      deferredScroll = undefined;
      motion = undefined;
      lastScrollTime = undefined;
      scrolling.stop();
    };

    const pauseMotion = (): void => {
      deferredScroll = undefined;
      lastScrollTime = undefined;
      if (motion?.offsetX === undefined) {
        motion = undefined;
      }
      scrolling.stop(true);
    };

    const keyDown = (event: KeyboardEvent): void => {
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        ['j', 'k'].includes(event.key) &&
        ['normal', 'visual', 'visual_line', 'visual_block'].includes(grid.mode)
      ) {
        // Navigation retargets the visible scroll instead of snapping it first.
        scrolling.stop();
      } else {
        stopMotion();
      }
    };

    scrollRef.current = (lines, follow, discrete, columns = 0): void => {
      if (deferredScroll) {
        deferredScroll.lines += lines;
        deferredScroll.columns += columns;
        deferredScroll.follow = follow;
        deferredScroll.discrete ||= discrete;
        return;
      }
      // Finish horizontal lookahead before vertical movement replaces its cached frames.
      if (lines && scrolling.alignHorizontal()) {
        deferredScroll = { lines, columns, follow, discrete };
        schedule();
        return;
      }
      directScroll = true;
      if (lines) {
        motion = undefined;
        scrolling.stopHorizontal();
        scrolling.request(
          lines,
          follow,
          animationsRef.current && !reducedMotion.matches ? (discrete ? 120 : 40) : 0
        );
      }
      if (columns) {
        scrolling.requestHorizontal(columns, follow, !lines);
      }
    };

    const render = (): void => {
      frame = 0;
      if (disposed || element.hidden || document.hidden) {
        return;
      }
      scrolling.pauseIfDisabled();
      if (!scrollEnabledRef.current) {
        deferredScroll = undefined;
      }
      if (!element.clientWidth || !element.clientHeight) {
        return;
      }
      const now = performance.now();
      if (deferredScroll && !scrolling.alignHorizontal()) {
        const request = deferredScroll;
        deferredScroll = undefined;
        scrollRef.current(request.lines, request.follow, request.discrete, request.columns);
      }
      scrolling.advance(now, animationsRef.current && !reducedMotion.matches);
      const focused = document.activeElement === input;
      if (motion?.offsetX !== undefined) {
        motion.offsetX = scrolling.horizontalOffset * cellWidth;
      }
      if (
        pixelScroll &&
        scrolling.canPrefetch &&
        !motion &&
        !preparingMotion &&
        grid.rows > 0 &&
        attachedRef.current
      ) {
        scrolling.prefetch();
      }
      scrolling.flush();
      const cursorPosition = cursor.update(
        now,
        smoothCursorRef.current,
        directScroll || !!motion,
        focused
      );
      const dpr = window.devicePixelRatio || 1;
      const bounds = alignCanvasSurface(surface, element, dpr);
      grid.surfaceLeft = bounds.left;
      grid.surfaceTop = bounds.top;
      const reuseTarget = !!(
        motion?.targetReady &&
        metrics.cellWidth &&
        (motion?.offsetX !== undefined || (animationsRef.current && !reducedMotion.matches)) &&
        targetFrame.width === Math.round(bounds.width * dpr) &&
        targetFrame.height === Math.round(bounds.height * dpr) &&
        paintedFocus === focused &&
        paintedCursorVisible === grid.cursorVisible &&
        paintedCursorOpacity === grid.cursorOpacity
      );
      if (!reuseTarget) {
        metrics = grid.draw(
          surface,
          bounds.width,
          bounds.height,
          fontSize,
          fontFamily,
          focused,
          cursorPosition,
          lineHeight,
          fontWeight
        );
        paintedFocus = focused;
        paintedCursorVisible = grid.cursorVisible;
        paintedCursorOpacity = grid.cursorOpacity;
      }
      cellWidth = metrics.cellWidth;

      const painted = paintEditorMotion({
        motion,
        grid,
        surface,
        previousFrame,
        targetFrame,
        cellWidth: metrics.cellWidth,
        dpr,
        animate: animationsRef.current && !reducedMotion.matches,
        backgroundOpacity,
        reuseTarget
      });
      if (motion?.offsetX !== undefined && !painted.motion) {
        scrolling.discardHorizontalFrame();
      }
      motion = painted.motion;
      const overlayOffset = painted.overlayOffset;
      grid.horizontalOffset = painted.horizontalOffset;
      grid.horizontalColumn = scrolling.horizontalColumn;
      if (motion?.offsetX !== undefined) {
        grid.horizontalGutter = motion.left;
      }

      afterPaintRef.current(overlayOffset);
      if (descriptionDirty) {
        const description = grid.description;
        if (surface.getAttribute('aria-description') !== description) {
          surface.setAttribute('aria-description', description);
        }
        descriptionDirty = false;
      }

      positionEditorInput(inputRef.current, bounds, grid, metrics.cellWidth, dpr);
      if (hasFrame && !ready) {
        ready = true;
        onReady?.(id);
      }

      const size = editorGridSize(bounds, metrics, pixelScroll, grid.extraRows);
      resizer.update(size.columns, size.rows);
      if (
        cursor.animating ||
        (motion && motion.offsetX === undefined) ||
        scrolling.animating ||
        deferredScroll ||
        (pixelScroll && scrolling.canPrefetch)
      ) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(render);
      }
    };

    const schedule = (): void => {
      scrolling.pauseIfDisabled();
      if (!disposed && !frame && !element.hidden && !document.hidden) {
        frame = requestAnimationFrame(render);
      }
    };

    paintRef.current = schedule;
    /** Sizes the snapshot canvas to the surface and returns a context that overwrites it. */
    const snapshotContext = (): CanvasRenderingContext2D => {
      if (previousFrame.width !== surface.width || previousFrame.height !== surface.height) {
        previousFrame.width = surface.width;
        previousFrame.height = surface.height;
      }
      const context = previousFrame.getContext('2d')!;
      context.globalCompositeOperation = 'copy';
      return context;
    };
    /** Paints the pre-scroll frame synchronously so motion can start from it. */
    const renderBeforeMotion = (): void => {
      preparingMotion = true;
      render();
      preparingMotion = false;
    };
    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      pauseMotion();
      cursor.resetBlink();
    };

    surface.addEventListener('pointerdown', pointerDown);

    cursor.listen();
    reducedMotion.addEventListener('change', stopMotion);
    input.addEventListener('keydown', keyDown);
    input.addEventListener('input', stopMotion);
    input.addEventListener('compositionstart', stopMotion);
    input.addEventListener('blur', pauseMotion);
    const unsubscribe = onNidoEvent((event) => {
      if (event.type === 'redraw' && event.id === id) {
        const redraw = summarizeRedraw(event.events);
        // Editing can shift grid rows without scrolling the viewport.
        const { edited, bufferChanged, scroll } = redraw;
        if (bufferChanged) {
          deferredScroll = undefined;
          motion = undefined;
          lastScrollTime = undefined;
          directScroll = false;
          scrolling.reset();
          if (redraw.bufferColumn !== undefined) {
            scrolling.observeHorizontal(redraw.bufferColumn);
          }
          cursor.resetPosition();
        }
        if (edited) {
          stopMotion();
        }
        for (const args of redraw.pixelOffsets) {
          grid.scrollFraction = Number(args[0]);
          grid.scrollCursor = args[2] as { row: number; column: number } | undefined;
          directScroll = args[1] === true;
          scrolling.acknowledge(directScroll, typeof args[4] === 'number' ? args[4] : undefined);
        }
        if (!redraw.pixelOffsets.length && redraw.lastScrollColumn !== undefined) {
          scrolling.observeHorizontal(redraw.lastScrollColumn);
        }
        if (redraw.cursorJumped) {
          cursor.resetPosition();
        }
        const now = performance.now();
        if (scroll && isHorizontalStep(scroll) && directScroll && scrolling.horizontalActive) {
          cancelAnimationFrame(frame);
          frame = 0;
          const previousContext = snapshotContext();
          if (
            motion?.offsetX !== undefined &&
            motion.targetReady &&
            targetFrame.width === surface.width &&
            targetFrame.height === surface.height
          ) {
            previousContext.drawImage(targetFrame, 0, 0);
          } else {
            motion = undefined;
            grid.invalidatePaint();
            renderBeforeMotion();
            previousContext.drawImage(surface, 0, 0);
          }
          motion = horizontalMotion(scroll, cellWidth, scrolling.horizontalOffset * cellWidth, now);
        } else if (
          scroll &&
          !bufferChanged &&
          !edited &&
          !directScroll &&
          animationsRef.current &&
          !reducedMotion.matches &&
          !element.hidden &&
          isAnimatableScroll(scroll)
        ) {
          const remaining = {
            y: motion ? scrollOffset(motion.distance, now - motion.start, motion.duration) : 0,
            x: motion ? scrollOffset(motion.distanceX, now - motion.start, motion.duration) : 0
          };
          cancelAnimationFrame(frame);
          renderBeforeMotion();
          snapshotContext().drawImage(surface, 0, 0);
          motion = scrollMotion(scroll, grid, cellWidth, remaining, now, lastScrollTime);
          lastScrollTime = now;
        } else if (
          redraw.viewportScrolls.length ||
          redraw.gridShifted ||
          (directScroll && motion?.offsetX === undefined)
        ) {
          motion = undefined;
          if (scroll && directScroll && Math.abs(scroll.columns) >= scroll.right - scroll.left) {
            // shortcut: viewport-sized jumps snap, until horizontal overscan supplies the missing edge.
            scrolling.discardHorizontalFrame();
          }
        }

        const { row, column } = grid.cursor;
        const mode = grid.mode;
        if (grid.apply(event.events)) {
          if (motion) {
            motion.targetReady = false;
          }
          hasFrame = grid.rows > 0 && grid.columns > 0;
          descriptionDirty ||= !ready;
          if (
            !scrolling.prefetchPending &&
            (redraw.layoutReset ||
              (!grid.hasUpperRows && grid.needsUpperRows && redraw.viewportMoved) ||
              (directScroll && scroll && scroll.rows < 0 && grid.needsUpperRows))
          ) {
            scrolling.invalidatePrefetch();
          }
          descriptionDirty ||= redraw.descriptionChanged;
          schedule();
        }

        if (row !== grid.cursor.row || column !== grid.cursor.column || mode !== grid.mode) {
          cursor.resetBlink();
        }
        scrolling.finish();
      }
    });

    const observer = new ResizeObserver(stopMotion);
    observer.observe(element);
    // Zoom and monitor changes can change DPR without resizing the editor host.
    let resolution: MediaQueryList;
    const watchResolution = (): void => {
      resolution?.removeEventListener('change', resolutionChanged);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener('change', resolutionChanged);
    };
    const resolutionChanged = (): void => {
      watchResolution();
      stopMotion();
    };
    watchResolution();
    window.addEventListener('resize', stopMotion);
    cursor.resetBlink();

    return () => {
      disposed = true;
      paintRef.current = () => {};
      scrollRef.current = () => {};
      grid.scrollPreview = 0;
      grid.horizontalOffset = 0;
      grid.scrolling = false;
      cursor.dispose();
      scrolling.dispose();
      surface.removeEventListener('pointerdown', pointerDown);
      reducedMotion.removeEventListener('change', stopMotion);
      input.removeEventListener('keydown', keyDown);
      input.removeEventListener('input', stopMotion);
      input.removeEventListener('compositionstart', stopMotion);
      input.removeEventListener('blur', pauseMotion);
      observer.disconnect();
      resolution.removeEventListener('change', resolutionChanged);
      window.removeEventListener('resize', stopMotion);
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [
    backgroundOpacity,
    onReady,
    id,
    fontSize,
    fontWeight,
    lineHeight,
    fontFamily,
    smoothBlink,
    pixelScroll,
    hostRef,
    canvasRef,
    inputRef,
    gridRef,
    attachedRef,
    errorRef,
    paintRef,
    afterPaintRef,
    scrollRef,
    scrollCompletionRef
  ]);

  useEffect(() => {
    if (active && !blocked) {
      inputRef.current?.focus();
      paintRef.current();
    }
  }, [active, blocked, focusTick, inputRef, paintRef]);
}
