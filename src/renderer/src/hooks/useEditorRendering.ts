import { useEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../grid';
import { scrollOffset } from '../scroll';
import { EditorScroll } from '../editorScroll';
import { alignCanvasSurface } from '../canvasSurface';
import { EditorCursor } from '../editorCursor';
import { paintEditorMotion, type FrameMotion } from '../editorMotion';

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
    let lastColumns = 0;
    let lastRows = 0;
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
    const previousFrame = document.createElement('canvas');
    const targetFrame = document.createElement('canvas');
    let motion: FrameMotion | undefined;
    let lastScrollTime: number | undefined;
    let metrics = { cellWidth: 0, cellHeight: 0 };
    let paintedFocus = false;
    let paintedCursorVisible = true;
    let paintedCursorOpacity = 1;

    const stopMotion = (): void => {
      motion = undefined;
      lastScrollTime = undefined;
      scrolling.stop();
    };

    const keyDown = (event: KeyboardEvent): void => {
      if (
        event.repeat &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        ['j', 'k'].includes(event.key) &&
        ['normal', 'visual', 'visual_line', 'visual_block'].includes(grid.mode)
      ) {
        // Repeating navigation retargets the visible scroll instead of snapping it first.
        scrolling.stop();
      } else {
        stopMotion();
      }
    };

    scrollRef.current = (lines, follow, discrete, columns = 0): void => {
      directScroll = true;
      motion = undefined;
      if (lines) {
        scrolling.request(
          lines,
          follow,
          animationsRef.current && !reducedMotion.matches ? (discrete ? 120 : 40) : 0
        );
      }
      if (columns) {
        scrolling.requestHorizontal(columns, follow);
      }
    };

    const render = (): void => {
      frame = 0;
      if (disposed || element.hidden || document.hidden) {
        return;
      }
      scrolling.pauseIfDisabled();
      if (!element.clientWidth || !element.clientHeight) {
        return;
      }
      const now = performance.now();
      scrolling.advance(now, animationsRef.current && !reducedMotion.matches);
      const focused = document.activeElement === input;
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
        animationsRef.current &&
        !reducedMotion.matches &&
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
      motion = painted.motion;
      const overlayOffset = painted.overlayOffset;

      afterPaintRef.current(overlayOffset);
      if (descriptionDirty) {
        const description = grid.description;
        if (surface.getAttribute('aria-description') !== description) {
          surface.setAttribute('aria-description', description);
        }
        descriptionDirty = false;
      }

      if (inputRef.current && !inputRef.current.hasAttribute('data-nvim-command-active')) {
        const left = bounds.left + grid.cursor.column * metrics.cellWidth;
        const top = bounds.top + grid.rowY(grid.cursor.row);
        // Unchanged styles wake popup observers and force layout during cursor blinking.
        if (!(Math.abs(parseFloat(inputRef.current.style.left) - left) * dpr < 0.01)) {
          inputRef.current.style.left = `${left}px`;
        }
        if (!(Math.abs(parseFloat(inputRef.current.style.top) - top) * dpr < 0.01)) {
          inputRef.current.style.top = `${top}px`;
        }
      }
      if (hasFrame && !ready) {
        ready = true;
        onReady?.(id);
      }

      const columns = Math.max(20, Math.floor(bounds.width / metrics.cellWidth));
      // External command UI needs no visible slot; retain a document row for scroll overscan.
      const rows =
        Math.max(
          4,
          pixelScroll
            ? Math.ceil(bounds.height / metrics.cellHeight)
            : Math.floor(bounds.height / metrics.cellHeight)
        ) +
        grid.extraRows +
        (pixelScroll ? 2 : 0);
      if (!attachedRef.current) {
        attachedRef.current = true;
        lastColumns = columns;
        lastRows = rows;
        void window.nido.attach(id, columns, rows).catch((e) => {
          if (!disposed) {
            errorRef.current(String(e));
          }
        });
      } else if (columns !== lastColumns || rows !== lastRows) {
        lastColumns = columns;
        lastRows = rows;
        void window.nido.resize(id, columns, rows).catch((e) => {
          if (!disposed) {
            errorRef.current(String(e));
          }
        });
      }
      if (
        cursor.animating ||
        motion ||
        scrolling.animating ||
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
    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      stopMotion();
      cursor.resetBlink();
    };

    surface.addEventListener('pointerdown', pointerDown);

    cursor.listen();
    reducedMotion.addEventListener('change', stopMotion);
    input.addEventListener('keydown', keyDown);
    input.addEventListener('input', stopMotion);
    input.addEventListener('compositionstart', stopMotion);
    input.addEventListener('blur', stopMotion);
    const unsubscribe = window.nido.onEvent((event) => {
      if (event.type === 'redraw' && event.id === id) {
        // Editing can shift grid rows without scrolling the viewport.
        const edited = event.events.some(([name]) => name === 'nido_edit');
        const bufferChanged = event.events.some(([name]) => name === 'nido_buffer');
        if (bufferChanged) {
          motion = undefined;
          lastScrollTime = undefined;
          directScroll = false;
          scrolling.reset();
          cursor.resetPosition();
        }
        if (edited) {
          stopMotion();
        }
        const pixelOffsets = event.events.flatMap(([name, ...calls]) =>
          name === 'nido_pixel_scroll' ? calls : []
        );
        for (const args of pixelOffsets) {
          grid.scrollFraction = Number(args[0]);
          grid.scrollCursor = args[2] as { row: number; column: number } | undefined;
          directScroll = args[1] === true;
          scrolling.acknowledge(directScroll);
        }
        const viewportScrolls = event.events.flatMap(([name, ...calls]) =>
          name === 'nido_scroll' ? calls : []
        );
        const scrolls = viewportScrolls.length
          ? viewportScrolls
          : event.events.flatMap(([name, ...calls]) => (name === 'grid_scroll' ? calls : []));
        const scroll = scrolls.length === 1 ? (scrolls[0] as number[]) : undefined;
        if (
          scrolls.length ||
          event.events.some(
            ([name]) => name === 'grid_resize' || name === 'grid_clear' || name === 'mode_change'
          )
        ) {
          cursor.resetPosition();
        }
        const now = performance.now();
        if (
          scroll &&
          !bufferChanged &&
          (!edited || (scroll[5] > 0 && scroll[6] === 0)) &&
          !directScroll &&
          animationsRef.current &&
          !reducedMotion.matches &&
          !element.hidden &&
          scroll[0] === 1 &&
          scroll[2] > scroll[1] &&
          scroll[4] > scroll[3] &&
          (scroll[5] !== 0 || scroll[6] !== 0)
        ) {
          const remaining = motion
            ? scrollOffset(motion.distance, now - motion.start, motion.duration)
            : 0;
          const remainingX = motion
            ? scrollOffset(motion.distanceX, now - motion.start, motion.duration)
            : 0;
          cancelAnimationFrame(frame);
          preparingMotion = true;
          render();
          preparingMotion = false;
          if (previousFrame.width !== surface.width || previousFrame.height !== surface.height) {
            previousFrame.width = surface.width;
            previousFrame.height = surface.height;
          }
          const previousContext = previousFrame.getContext('2d')!;
          previousContext.globalCompositeOperation = 'copy';
          previousContext.drawImage(surface, 0, 0);
          const height = grid.rowTop(scroll[2]) - grid.rowTop(scroll[1]);
          const distance = grid.rowTop(scroll[1] + scroll[5]) - grid.rowTop(scroll[1]);
          const width = (scroll[4] - scroll[3]) * cellWidth;
          motion = {
            top: scroll[1],
            bottom: scroll[2],
            left: scroll[3],
            right: scroll[4],
            // Large jumps use at most one viewport so the animation never exposes an empty gap.
            distance:
              scroll[5] < 0 ? remaining : Math.max(-height, Math.min(height, distance + remaining)),
            incomingRows: Math.max(0, -scroll[5]),
            distanceX:
              scroll[5] === 0
                ? Math.max(-width, Math.min(width, scroll[6] * cellWidth + remainingX))
                : 0,
            start: now,
            edit: edited,
            duration: edited ? 90 : Math.max(1, Math.min(120, now - (lastScrollTime ?? now - 120)))
          };
          lastScrollTime = now;
        } else if (scrolls.length || directScroll) {
          motion = undefined;
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
            (event.events.some(([name]) => name === 'grid_clear' || name === 'grid_resize') ||
              (!grid.hasUpperRows &&
                grid.needsUpperRows &&
                event.events.some(([name]) => name === 'nido_scroll' || name === 'grid_scroll')) ||
              (directScroll && scroll && scroll[5] < 0 && grid.needsUpperRows))
          ) {
            scrolling.invalidatePrefetch();
          }
          descriptionDirty ||= event.events.some(
            ([name]) =>
              name === 'grid_line' ||
              name === 'grid_scroll' ||
              name === 'grid_resize' ||
              name === 'grid_clear' ||
              name === 'nido_buffer'
          );
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
      grid.scrolling = false;
      cursor.dispose();
      scrolling.dispose();
      surface.removeEventListener('pointerdown', pointerDown);
      reducedMotion.removeEventListener('change', stopMotion);
      input.removeEventListener('keydown', keyDown);
      input.removeEventListener('input', stopMotion);
      input.removeEventListener('compositionstart', stopMotion);
      input.removeEventListener('blur', stopMotion);
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
