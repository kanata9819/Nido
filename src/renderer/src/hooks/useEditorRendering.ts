import { useEffect, useRef, type RefObject } from 'react';
import { Grid } from '../grid';
import { scrollOffset } from '../scroll';

interface UseEditorRenderingOptions {
  animations: boolean;
  smoothCursor: boolean;
  smoothBlink: boolean;
  pixelScroll: boolean;
  id: string;
  fontSize: number;
  blocked: boolean;
  active: boolean;
  focusTick: number;
  onError: (message: string) => void;
  errorRef: RefObject<(message: string) => void>;
  hostRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  gridRef: RefObject<Grid>;
  attachedRef: RefObject<boolean>;
  paintRef: RefObject<() => void>;
  fontFamily: string;
}

export function useEditorRendering({
  animations,
  smoothCursor,
  smoothBlink,
  pixelScroll,
  id,
  fontSize,
  blocked,
  active,
  focusTick,
  onError,
  errorRef,
  hostRef,
  canvasRef,
  inputRef,
  gridRef,
  attachedRef,
  paintRef,
  fontFamily
}: UseEditorRenderingOptions): void {
  const animationsRef = useRef(animations);
  const smoothCursorRef = useRef(smoothCursor);
  useEffect(() => {
    smoothCursorRef.current = smoothCursor;
    paintRef.current();
  }, [smoothCursor]);
  useEffect(() => {
    animationsRef.current = animations;
    paintRef.current();
  }, [animations]);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const element = hostRef.current!;
    const surface = canvasRef.current!;
    gridRef.current.pixelScrollEnabled = pixelScroll;

    let frame = 0;
    let disposed = false;
    let directScroll = false;
    let lastColumns = 0;
    let lastRows = 0;
    let cellWidth = 0;
    let cursorPosition: { row: number; column: number } | undefined;
    let cursorMotion:
      { from: { row: number; column: number }; to: { row: number; column: number }; start: number } | undefined;
    let blinkTimer: ReturnType<typeof setTimeout> | undefined;
    let blinkFade: { from: number; to: number; start: number } | undefined;
    const input = inputRef.current!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const previousFrame = document.createElement('canvas');
    const targetFrame = document.createElement('canvas');
    let motion:
      | { top: number; bottom: number; left: number; right: number; distance: number; distanceX: number; start: number }
      | undefined;

    const stopMotion = (): void => {
      motion = undefined;
      schedule();
    };

    const render = (): void => {
      if (disposed || !element.clientWidth || !element.clientHeight) {
        return;
      }
      const focused = document.activeElement === input;
      const target = gridRef.current.scrollCursor ?? gridRef.current.cursor;
      const now = performance.now();
      if (blinkFade) {
        const progress = canBlink() ? Math.min(1, (now - blinkFade.start) / 180) : 1;
        const eased = progress * progress * (3 - 2 * progress);
        gridRef.current.cursorOpacity = canBlink() ? blinkFade.from + (blinkFade.to - blinkFade.from) * eased : 1;
        if (progress === 1) {
          blinkFade = undefined;
        }
      }
      if (
        !cursorPosition ||
        !smoothCursorRef.current ||
        directScroll ||
        reducedMotion.matches ||
        !focused ||
        !document.hasFocus() ||
        motion
      ) {
        cursorPosition = { ...target };
        cursorMotion = undefined;
      } else {
        const previousTarget = cursorMotion?.to ?? cursorPosition;
        if (target.row !== previousTarget.row || target.column !== previousTarget.column) {
          cursorMotion = { from: { ...cursorPosition }, to: { ...target }, start: now };
        }
        if (cursorMotion) {
          const progress = Math.min(1, (now - cursorMotion.start) / 100);
          const eased = 1 - (1 - progress) ** 3;
          cursorPosition = {
            row: cursorMotion.from.row + (cursorMotion.to.row - cursorMotion.from.row) * eased,
            column: cursorMotion.from.column + (cursorMotion.to.column - cursorMotion.from.column) * eased
          };
          if (progress === 1) {
            cursorMotion = undefined;
          }
        }
      }
      const metrics = gridRef.current.draw(
        surface,
        element.clientWidth,
        element.clientHeight,
        fontSize,
        fontFamily,
        focused,
        cursorPosition
      );
      cellWidth = metrics.cellWidth;

      if (motion) {
        const offset = scrollOffset(motion.distance, performance.now() - motion.start);
        const offsetX = scrollOffset(motion.distanceX, performance.now() - motion.start);
        if (
          (Math.abs(offset) < 0.25 && Math.abs(offsetX) < 0.25) ||
          reducedMotion.matches ||
          !animationsRef.current ||
          previousFrame.width !== surface.width ||
          previousFrame.height !== surface.height
        ) {
          motion = undefined;
        } else {
          targetFrame.width = surface.width;
          targetFrame.height = surface.height;
          targetFrame.getContext('2d')!.drawImage(surface, 0, 0);
          const ctx = surface.getContext('2d')!;
          const dpr = window.devicePixelRatio || 1;
          const top = motion.top * metrics.cellHeight;
          const height = (motion.bottom - motion.top) * metrics.cellHeight;
          const left = motion.left * metrics.cellWidth;
          const width = (motion.right - motion.left) * metrics.cellWidth;
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top, width, height);
          ctx.clip();
          ctx.fillStyle = gridRef.current.background;
          ctx.fillRect(left, top, width, height);
          // Keep the departing rows visible until the incoming rows cover them.
          for (const [image, shift, shiftX] of [
            [previousFrame, offset - motion.distance, offsetX - motion.distanceX],
            [targetFrame, offset, offsetX]
          ] as const) {
            ctx.drawImage(
              image,
              left * dpr,
              top * dpr,
              width * dpr,
              height * dpr,
              left + shiftX,
              top + shift,
              width,
              height
            );
          }
          ctx.restore();
        }
      }

      surface.setAttribute(
        'aria-description',
        gridRef.current.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
      );

      if (inputRef.current) {
        inputRef.current.style.left = `${gridRef.current.cursor.column * metrics.cellWidth}px`;
        const row = gridRef.current.cursor.row;
        const offset = pixelScroll ? (row === gridRef.current.rows - 1 ? 1 : gridRef.current.scrollFraction) : 0;
        inputRef.current.style.top = `${(row - offset) * metrics.cellHeight}px`;
      }

      const columns = Math.max(20, Math.floor(element.clientWidth / metrics.cellWidth));
      // Keep one extra content row available under the pinned command line for fractional scrolling.
      const rows = Math.max(4, Math.floor(element.clientHeight / metrics.cellHeight)) + (pixelScroll ? 1 : 0);
      if (!attachedRef.current) {
        attachedRef.current = true;
        lastColumns = columns;
        lastRows = rows;
        void window.nido.attach(id, columns, rows).catch((e) => errorRef.current(String(e)));
      } else if (columns !== lastColumns || rows !== lastRows) {
        lastColumns = columns;
        lastRows = rows;
        void window.nido.resize(id, columns, rows).catch((e) => errorRef.current(String(e)));
      }
      if (cursorMotion || motion || blinkFade) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(render);
      }
    };

    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };

    paintRef.current = schedule;
    const canBlink = (): boolean =>
      document.hasFocus() &&
      !document.hidden &&
      !element.hidden &&
      document.activeElement === input &&
      !reducedMotion.matches;

    const blink = (): void => {
      if (!canBlink()) {
        return;
      }
      if (smoothBlink) {
        blinkFade = {
          from: gridRef.current.cursorOpacity,
          to: gridRef.current.cursorOpacity > 0.5 ? 0 : 1,
          start: performance.now()
        };
      } else {
        gridRef.current.cursorVisible = !gridRef.current.cursorVisible;
      }
      schedule();
      blinkTimer = setTimeout(blink, 550);
    };

    const resetBlink = (): void => {
      clearTimeout(blinkTimer);
      gridRef.current.cursorVisible = true;
      gridRef.current.cursorOpacity = 1;
      blinkFade = undefined;
      schedule();
      if (canBlink()) {
        blinkTimer = setTimeout(blink, 550);
      }
    };

    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      stopMotion();
      resetBlink();
    };

    surface.addEventListener('pointerdown', pointerDown);

    for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
      input.addEventListener(event, resetBlink);
    }

    window.addEventListener('focus', resetBlink);
    window.addEventListener('blur', resetBlink);
    document.addEventListener('visibilitychange', resetBlink);
    reducedMotion.addEventListener('change', resetBlink);
    reducedMotion.addEventListener('change', stopMotion);
    input.addEventListener('keydown', stopMotion);
    input.addEventListener('input', stopMotion);
    input.addEventListener('compositionstart', stopMotion);
    input.addEventListener('blur', stopMotion);
    const unsubscribe = window.nido.onEvent((event) => {
      if (event.type === 'redraw' && event.id === id) {
        const pixelOffsets = event.events.flatMap(([name, ...calls]) => (name === 'nido_pixel_scroll' ? calls : []));
        for (const args of pixelOffsets) {
          gridRef.current.scrollFraction = Number(args[0]);
          gridRef.current.scrollCursor = args[2] as { row: number; column: number } | undefined;
          directScroll = args[1] === true;
        }
        const viewportScrolls = event.events.flatMap(([name, ...calls]) => (name === 'nido_scroll' ? calls : []));
        const scrolls = viewportScrolls.length
          ? viewportScrolls
          : event.events.flatMap(([name, ...calls]) => (name === 'grid_scroll' ? calls : []));
        const scroll = scrolls.length === 1 ? (scrolls[0] as number[]) : undefined;
        if (
          scrolls.length ||
          event.events.some(([name]) => name === 'grid_resize' || name === 'grid_clear' || name === 'mode_change')
        ) {
          cursorPosition = undefined;
          cursorMotion = undefined;
        }
        const now = performance.now();
        if (
          scroll &&
          !directScroll &&
          animationsRef.current &&
          !reducedMotion.matches &&
          !element.hidden &&
          scroll[0] === 1 &&
          scroll[2] > scroll[1] &&
          scroll[4] > scroll[3] &&
          (scroll[5] !== 0 || scroll[6] !== 0)
        ) {
          const remaining = motion ? scrollOffset(motion.distance, now - motion.start) : 0;
          const remainingX = motion ? scrollOffset(motion.distanceX, now - motion.start) : 0;
          cancelAnimationFrame(frame);
          render();
          previousFrame.width = surface.width;
          previousFrame.height = surface.height;
          previousFrame.getContext('2d')!.drawImage(surface, 0, 0);
          const cellHeight = Math.ceil(fontSize * 1.65);
          const height = (scroll[2] - scroll[1]) * cellHeight;
          const width = (scroll[4] - scroll[3]) * cellWidth;
          motion = {
            top: scroll[1],
            bottom: scroll[2],
            left: scroll[3],
            right: scroll[4],
            // Large jumps use at most one viewport so the animation never exposes an empty gap.
            distance: Math.max(-height, Math.min(height, scroll[5] * cellHeight + remaining)),
            distanceX: scroll[5] === 0 ? Math.max(-width, Math.min(width, scroll[6] * cellWidth + remainingX)) : 0,
            start: now
          };
        } else if (scrolls.length || directScroll) {
          motion = undefined;
        }

        const { row, column } = gridRef.current.cursor;
        const mode = gridRef.current.mode;
        if (gridRef.current.apply(event.events)) {
          schedule();
        }

        if (
          row !== gridRef.current.cursor.row ||
          column !== gridRef.current.cursor.column ||
          mode !== gridRef.current.mode
        ) {
          resetBlink();
        }
      }
    });

    const observer = new ResizeObserver(stopMotion);
    observer.observe(element);
    resetBlink();

    return () => {
      disposed = true;
      clearTimeout(blinkTimer);
      surface.removeEventListener('pointerdown', pointerDown);
      for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
        input.removeEventListener(event, resetBlink);
      }
      window.removeEventListener('focus', resetBlink);
      window.removeEventListener('blur', resetBlink);
      document.removeEventListener('visibilitychange', resetBlink);
      reducedMotion.removeEventListener('change', resetBlink);
      reducedMotion.removeEventListener('change', stopMotion);
      input.removeEventListener('keydown', stopMotion);
      input.removeEventListener('input', stopMotion);
      input.removeEventListener('compositionstart', stopMotion);
      input.removeEventListener('blur', stopMotion);
      observer.disconnect();
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [id, fontSize, fontFamily, smoothBlink, pixelScroll]);

  useEffect(() => {
    if (active && !blocked) {
      inputRef.current?.focus();
      paintRef.current();
    }
  }, [active, blocked, focusTick]);
}
