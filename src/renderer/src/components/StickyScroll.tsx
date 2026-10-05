import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StickyScrollState } from '../../../shared/types';
import type { Grid } from '../grid';
import { stickyRows, type StickyRow } from '../stickyScroll';
import styles from '../assets/StickyScroll.module.css';

interface Model {
    state: StickyScrollState;
    rows: StickyRow[];
    top: number;
    left: number;
    width: number;
    lineHeight: number;
    cellWidth: number;
    background: string;
}

export default function StickyScroll({
    id,
    grid,
    paintRef,
    input,
    scrollCompletion,
    maxLines,
    fontSize,
    fontFamily,
    onError
}: {
    id: string;
    grid: RefObject<Grid>;
    paintRef: RefObject<(motionOffset: number) => void>;
    input: RefObject<HTMLTextAreaElement | null>;
    scrollCompletion: RefObject<Promise<void>>;
    maxLines: number;
    fontSize: number;
    fontFamily: string;
    onError: (message: string) => void;
}): React.JSX.Element | null {
    const t = useI18n();
    const [model, setModel] = useState<Model>();
    const [peek, setPeek] = useState<number>();
    const hovered = useRef<number>(undefined);
    useEffect(() => {
        const keyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Shift') {
                setPeek(hovered.current);
            }
        };
        const keyUp = (event: KeyboardEvent): void => {
            if (event.key === 'Shift') {
                setPeek(undefined);
            }
        };
        const blur = (): void => setPeek(undefined);
        window.addEventListener('keydown', keyDown);
        window.addEventListener('keyup', keyUp);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', keyDown);
            window.removeEventListener('keyup', keyUp);
            window.removeEventListener('blur', blur);
        };
    }, []);
    useLayoutEffect(() => {
        const update = (motionOffset: number): void => {
            const surface = grid.current;
            const state = surface.stickyScroll;
            if (!state || !surface.cellHeight) {
                setModel(undefined);
                return;
            }
            const top = surface.rowTop(state.top);
            const rows = stickyRows(
                state,
                (row) => surface.rowY(row),
                top,
                surface.cellHeight,
                maxLines,
                motionOffset
            );
            const next: Model | undefined = rows.length
                ? {
                      state,
                      rows,
                      top,
                      left: state.left * surface.cellWidth,
                      width: state.width * surface.cellWidth,
                      lineHeight: surface.cellHeight,
                      cellWidth: surface.cellWidth,
                      background: surface.background
                  }
                : undefined;
            setModel((previous) => {
                if (
                    previous &&
                    next &&
                    previous.state === next.state &&
                    previous.top === next.top &&
                    previous.width === next.width &&
                    previous.left === next.left &&
                    previous.cellWidth === next.cellWidth &&
                    previous.lineHeight === next.lineHeight &&
                    previous.background === next.background &&
                    previous.rows.length === next.rows.length &&
                    previous.rows.every(
                        (row, index) =>
                            row.scope === next.rows[index].scope &&
                            row.offset === next.rows[index].offset
                    )
                ) {
                    return previous;
                }
                return next;
            });
        };
        paintRef.current = update;
        const frame = requestAnimationFrame(() => update(0));
        return () => {
            cancelAnimationFrame(frame);
            paintRef.current = () => {};
        };
    }, [grid, paintRef, maxLines]);

    if (!model) {
        return null;
    }
    const jump = (scope: StickyRow['scope'], ending: boolean): void => {
        const state = model.state;
        void (async () => {
            await scrollCompletion.current;
            await window.nido.jumpSticky(
                id,
                state.window,
                state.buffer,
                ending ? scope.ending : scope.line
            );
            input.current?.focus();
        })().catch((error) => onError(String(error)));
    };
    const lastOffset = model.rows.at(-1)?.offset ?? 0;
    return (
        <div
            className={styles.sticky}
            data-sticky-scroll={id}
            role="navigation"
            aria-label={t('Sticky Scroll')}
            style={{
                top: model.top,
                left: model.left,
                width: model.width,
                height: model.rows.length * model.lineHeight + lastOffset,
                background: model.background,
                fontSize,
                fontFamily,
                lineHeight: `${model.lineHeight}px`,
                tabSize: model.state.tabstop
            }}
            onKeyDown={(event) => {
                const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
                ];
                const index = buttons.indexOf(event.target as HTMLButtonElement);
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    input.current?.focus();
                } else if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const next =
                        event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? buttons.length - 1
                              : Math.max(
                                    0,
                                    Math.min(
                                        buttons.length - 1,
                                        index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1)
                                    )
                                );
                    buttons[next]?.focus();
                }
            }}
        >
            {model.rows.map(({ scope, offset }, index) => {
                const ending = peek === scope.line;
                return (
                    <div
                        key={scope.line}
                        className={styles.row}
                        style={{ top: index * model.lineHeight, height: model.lineHeight }}
                    >
                        <button
                            type="button"
                            style={{
                                height: model.lineHeight,
                                transform: `translateY(${offset}px)`
                            }}
                            data-source-line={scope.line}
                            aria-label={t('Go to line {line}', {
                                line: ending ? scope.ending : scope.line
                            })}
                            title={t(
                                'Jump to this scope · Shift: ending line · Alt+Shift+S: focus headers'
                            )}
                            onPointerEnter={(event) => {
                                hovered.current = scope.line;
                                setPeek(event.shiftKey ? scope.line : undefined);
                            }}
                            onPointerMove={(event) =>
                                setPeek(event.shiftKey ? scope.line : undefined)
                            }
                            onPointerLeave={() => {
                                hovered.current = undefined;
                                setPeek(undefined);
                            }}
                            onClick={(event) => jump(scope, event.shiftKey)}
                        >
                            <span
                                className={styles.number}
                                style={{
                                    width: model.state.gutter * model.cellWidth,
                                    paddingRight: model.cellWidth
                                }}
                            >
                                {ending ? scope.ending : scope.line}
                            </span>
                            <span className={styles.code}>
                                <span
                                    style={{
                                        transform: `translateX(${-model.state.leftcol * model.cellWidth}px)`
                                    }}
                                >
                                    {(ending ? scope.endText : scope.text).map((span, i) => (
                                        <span key={i} style={{ color: span.color }}>
                                            {span.text}
                                        </span>
                                    ))}
                                </span>
                            </span>
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
