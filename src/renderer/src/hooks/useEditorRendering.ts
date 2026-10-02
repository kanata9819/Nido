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
    scrollRef: RefObject<(lines: number, follow: boolean) => void>;
    scrollCompletionRef: RefObject<Promise<void>>;
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
    }, [active, blocked]);
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
        let descriptionDirty = true;
        let queuedScroll = 0;
        let sentScroll = 0;
        let scrollPending = false;
        let scrollAcknowledged = false;
        let scrollCompleted = false;
        let prefetchNeeded = true;
        let prefetchPending = false;
        let preparingMotion = false;
        let scrollFollow = true;
        let lastColumns = 0;
        let lastRows = 0;
        let cellWidth = 0;
        let cursorPosition: { row: number; column: number } | undefined;
        let cursorMotion:
            | {
                  from: { row: number; column: number };
                  to: { row: number; column: number };
                  start: number;
              }
            | undefined;
        let blinkTimer: ReturnType<typeof setTimeout> | undefined;
        let blinkFade: { from: number; to: number; start: number } | undefined;
        const input = inputRef.current!;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const previousFrame = document.createElement('canvas');
        const targetFrame = document.createElement('canvas');
        let motion:
            | {
                  top: number;
                  bottom: number;
                  left: number;
                  right: number;
                  distance: number;
                  distanceX: number;
                  incomingRows: number;
                  start: number;
                  edit: boolean;
              }
            | undefined;

        const stopMotion = (): void => {
            motion = undefined;
            queuedScroll = 0;
            gridRef.current.scrollPreview = 0;
            schedule();
        };

        const finishScroll = (): void => {
            // Invoke replies and redraw notifications can arrive in different turns.
            if (!scrollPending || !scrollAcknowledged || !scrollCompleted) return;
            scrollPending = false;
            if (!disposed && (queuedScroll || prefetchNeeded)) schedule();
        };

        const flushScroll = (): void => {
            if (scrollPending || prefetchPending || !queuedScroll || !scrollEnabledRef.current)
                return;
            sentScroll = Math.max(-1000, Math.min(1000, queuedScroll));
            queuedScroll -= sentScroll;
            scrollPending = true;
            scrollAcknowledged = scrollCompleted = false;
            scrollCompletionRef.current = window.nido
                .scroll(id, sentScroll, scrollFollow, true)
                .catch((error) => {
                    scrollAcknowledged = true;
                    sentScroll = queuedScroll = 0;
                    gridRef.current.scrollPreview = 0;
                    if (!disposed) {
                        errorRef.current(String(error));
                        schedule();
                    }
                })
                .finally(() => {
                    scrollCompleted = true;
                    finishScroll();
                });
        };

        scrollRef.current = (lines, follow): void => {
            if (lines < 0 && !prefetchPending && gridRef.current.needsUpperRows)
                prefetchNeeded = true;
            queuedScroll += lines;
            scrollFollow = follow;
            directScroll = true;
            motion = undefined;
            gridRef.current.scrollPreview = queuedScroll + sentScroll;
            schedule();
        };

        const render = (): void => {
            frame = 0;
            if (!scrollEnabledRef.current) {
                queuedScroll = 0;
                gridRef.current.scrollPreview = 0;
            }
            if (disposed || !element.clientWidth || !element.clientHeight) {
                return;
            }
            const focused = document.activeElement === input;
            if (
                pixelScroll &&
                prefetchNeeded &&
                (queuedScroll !== 0 || directScroll) &&
                !prefetchPending &&
                !scrollPending &&
                !motion &&
                !preparingMotion &&
                scrollEnabledRef.current &&
                gridRef.current.rows > 0 &&
                attachedRef.current
            ) {
                prefetchNeeded = false;
                prefetchPending = true;
                scrollCompletionRef.current = window.nido
                    .prefetchScroll(id)
                    .catch((error) => {
                        if (!disposed) errorRef.current(String(error));
                    })
                    .finally(() => {
                        prefetchPending = false;
                        if (!disposed && queuedScroll) schedule();
                    });
            }
            flushScroll();
            const target = gridRef.current.scrollCursor ?? gridRef.current.cursor;
            const now = performance.now();
            if (blinkFade) {
                const progress = canBlink() ? Math.min(1, (now - blinkFade.start) / 180) : 1;
                const eased = progress * progress * (3 - 2 * progress);
                gridRef.current.cursorOpacity = canBlink()
                    ? blinkFade.from + (blinkFade.to - blinkFade.from) * eased
                    : 1;
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
                        row:
                            cursorMotion.from.row +
                            (cursorMotion.to.row - cursorMotion.from.row) * eased,
                        column:
                            cursorMotion.from.column +
                            (cursorMotion.to.column - cursorMotion.from.column) * eased
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
                if (motion.incomingRows) {
                    const height =
                        gridRef.current.rowTop(motion.bottom) - gridRef.current.rowTop(motion.top);
                    const distance =
                        gridRef.current.rowTop(motion.top) -
                        gridRef.current.rowTop(motion.top + motion.incomingRows);
                    motion.distance = Math.max(
                        -height,
                        Math.min(height, distance + motion.distance)
                    );
                    motion.incomingRows = 0;
                }
                const elapsed = (performance.now() - motion.start) * (motion.edit ? 120 / 90 : 1);
                const offset = scrollOffset(motion.distance, elapsed);
                const offsetX = scrollOffset(motion.distanceX, elapsed);
                if (
                    (Math.abs(offset) < 0.25 && Math.abs(offsetX) < 0.25) ||
                    reducedMotion.matches ||
                    !animationsRef.current ||
                    previousFrame.width !== surface.width ||
                    previousFrame.height !== surface.height
                ) {
                    motion = undefined;
                } else {
                    if (
                        targetFrame.width !== surface.width ||
                        targetFrame.height !== surface.height
                    ) {
                        targetFrame.width = surface.width;
                        targetFrame.height = surface.height;
                    }
                    targetFrame.getContext('2d')!.drawImage(surface, 0, 0);
                    const ctx = surface.getContext('2d')!;
                    const dpr = window.devicePixelRatio || 1;
                    const top = gridRef.current.rowY(motion.top);
                    const height = Math.min(
                        gridRef.current.contentHeight - top,
                        gridRef.current.rowTop(motion.bottom) - gridRef.current.rowTop(motion.top)
                    );
                    const left = motion.left * metrics.cellWidth;
                    const width = (motion.right - motion.left) * metrics.cellWidth;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(left, top, width, height);
                    ctx.clip();
                    ctx.fillStyle = gridRef.current.background;
                    ctx.fillRect(left, top, width, height);
                    // Deleted rows disappear; the remaining rows slide into the gap without an old-frame overlay.
                    const layers = [
                        ...(motion.edit
                            ? []
                            : [
                                  [
                                      previousFrame,
                                      offset - motion.distance,
                                      offsetX - motion.distanceX
                                  ] as const
                              ]),
                        [targetFrame, offset, offsetX]
                    ] as const;
                    for (const [image, shift, shiftX] of layers) {
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

            if (descriptionDirty) {
                surface.setAttribute(
                    'aria-description',
                    gridRef.current.cells
                        .map((row) => row.map((cell) => cell.text).join(''))
                        .join('\n')
                );
                descriptionDirty = false;
            }

            if (inputRef.current) {
                inputRef.current.style.left = `${gridRef.current.cursor.column * metrics.cellWidth}px`;
                inputRef.current.style.top = `${gridRef.current.rowY(gridRef.current.cursor.row)}px`;
            }

            const columns = Math.max(20, Math.floor(element.clientWidth / metrics.cellWidth));
            // Compact lenses free space for code; keep one extra row for fractional scrolling.
            const rows =
                Math.max(4, Math.floor(element.clientHeight / metrics.cellHeight)) +
                gridRef.current.extraRows +
                (pixelScroll ? 1 : 0);
            if (!attachedRef.current) {
                attachedRef.current = true;
                lastColumns = columns;
                lastRows = rows;
                void window.nido
                    .attach(id, columns, rows)
                    .catch((e) => errorRef.current(String(e)));
            } else if (columns !== lastColumns || rows !== lastRows) {
                lastColumns = columns;
                lastRows = rows;
                void window.nido
                    .resize(id, columns, rows)
                    .catch((e) => errorRef.current(String(e)));
            }
            if (
                cursorMotion ||
                motion ||
                blinkFade ||
                (pixelScroll &&
                    prefetchNeeded &&
                    (queuedScroll !== 0 || directScroll) &&
                    !prefetchPending &&
                    !scrollPending &&
                    scrollEnabledRef.current)
            ) {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(render);
            }
        };

        const schedule = (): void => {
            if (!frame) frame = requestAnimationFrame(render);
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
                // Editing can shift grid rows without scrolling the viewport.
                const edited = event.events.some(([name]) => name === 'nido_edit');
                if (edited) stopMotion();
                const pixelOffsets = event.events.flatMap(([name, ...calls]) =>
                    name === 'nido_pixel_scroll' ? calls : []
                );
                for (const args of pixelOffsets) {
                    gridRef.current.scrollFraction = Number(args[0]);
                    gridRef.current.scrollCursor = args[2] as
                        { row: number; column: number } | undefined;
                    directScroll = args[1] === true;
                    if (directScroll && scrollPending) {
                        scrollAcknowledged = true;
                        // The returned rows already include the one outstanding request.
                        sentScroll = 0;
                        gridRef.current.scrollPreview = queuedScroll;
                    } else if (!directScroll && !scrollPending) {
                        queuedScroll = 0;
                        gridRef.current.scrollPreview = 0;
                    }
                }
                const viewportScrolls = event.events.flatMap(([name, ...calls]) =>
                    name === 'nido_scroll' ? calls : []
                );
                const scrolls = viewportScrolls.length
                    ? viewportScrolls
                    : event.events.flatMap(([name, ...calls]) =>
                          name === 'grid_scroll' ? calls : []
                      );
                const scroll = scrolls.length === 1 ? (scrolls[0] as number[]) : undefined;
                if (
                    scrolls.length ||
                    event.events.some(
                        ([name]) =>
                            name === 'grid_resize' ||
                            name === 'grid_clear' ||
                            name === 'mode_change'
                    )
                ) {
                    cursorPosition = undefined;
                    cursorMotion = undefined;
                }
                const now = performance.now();
                if (
                    scroll &&
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
                        ? scrollOffset(motion.distance, now - motion.start)
                        : 0;
                    const remainingX = motion
                        ? scrollOffset(motion.distanceX, now - motion.start)
                        : 0;
                    cancelAnimationFrame(frame);
                    preparingMotion = true;
                    render();
                    preparingMotion = false;
                    if (
                        previousFrame.width !== surface.width ||
                        previousFrame.height !== surface.height
                    ) {
                        previousFrame.width = surface.width;
                        previousFrame.height = surface.height;
                    }
                    previousFrame.getContext('2d')!.drawImage(surface, 0, 0);
                    const height =
                        gridRef.current.rowTop(scroll[2]) - gridRef.current.rowTop(scroll[1]);
                    const distance =
                        gridRef.current.rowTop(scroll[1] + scroll[5]) -
                        gridRef.current.rowTop(scroll[1]);
                    const width = (scroll[4] - scroll[3]) * cellWidth;
                    motion = {
                        top: scroll[1],
                        bottom: scroll[2],
                        left: scroll[3],
                        right: scroll[4],
                        // Large jumps use at most one viewport so the animation never exposes an empty gap.
                        distance:
                            scroll[5] < 0
                                ? remaining
                                : Math.max(-height, Math.min(height, distance + remaining)),
                        incomingRows: Math.max(0, -scroll[5]),
                        distanceX:
                            scroll[5] === 0
                                ? Math.max(
                                      -width,
                                      Math.min(width, scroll[6] * cellWidth + remainingX)
                                  )
                                : 0,
                        start: now,
                        edit: edited
                    };
                } else if (scrolls.length || directScroll) {
                    motion = undefined;
                }

                const { row, column } = gridRef.current.cursor;
                const mode = gridRef.current.mode;
                if (gridRef.current.apply(event.events)) {
                    if (
                        !prefetchPending &&
                        (event.events.some(
                            ([name]) => name === 'grid_clear' || name === 'grid_resize'
                        ) ||
                            (!gridRef.current.hasUpperRows &&
                                event.events.some(
                                    ([name]) => name === 'nido_scroll' || name === 'grid_scroll'
                                )) ||
                            (directScroll &&
                                scroll &&
                                scroll[5] < 0 &&
                                gridRef.current.needsUpperRows))
                    ) {
                        prefetchNeeded = true;
                    }
                    descriptionDirty ||= event.events.some(
                        ([name]) =>
                            name === 'grid_line' ||
                            name === 'grid_scroll' ||
                            name === 'grid_resize' ||
                            name === 'grid_clear'
                    );
                    schedule();
                }

                if (
                    row !== gridRef.current.cursor.row ||
                    column !== gridRef.current.cursor.column ||
                    mode !== gridRef.current.mode
                ) {
                    resetBlink();
                }
                finishScroll();
            }
        });

        const observer = new ResizeObserver(stopMotion);
        observer.observe(element);
        resetBlink();

        return () => {
            disposed = true;
            scrollRef.current = () => {};
            gridRef.current.scrollPreview = 0;
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
