// One editor per workspace. Text is painted on a <canvas> from the Grid (grid.ts).
// Keys arrive through a hidden <textarea> so IME composition works (hooks/useEditorInput.ts).
// hooks/useEditorRendering.ts applies Neovim events and repaints.
import { useI18n } from './i18n';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Grid } from './grid';
import { accumulateScroll, editorWheelMotion } from './scroll';
import { useEditorRendering } from './hooks/useEditorRendering';
import { useEditorInput } from './hooks/useEditorInput';
import styles from './assets/Editor.module.css';
import TypeInformation from './components/TypeInformation';
import DiagnosticInformation from './components/DiagnosticInformation';
import CompletionMenu from './components/CompletionMenu';
import StickyScroll from './components/StickyScroll';
import NeovimUI from './components/NeovimUI';
import type { UITheme } from '../../shared/types';
import { defaultFontWeight } from './hooks/useEditorSettings';

interface Props {
  theme: UITheme;
  scrollFollowCursor?: boolean;
  stickyScroll?: boolean;
  stickyScrollMaxLines?: number;
  terminal?: boolean;
  children?: ReactNode;
  id: string;
  active: boolean;
  fontSize: number;
  fontWeight?: number;
  lineHeight: number;
  animations: boolean;
  smoothCursor: boolean;
  smoothBlink: boolean;
  blocked: boolean;
  focusTick: number;
  fontFamily: string;
  onError: (message: string) => void;
  onReady?: (id: string) => void;
}

export default memo(Editor);

