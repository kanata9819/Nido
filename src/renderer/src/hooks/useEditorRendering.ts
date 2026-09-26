import { useEffect, type RefObject } from 'react';
import { Grid } from '../grid';

interface UseEditorRenderingOptions {
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
    const canBlink = (): boolean => document.hasFocus() && !document.hidden &&
      !element.hidden && document.activeElement === input && !reducedMotion.matches;
    const blink = (): void => {
      if (!canBlink()) return;
      gridRef.current.cursorVisible = !gridRef.current.cursorVisible;
      schedule();
      blinkTimer = setTimeout(blink, 550);
    };
    const resetBlink = (): void => {
      clearTimeout(blinkTimer);
      gridRef.current.cursorVisible = true;
      schedule();
      if (canBlink()) blinkTimer = setTimeout(blink, 550);
    };
    for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) input.addEventListener(event, resetBlink);
    window.addEventListener('focus', resetBlink);
    window.addEventListener('blur', resetBlink);
    document.addEventListener('visibilitychange', resetBlink);
    reducedMotion.addEventListener('change', resetBlink);
    const unsubscribe = window.nido.onEvent((event) => {
      if (event.type === 'redraw' && event.id === id) {
        const { row, column } = gridRef.current.cursor;
        const mode = gridRef.current.mode;
        if (gridRef.current.apply(event.events)) schedule();
        if (row !== gridRef.current.cursor.row || column !== gridRef.current.cursor.column || mode !== gridRef.current.mode) resetBlink();
      }
    });

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    resetBlink();

    return () => {
      disposed = true;
      clearTimeout(blinkTimer);
      for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) input.removeEventListener(event, resetBlink);
      window.removeEventListener('focus', resetBlink);
      window.removeEventListener('blur', resetBlink);
      document.removeEventListener('visibilitychange', resetBlink);
      reducedMotion.removeEventListener('change', resetBlink);
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
