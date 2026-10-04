import { useEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../grid';
import { ScrollQueue, scrollOffset } from '../scroll';

interface UseEditorRenderingOptions {
    backgroundOpacity: number;
    animations: boolean;
    smoothCursor: boolean;
    smoothBlink: boolean;
    pixelScroll: boolean;
    id: string;
    fontSize: number;
    lineHeight: number;
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
    afterPaintRef: RefObject<(motionOffset: number) => void>;
    scrollRef: RefObject<(lines: number, follow: boolean) => void>;
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
    lineHeight,
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
        const scrollQueue = new ScrollQueue();
        let prefetchNeeded = true;
        let prefetchPending = false;
        let preparingMotion = false;
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
            scrollQueue.cancelQueued();
            grid.scrollPreview = 0;
            schedule();
        };

        const finishScroll = (): void => {
            if (!scrollQueue.finish()) {
                return;
            }
            if (scrollQueue.hasQueued || prefetchNeeded) {
                schedule();
            }
        };

        const flushScroll = (): void => {
            if (prefetchPending || !scrollEnabledRef.current) {
                return;
            }
            const command = scrollQueue.start();
            if (!command) {
                return;
            }
            scrollCompletionRef.current = window.nido
                .scroll(id, command.lines, command.follow, true)
                .catch((error) => {
                    if (disposed) {
                        return;
                    }
                    scrollQueue.fail();
                    grid.scrollPreview = 0;
                    errorRef.current(String(error));
                    schedule();
                })
                .finally(() => {
                    if (disposed) {
                        return;
                    }
                    scrollQueue.complete();
                    finishScroll();
                });
        };

        scrollRef.current = (lines, follow): void => {
            scrollQueue.enqueue(lines, follow);
            directScroll = true;
            motion = undefined;
            grid.scrollPreview = scrollQueue.preview;
            if (lines < 0 && !prefetchPending && grid.needsUpperRows) {
                prefetchNeeded = true;
            }
            schedule();
        };

        const render = (): void => {
            frame = 0;
            if (disposed) {
                return;
            }
            if (!scrollEnabledRef.current) {
                scrollQueue.cancelQueued();
                grid.scrollPreview = 0;
            }
            if (!element.clientWidth || !element.clientHeight) {
                return;
            }
            const focused = document.activeElement === input;
            if (
                pixelScroll &&
                prefetchNeeded &&
                (scrollQueue.hasQueued || directScroll) &&
                !prefetchPending &&
                !scrollQueue.pending &&
                !motion &&
                !preparingMotion &&
                scrollEnabledRef.current &&
                grid.rows > 0 &&
                attachedRef.current
            ) {
                prefetchNeeded = false;
                prefetchPending = true;
                scrollCompletionRef.current = window.nido
                    .prefetchScroll(id)
                    .catch((error) => {
                        if (!disposed) {
                            errorRef.current(String(error));
                        }
                    })
                    .finally(() => {
                        if (disposed) {
                            return;
                        }
                        prefetchPending = false;
                        if (scrollQueue.hasQueued) {
                            schedule();
                        }
                    });
            }
            flushScroll();
            const target = grid.scrollCursor ?? grid.cursor;
            const now = performance.now();
            if (blinkFade) {
                const progress = canBlink() ? Math.min(1, (now - blinkFade.start) / 180) : 1;
                const eased = progress * progress * (3 - 2 * progress);
                grid.cursorOpacity = canBlink()
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
            const metrics = grid.draw(
                surface,
                element.clientWidth,
                element.clientHeight,
                fontSize,
                fontFamily,
                focused,
                cursorPosition,
                lineHeight
            );
            cellWidth = metrics.cellWidth;

            let overlayOffset = 0;

            if (motion) {
                if (motion.incomingRows) {
                    const height = grid.rowTop(motion.bottom) - grid.rowTop(motion.top);
                    const distance =
                        grid.rowTop(motion.top) - grid.rowTop(motion.top + motion.incomingRows);
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
                    overlayOffset = offset;
                    if (
                        targetFrame.width !== surface.width ||
                        targetFrame.height !== surface.height
                    ) {
                        targetFrame.width = surface.width;
                        targetFrame.height = surface.height;
                    }
                    const targetContext = targetFrame.getContext('2d')!;
                    targetContext.globalCompositeOperation = 'copy';
                    targetContext.drawImage(surface, 0, 0);
                    const ctx = surface.getContext('2d')!;
                    const dpr = window.devicePixelRatio || 1;
                    const top = grid.rowY(motion.top);
                    const height = Math.min(
                        grid.contentHeight - top,
                        grid.rowTop(motion.bottom) - grid.rowTop(motion.top)
                    );
                    const left = motion.left * metrics.cellWidth;
                    const width = (motion.right - motion.left) * metrics.cellWidth;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(left, top, width, height);
                    ctx.clip();
                    grid.paintBackground(ctx, left, top, width, height);
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
                        ctx.save();
                        if (backgroundOpacity < 1) {
                            // Copy only this layer's destination; translucent overlap must not double text or tint.
                            ctx.beginPath();
                            ctx.rect(left + shiftX, top + shift, width, height);
                            ctx.clip();
                            ctx.globalCompositeOperation = 'copy';
                        }
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
                        ctx.restore();
                    }
                    ctx.restore();
                }
            }

            afterPaintRef.current(overlayOffset);
            if (descriptionDirty) {
                surface.setAttribute(
                    'aria-description',
                    grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
                );
                descriptionDirty = false;
            }

            if (inputRef.current) {
                inputRef.current.style.left = `${grid.cursor.column * metrics.cellWidth}px`;
                inputRef.current.style.top = `${grid.rowY(grid.cursor.row)}px`;
            }

            const columns = Math.max(20, Math.floor(element.clientWidth / metrics.cellWidth));
            // Compact lenses free space for code; keep one extra row for fractional scrolling.
            const rows =
                Math.max(4, Math.floor(element.clientHeight / metrics.cellHeight)) +
                grid.extraRows +
                (pixelScroll ? 1 : 0);
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
                cursorMotion ||
                motion ||
                blinkFade ||
                (pixelScroll &&
                    prefetchNeeded &&
                    (scrollQueue.hasQueued || directScroll) &&
                    !prefetchPending &&
                    !scrollQueue.pending &&
                    scrollEnabledRef.current)
            ) {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(render);
            }
        };

        const schedule = (): void => {
            if (!disposed && !frame) {
                frame = requestAnimationFrame(render);
            }
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
                    from: grid.cursorOpacity,
                    to: grid.cursorOpacity > 0.5 ? 0 : 1,
                    start: performance.now()
                };
            } else {
                grid.cursorVisible = !grid.cursorVisible;
            }
            schedule();
            blinkTimer = setTimeout(blink, 550);
        };

        const resetBlink = (): void => {
            clearTimeout(blinkTimer);
            grid.cursorVisible = true;
            grid.cursorOpacity = 1;
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
                    if (directScroll && scrollQueue.pending) {
                        scrollQueue.acknowledge();
                        grid.scrollPreview = scrollQueue.preview;
                    } else if (!directScroll && !scrollQueue.pending) {
                        scrollQueue.cancelQueued();
                        grid.scrollPreview = 0;
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

                const { row, column } = grid.cursor;
                const mode = grid.mode;
                if (grid.apply(event.events)) {
                    if (
                        !prefetchPending &&
                        (event.events.some(
                            ([name]) => name === 'grid_clear' || name === 'grid_resize'
                        ) ||
                            (!grid.hasUpperRows &&
                                grid.needsUpperRows &&
                                event.events.some(
                                    ([name]) => name === 'nido_scroll' || name === 'grid_scroll'
                                )) ||
                            (directScroll && scroll && scroll[5] < 0 && grid.needsUpperRows))
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
                    row !== grid.cursor.row ||
                    column !== grid.cursor.column ||
                    mode !== grid.mode
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
            paintRef.current = () => {};
            scrollRef.current = () => {};
            grid.scrollPreview = 0;
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
    }, [
        backgroundOpacity,
        id,
        fontSize,
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
