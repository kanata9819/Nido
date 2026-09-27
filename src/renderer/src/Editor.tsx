import { useEffect, useRef, type ReactNode } from 'react';
import { Grid } from './grid';
import { accumulateScroll } from './scroll';
import { useEditorRendering } from './hooks/useEditorRendering';
import { useEditorInput } from './hooks/useEditorInput';
import styles from './assets/Nido.module.css';
import TypeInformation from './components/TypeInformation';

interface Props {
  scrollFollowCursor?: boolean;
  scrollCursor?: { row: number; column: number };
  terminal?: boolean;
  children?: ReactNode;
  id: string;
  active: boolean;
  fontSize: number;
  animations: boolean;
  smoothCursor: boolean;
  smoothBlink: boolean;
  blocked: boolean;
  focusTick: number;
  fontFamily: string;
  onError: (message: string) => void;
}
export default function Editor({
  scrollFollowCursor = true,
  scrollCursor,
  terminal = false,
  children,
  id,
  active,
  fontSize,
  animations,
  smoothCursor,
  smoothBlink,
  blocked,
  focusTick,
  fontFamily,
  onError
}: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const grid = useRef(new Grid());
  const composing = useRef(false);
  const attached = useRef(false);
  const wheel = useRef({ remainder: 0, time: 0 });
  useEffect(() => {
    wheel.current = { remainder: 0, time: 0 };
  }, [active, blocked, fontSize]);

  const paint = useRef<() => void>(() => {});
  const error = useRef(onError);
  useEffect(() => {
    grid.current.scrollCursor = scrollCursor;
    paint.current();
  }, [scrollCursor]);

  useEffect(() => {
    error.current = onError;
  }, [onError]);

  useEditorRendering({
    animations,
    smoothCursor,
    smoothBlink,
    id,
    fontSize,
    blocked,
    active,
    focusTick,
    onError,
    errorRef: error,
    hostRef: host,
    canvasRef: canvas,
    inputRef: input,
    gridRef: grid,
    attachedRef: attached,
    paintRef: paint,
    fontFamily: fontFamily
  });

  const inputHandlers = useEditorInput({
    id,
    blocked,
    composingRef: composing,
    paintRef: paint,
    onError
  });

  const send = (promise: Promise<unknown>): void => {
    void promise.catch((e) => error.current(String(e)));
  };

  return (
    <div
      ref={host}
      className={styles.editor}
      hidden={!active}
      onClick={() => input.current?.focus()}
      onWheel={(event) => {
        if (blocked || !active || event.ctrlKey || composing.current) {
          return;
        }
        const now = performance.now();
        const result = accumulateScroll(
          now - wheel.current.time > 200 ? 0 : wheel.current.remainder,
          event.deltaY,
          event.deltaMode,
          Math.ceil(fontSize * 1.65),
          event.currentTarget.clientHeight
        );
        wheel.current = { remainder: result.remainder, time: now };
        if (result.lines) {
          send(window.nido.scroll(id, Math.max(-1000, Math.min(1000, result.lines)), terminal || scrollFollowCursor));
        }
      }}
    >
      <canvas
        ref={canvas}
        className={styles.canvas}
        aria-label={terminal ? 'Terminal display' : 'Neovim editor display'}
      />
      {children}
      {active && !blocked && !terminal && <TypeInformation id={id} input={input} fontFamily={fontFamily} />}
      <textarea
        ref={input}
        className={styles.editorInput}
        aria-label={terminal ? 'Terminal input' : 'Neovim input'}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        {...inputHandlers}
      />
    </div>
  );
}
