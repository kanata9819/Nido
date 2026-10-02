import { useEffect, useRef, type ReactNode } from 'react';
import { Grid } from './grid';
import { accumulateScroll } from './scroll';
import { useEditorRendering } from './hooks/useEditorRendering';
import { useEditorInput } from './hooks/useEditorInput';
import styles from './assets/Nido.module.css';
import TypeInformation from './components/TypeInformation';
import CompletionMenu from './components/CompletionMenu';

interface Props {
    scrollFollowCursor?: boolean;
    terminal?: boolean;
    children?: ReactNode;
    id: string;
    active: boolean;
    fontSize: number;
    lineHeight: number;
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
    terminal = false,
    children,
    id,
    active,
    fontSize,
    lineHeight,
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
    const paint = useRef<() => void>(() => {});
    const scroll = useRef<(lines: number, follow: boolean) => void>(() => {});
    const scrollCompletion = useRef<Promise<void>>(Promise.resolve());
    const error = useRef(onError);

    useEffect(() => {
        wheel.current = { remainder: 0, time: 0 };
    }, [active, blocked, lineHeight]);

    useEffect(() => {
        error.current = onError;
    }, [onError]);

    useEditorRendering({
        animations,
        smoothCursor,
        smoothBlink,
        id,
        fontSize,
        lineHeight,
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
        scrollRef: scroll,
        scrollCompletionRef: scrollCompletion,
        fontFamily: fontFamily,
        pixelScroll: !terminal
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
                const y = event.clientY - bounds.top;
                if (x < 0 || x >= columns * cellWidth) {
                    return;
                }
                send(
                    (async () => {
                        await scrollCompletion.current;
                        await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => resolve())
                        );
                        if (!host.current) {
                            return;
                        }
                        const row = grid.current.rowAt(y);
                        if (row >= 0) {
                            await window.nido.click(id, row, Math.floor(x / cellWidth));
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
                    (event.target as Element).closest('[data-type-information]')
                ) {
                    return;
                }

                if (!terminal) {
                    const height = lineHeight;
                    const pixels =
                        event.deltaY *
                        (event.deltaMode === 1
                            ? height
                            : event.deltaMode === 2
                              ? event.currentTarget.clientHeight
                              : 1);
                    if (Number.isFinite(pixels) && pixels) {
                        scroll.current(pixels / height, scrollFollowCursor);
                    }
                    return;
                }

                const now = performance.now();
                const result = accumulateScroll(
                    now - wheel.current.time > 200 ? 0 : wheel.current.remainder,
                    event.deltaY,
                    event.deltaMode,
                    lineHeight,
                    event.currentTarget.clientHeight
                );

                wheel.current = { remainder: result.remainder, time: now };
                if (result.lines) {
                    send(
                        window.nido.scroll(
                            id,
                            Math.max(-1000, Math.min(1000, result.lines)),
                            terminal || scrollFollowCursor
                        )
                    );
                }
            }}
        >
            <canvas
                ref={canvas}
                className={styles.canvas}
                aria-label={terminal ? 'Terminal display' : 'Neovim editor display'}
            />
            {children}
            {!terminal && (
                <CompletionMenu
                    id={id}
                    grid={grid}
                    input={input}
                    fontFamily={fontFamily}
                    onError={onError}
                    hidden={blocked}
                />
            )}
            {active && !blocked && !terminal && (
                <TypeInformation id={id} input={input} fontFamily={fontFamily} />
            )}
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
