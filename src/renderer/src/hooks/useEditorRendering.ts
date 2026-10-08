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
            enabled: () => scrollEnabledRef.current,
            schedule: () => schedule(),
            onError: (error) => errorRef.current(String(error)),
            onCompletion: (promise) => {
                scrollCompletionRef.current = promise;
            }
        });
        const previousFrame = document.createElement('canvas');
        const targetFrame = document.createElement('canvas');
        let motion: FrameMotion | undefined;

        const stopMotion = (): void => {
            motion = undefined;
            scrolling.stop();
        };

        scrollRef.current = (lines, follow): void => {
            directScroll = true;
            motion = undefined;
            scrolling.request(lines, follow);
        };

        const render = (): void => {
            frame = 0;
            if (disposed) {
                return;
            }
            scrolling.pauseIfDisabled();
            if (!element.clientWidth || !element.clientHeight) {
                return;
            }
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
            const now = performance.now();
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
            const metrics = grid.draw(
                surface,
                bounds.width,
                bounds.height,
                fontSize,
                fontFamily,
                focused,
                cursorPosition,
                lineHeight
            );
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
                backgroundOpacity
            });
            motion = painted.motion;
            const overlayOffset = painted.overlayOffset;

            afterPaintRef.current(overlayOffset);
            if (descriptionDirty) {
                surface.setAttribute(
                    'aria-description',
                    grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n')
                );
                descriptionDirty = false;
            }

            if (inputRef.current && !inputRef.current.hasAttribute('data-nvim-command-active')) {
                inputRef.current.style.left = `${bounds.left + grid.cursor.column * metrics.cellWidth}px`;
                inputRef.current.style.top = `${bounds.top + grid.rowY(grid.cursor.row)}px`;
            }
            if (hasFrame && !ready) {
                ready = true;
                onReady?.(id);
            }

            const columns = Math.max(20, Math.floor(bounds.width / metrics.cellWidth));
            // Compact lenses free space for code; keep one extra row for fractional scrolling.
            const rows =
                Math.max(4, Math.floor(bounds.height / metrics.cellHeight)) +
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
            if (cursor.animating || motion || (pixelScroll && scrolling.canPrefetch)) {
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
                    scrolling.acknowledge(directScroll);
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
                    cursor.resetPosition();
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
                    hasFrame = grid.rows > 0 && grid.columns > 0;
                    descriptionDirty ||= !ready;
                    if (
                        !scrolling.prefetchPending &&
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
                        scrolling.invalidatePrefetch();
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
            input.removeEventListener('keydown', stopMotion);
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
