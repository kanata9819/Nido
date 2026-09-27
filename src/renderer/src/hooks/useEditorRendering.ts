import { useEffect, useRef, type RefObject } from 'react';
import { Grid } from '../grid';
import { scrollOffset } from '../scroll';

interface UseEditorRenderingOptions {
  animations: boolean;
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
}

export function useEditorRendering({
  animations,
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
  paintRef
}: UseEditorRenderingOptions): void {
  const animationsRef = useRef(animations);
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

    let frame = 0;
    let disposed = false;
    let lastColumns = 0;
    let lastRows = 0;
    let blinkTimer: ReturnType<typeof setTimeout> | undefined;
    const input = inputRef.current!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const previousFrame = document.createElement('canvas');
    const targetFrame = document.createElement('canvas');
    let lastScrollInput = -Infinity;
    let motion: { top: number; bottom: number; distance: number; start: number } | undefined;

    const rememberWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        lastScrollInput = performance.now();
      }
    };
    const stopMotion = (): void => {
      motion = undefined;
      lastScrollInput = -Infinity;
      schedule();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      const scrollKey = event.ctrlKey && ['d', 'u', 'e', 'y'].includes(event.key.toLowerCase());
      const navigationMode = /^(normal|visual)/.test(gridRef.current.mode);
      if (scrollKey && navigationMode && !event.altKey && !event.metaKey && !event.isComposing) {
        lastScrollInput = performance.now();
      } else {
        stopMotion();
      }
    };

    const render = (): void => {
      if (disposed || !element.clientWidth || !element.clientHeight) {
        return;
      }
      const metrics = gridRef.current.draw(
        surface,
        element.clientWidth,
        element.clientHeight,
        fontSize,
        document.activeElement === inputRef.current
      );

      if (motion) {
        const offset = scrollOffset(motion.distance, performance.now() - motion.start);
        if (
          Math.abs(offset) < 0.25 ||
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
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, top, element.clientWidth, height);
          ctx.clip();
          ctx.fillStyle = gridRef.current.background;
          ctx.fillRect(0, top, element.clientWidth, height);
          // Keep the departing rows visible until the incoming rows cover them.
          for (const [image, shift] of [
            [previousFrame, offset - motion.distance],
            [targetFrame, offset]
          ] as const) {
            ctx.drawImage(image, 0, top * dpr, image.width, height * dpr, 0, top + shift, image.width / dpr, height);
          }
          ctx.restore();
          frame = requestAnimationFrame(render);
        }
      }

      surface.setAttribute(
        'aria-description',
        gridRef.current.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
      );

      if (inputRef.current) {
        inputRef.current.style.left = `${gridRef.current.cursor.column * metrics.cellWidth}px`;
        inputRef.current.style.top = `${gridRef.current.cursor.row * metrics.cellHeight}px`;
      }

      const columns = Math.max(20, Math.floor(element.clientWidth / metrics.cellWidth));
      const rows = Math.max(4, Math.floor(element.clientHeight / metrics.cellHeight));
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
      gridRef.current.cursorVisible = !gridRef.current.cursorVisible;
      schedule();
      blinkTimer = setTimeout(blink, 550);
    };
    const resetBlink = (): void => {
      clearTimeout(blinkTimer);
      gridRef.current.cursorVisible = true;
      schedule();
      if (canBlink()) {
        blinkTimer = setTimeout(blink, 550);
      }
    };
    for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
      input.addEventListener(event, resetBlink);
    }
    window.addEventListener('focus', resetBlink);
    window.addEventListener('blur', resetBlink);
    document.addEventListener('visibilitychange', resetBlink);
    reducedMotion.addEventListener('change', resetBlink);
    reducedMotion.addEventListener('change', stopMotion);
    element.addEventListener('wheel', rememberWheel, { passive: true });
    input.addEventListener('keydown', handleKeyDown);
    input.addEventListener('input', stopMotion);
    input.addEventListener('compositionstart', stopMotion);
    input.addEventListener('blur', stopMotion);
    const unsubscribe = window.nido.onEvent((event) => {
      if (event.type === 'redraw' && event.id === id) {
        const viewportScrolls = event.events.flatMap(([name, ...calls]) => (name === 'nido_scroll' ? calls : []));
        const scrolls = viewportScrolls.length
          ? viewportScrolls
          : event.events.flatMap(([name, ...calls]) => (name === 'grid_scroll' ? calls : []));
        const scroll = scrolls.length === 1 ? (scrolls[0] as number[]) : undefined;
        const now = performance.now();
        if (
          scroll &&
          animationsRef.current &&
          !reducedMotion.matches &&
          !element.hidden &&
          now - lastScrollInput < 180 &&
          scroll[0] === 1 &&
          scroll[3] === 0 &&
          scroll[4] === gridRef.current.columns &&
          scroll[6] === 0 &&
          Math.abs(scroll[5]) < scroll[2] - scroll[1] &&
          scroll[5] !== 0
        ) {
          const remaining = motion ? scrollOffset(motion.distance, now - motion.start) : 0;
          cancelAnimationFrame(frame);
          render();
          previousFrame.width = surface.width;
          previousFrame.height = surface.height;
          previousFrame.getContext('2d')!.drawImage(surface, 0, 0);
          motion = {
            top: scroll[1],
            bottom: scroll[2],
            distance: scroll[5] * Math.ceil(fontSize * 1.65) + remaining,
            start: now
          };
        } else if (scrolls.length) {
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
      for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
        input.removeEventListener(event, resetBlink);
      }
      window.removeEventListener('focus', resetBlink);
      window.removeEventListener('blur', resetBlink);
      document.removeEventListener('visibilitychange', resetBlink);
      reducedMotion.removeEventListener('change', resetBlink);
      reducedMotion.removeEventListener('change', stopMotion);
      element.removeEventListener('wheel', rememberWheel);
      input.removeEventListener('keydown', handleKeyDown);
      input.removeEventListener('input', stopMotion);
      input.removeEventListener('compositionstart', stopMotion);
      input.removeEventListener('blur', stopMotion);
      observer.disconnect();
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [id, fontSize]);

  useEffect(() => {
    if (active && !blocked) {
      inputRef.current?.focus();
      paintRef.current();
    }
  }, [active, blocked, focusTick]);
}