function Editor({
  theme,
  scrollFollowCursor = true,
  stickyScroll = true,
  stickyScrollMaxLines = 5,
  terminal = false,
  children,
  id,
  active,
  fontSize,
  fontWeight = defaultFontWeight,
  lineHeight,
  animations,
  smoothCursor,
  smoothBlink,
  blocked,
  focusTick,
  fontFamily,
  onError,
  onReady
}: Props): React.JSX.Element {
  const t = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [editorGrid] = useState(() => new Grid());
  const grid = useRef(editorGrid);
  const composing = useRef(false);
  const attached = useRef(false);
  const wheel = useRef({ remainder: 0, time: 0 });
  const horizontalWheel = useRef({ remainder: 0, time: 0 });
  const paint = useRef<() => void>(() => {});
  const stickyPaint = useRef<(motionOffset: number) => void>(() => {});
  const scroll = useRef<
    (lines: number, follow: boolean, discrete: boolean, columns?: number) => void
  >(() => {});
  const scrollCompletion = useRef<Promise<void>>(Promise.resolve());
  const error = useRef(onError);

  useEffect(() => {
    wheel.current = { remainder: 0, time: 0 };
    horizontalWheel.current = { remainder: 0, time: 0 };
  }, [active, blocked, lineHeight, fontSize, fontFamily]);

  useEffect(() => {
    const resetComposition = (): void => {
      composing.current = false;
      if (input.current) {
        input.current.value = '';
        input.current.removeAttribute('data-composing');
      }
    };
    if (!active || blocked) {
      resetComposition();
      return;
    }
    const visibilityChanged = (): void => {
      if (document.hidden) {
        resetComposition();
      }
    };
    window.addEventListener('blur', resetComposition);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.removeEventListener('blur', resetComposition);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, blocked]);

  useEffect(() => {
    error.current = onError;
  }, [onError]);

  useEditorRendering({
    backgroundOpacity: theme === 'acrylic' ? 0.5 : 1,
    animations,
    smoothCursor,
    smoothBlink,
    id,
    fontSize,
    fontWeight,
    lineHeight,
    blocked,
    active,
    focusTick,
    onError,
    onReady,
    errorRef: error,
    hostRef: host,
    canvasRef: canvas,
    inputRef: input,
    gridRef: grid,
    attachedRef: attached,
    paintRef: paint,
    afterPaintRef: stickyPaint,
    scrollRef: scroll,
    scrollCompletionRef: scrollCompletion,
    fontFamily: fontFamily,
    pixelScroll: !terminal
  });

  const inputHandlers = useEditorInput({
    id,
    blocked: blocked || !active,
    composingRef: composing,
    paintRef: paint,
    onError
  });

  const send = (promise: Promise<unknown>): void => {
    void promise.catch((e) => error.current(String(e)));
  };

  /** Editors scroll smoothly by pixels and sideways by columns. */
  const scrollEditor = (event: React.WheelEvent<HTMLDivElement>): void => {
    const { horizontalWheel: nextWheel, motion } = editorWheelMotion(
      event,
      { surface: event.currentTarget, lineHeight, cellWidth: grid.current.cellWidth },
      horizontalWheel.current,
      performance.now()
    );
    horizontalWheel.current = nextWheel;
    if (motion) {
      scroll.current(motion.lines, scrollFollowCursor, motion.discrete, motion.columns);
    }
  };

  /** Terminals scroll by whole lines, carrying the remainder between nearby events. */
  const scrollTerminal = (event: React.WheelEvent<HTMLDivElement>): void => {
    const now = performance.now();
    const result = accumulateScroll(
      now - wheel.current.time > 200 ? 0 : wheel.current.remainder,
      event.deltaY * 0.5,
      event.deltaMode,
      lineHeight,
      event.currentTarget.clientHeight
    );
    wheel.current = { remainder: result.remainder, time: now };
    if (result.lines) {
      send(window.nido.scroll(id, Math.max(-1000, Math.min(1000, result.lines)), true));
    }
  };
  return (
    <div
      ref={host}
      className={styles.editor}
      hidden={!active}
      onKeyDownCapture={(event) => {
        if (!blocked && event.altKey && event.shiftKey && event.key.toLowerCase() === 'm') {
          const content = host.current?.querySelector<HTMLElement>(
            '[data-neovim-ui] [tabindex="0"]'
          );
          if (content) {
            event.preventDefault();
            event.stopPropagation();
            content.focus();
          }
        }
        if (!blocked && event.altKey && event.shiftKey && event.key.toLowerCase() === 's') {
          const header = host.current?.querySelector<HTMLButtonElement>(
            '[data-sticky-scroll] button'
          );
          if (header) {
            event.preventDefault();
            event.stopPropagation();
            header.focus();
          }
        }
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          blocked ||
          !active ||
          composing.current ||
          event.target !== canvas.current
        ) {
          return;
        }

        event.preventDefault();
        input.current?.focus();
        if (terminal) {
          return;
        }

        const { cellWidth, cellHeight, columns } = grid.current;
        if (!cellWidth || !cellHeight) {
          return;
        }

        const bounds = canvas.current.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const horizontalColumn = grid.current.horizontalColumn;
        const horizontalOffset = grid.current.horizontalOffset;
        const gutter = grid.current.horizontalGutter;
        const body = x >= gutter * cellWidth;
        const column = Math.floor((x - (body ? horizontalOffset : 0)) / cellWidth);
        const y = event.clientY - bounds.top;
        if (x < 0 || x >= columns * cellWidth) {
          return;
        }
        send(
          (async () => {
            await scrollCompletion.current;
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!host.current) {
              return;
            }
            const row = grid.current.rowAt(y);
            if (row >= 0) {
              const currentGutter = grid.current.horizontalGutter;
              if (Math.abs(horizontalOffset) > cellWidth) {
                const delta =
                  Math.max(0, Math.floor(horizontalColumn - horizontalOffset / cellWidth)) -
                  grid.current.horizontalColumn;
                if (delta) {
                  await window.nido.scroll(id, 0, false, true, delta);
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                }
              }
              let target = body
                ? column - gutter + currentGutter + horizontalColumn - grid.current.horizontalColumn
                : column;
              if (body && target < currentGutter) {
                // The leftmost partial cell can still belong to the previous native frame.
                await window.nido.scroll(id, 0, false, true, target - currentGutter);
                target = currentGutter;
              }
              await window.nido.click(id, row, Math.max(0, target));
            }
          })()
        );
      }}
      onWheel={(event) => {
        if (
          blocked ||
          !active ||
          event.ctrlKey ||
          composing.current ||
          (event.target as Element).closest(
            '[data-type-information], [data-diagnostic-information], [data-neovim-ui]'
          )
        ) {
          return;
        }
        if (terminal) {
          scrollTerminal(event);
        } else {
          scrollEditor(event);
        }
      }}
    >
      <canvas
        key={theme === 'acrylic' ? 'acrylic' : 'opaque'}
        ref={canvas}
        className={styles.canvas}
        aria-label={terminal ? t('Terminal display') : t('Neovim editor display')}
      />
      {children}
      <NeovimUI
        id={id}
        grid={grid}
        input={input}
        paint={paint}
        fontFamily={fontFamily}
        hidden={blocked || !active}
        onError={onError}
      />
      {!terminal && active && stickyScroll && (
        <StickyScroll
          id={id}
          grid={grid}
          paintRef={stickyPaint}
          input={input}
          scrollCompletion={scrollCompletion}
          maxLines={stickyScrollMaxLines}
          fontSize={fontSize}
          fontWeight={fontWeight}
          fontFamily={fontFamily}
          onError={onError}
        />
      )}
      {!terminal && (
        <CompletionMenu
          id={id}
          grid={grid}
          input={input}
          fontFamily={fontFamily}
          onError={onError}
          hidden={blocked || !active}
        />
      )}
      {!terminal && (
        <>
          <TypeInformation
            id={id}
            input={input}
            fontFamily={fontFamily}
            hidden={!active || blocked}
          />
          <DiagnosticInformation
            id={id}
            input={input}
            fontFamily={fontFamily}
            onError={onError}
            hidden={!active || blocked}
          />
        </>
      )}
      <textarea
        ref={input}
        className={styles.editorInput}
        style={{
          fontFamily,
          fontSize,
          fontWeight,
          lineHeight: `${lineHeight}px`,
          height: lineHeight
        }}
        data-editor-input={terminal ? 'terminal' : 'editor'}
        aria-label={terminal ? t('Terminal input') : t('Neovim input')}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        wrap="off"
        {...inputHandlers}
      />
    </div>
  );
}
