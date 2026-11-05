import type { RefObject } from 'react';
import type { NidoEvent } from '../../shared/types';
import type { Grid } from './grid';
import { scrollOffset } from './scroll';
import { EditorScroll } from './editorScroll';
import { alignCanvasSurface } from './canvasSurface';
import { positionEditorInput } from './editorInputPosition';
import { createEditorResizer } from './editorResizer';
import { EditorCursor } from './editorCursor';
import { paintEditorMotion, type FrameMotion } from './editorMotion';
import {
	editorGridSize,
	horizontalMotion,
	isAnimatableScroll,
	isHorizontalStep,
	scrollMotion,
	summarizeRedraw
} from './editorRedraw';

type Redraw = Extract<NidoEvent, { type: 'redraw' }>;
type RedrawSummary = ReturnType<typeof summarizeRedraw>;
type Scroll = NonNullable<RedrawSummary['scroll']>;

export interface EditorRendererOptions {
	id: string;
	grid: Grid;
	host: HTMLDivElement;
	surface: HTMLCanvasElement;
	input: HTMLTextAreaElement;
	backgroundOpacity: number;
	pixelScroll: boolean;
	smoothBlink: boolean;
	fontSize: number;
	fontFamily: string;
	fontWeight: number;
	lineHeight: number;
	onReady?: (id: string) => void;
	/** Settings that can change without replacing the renderer. */
	animationsRef: RefObject<boolean>;
	smoothCursorRef: RefObject<boolean>;
	scrollEnabledRef: RefObject<boolean>;
	errorRef: RefObject<(message: string) => void>;
	attachedRef: RefObject<boolean>;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	afterPaintRef: RefObject<(motionOffset: number) => void>;
	scrollCompletionRef: RefObject<Promise<void>>;
}

/**
 * Paints one editor's grid on its canvas, at most once per animation frame. It applies redraw
 * events from Neovim, animates scrolling and the cursor, and keeps Neovim's grid size in step
 * with the editor element. Settings fixed for its lifetime are in the options; changing them
 * creates a new renderer.
 */
export class EditorRenderer {
	private frame = 0;
	private disposed = false;
	/** The latest viewport move came from Nido's own scroll request rather than Neovim. */
	private directScroll = false;
	private descriptionDirty = true;
	private hasFrame: boolean;
	private ready = false;
	private preparingMotion = false;
	private cellWidth = 0;
	private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	private readonly cursor: EditorCursor;
	private readonly scrolling: EditorScroll;
	/** The frame before a scroll, and the frame it moves to, for viewport animations. */
	private readonly previousFrame = document.createElement('canvas');
	private readonly targetFrame = document.createElement('canvas');
	private motion?: FrameMotion;
	/** A scroll requested while horizontal alignment finishes, applied by the next frame. */
	private deferredScroll?: { lines: number; columns: number; follow: boolean; discrete: boolean };
	private lastScrollTime?: number;
	private metrics = { cellWidth: 0, cellHeight: 0 };
	private paintedFocus = false;
	private paintedCursorVisible = true;
	private paintedCursorOpacity = 1;
	private readonly resizer: ReturnType<typeof createEditorResizer>;
	private readonly observer: ResizeObserver;
	private resolution?: MediaQueryList;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly options: EditorRendererOptions,
		subscribe: (listener: (event: NidoEvent) => void) => () => void
	) {
		const { id, grid, host, input, smoothBlink, errorRef, attachedRef } = options;
		grid.backgroundOpacity = options.backgroundOpacity;
		grid.pixelScrollEnabled = options.pixelScroll;
		this.hasFrame = grid.rows > 0 && grid.columns > 0;
		this.cursor = new EditorCursor(grid, host, input, this.reducedMotion, smoothBlink, () =>
			this.schedule()
		);
		this.scrolling = new EditorScroll({
			id,
			grid,
			enabled: () => options.scrollEnabledRef.current && !host.hidden && !document.hidden,
			schedule: () => this.schedule(),
			onError: (error) => errorRef.current(String(error)),
			onCompletion: (promise) => {
				options.scrollCompletionRef.current = promise;
			}
		});
		this.scrolling.observeHorizontal(grid.horizontalColumn);
		this.resizer = createEditorResizer(id, attachedRef, errorRef, () => this.disposed);

		options.surface.addEventListener('pointerdown', this.pointerDown);
		this.cursor.listen();
		this.reducedMotion.addEventListener('change', this.stopMotion);
		input.addEventListener('keydown', this.keyDown);
		input.addEventListener('input', this.stopMotion);
		input.addEventListener('compositionstart', this.stopMotion);
		input.addEventListener('blur', this.pauseMotion);
		this.unsubscribe = subscribe((event) => {
			if (event.type === 'redraw' && event.id === id) {
				this.receiveRedraw(event);
			}
		});
		this.observer = new ResizeObserver(this.stopMotion);
		this.observer.observe(host);
		this.watchResolution();
		window.addEventListener('resize', this.stopMotion);
		this.cursor.resetBlink();
	}

	dispose(): void {
		const { grid, surface, input } = this.options;
		this.disposed = true;
		grid.scrollPreview = 0;
		grid.horizontalOffset = 0;
		grid.scrolling = false;
		this.cursor.dispose();
		this.scrolling.dispose();
		surface.removeEventListener('pointerdown', this.pointerDown);
		this.reducedMotion.removeEventListener('change', this.stopMotion);
		input.removeEventListener('keydown', this.keyDown);
		input.removeEventListener('input', this.stopMotion);
		input.removeEventListener('compositionstart', this.stopMotion);
		input.removeEventListener('blur', this.pauseMotion);
		this.observer.disconnect();
		this.resolution?.removeEventListener('change', this.resolutionChanged);
		window.removeEventListener('resize', this.stopMotion);
		this.unsubscribe();
		cancelAnimationFrame(this.frame);
	}

	/** Paint in the next animation frame, unless one is already scheduled. */
	schedule = (): void => {
		this.scrolling.pauseIfDisabled();
		if (!this.disposed && !this.frame && !this.options.host.hidden && !document.hidden) {
			this.frame = requestAnimationFrame(this.render);
		}
	};

	/** Scroll by lines and columns, animated unless animations are off. */
	scroll = (lines: number, follow: boolean, discrete: boolean, columns = 0): void => {
		const deferred = this.deferredScroll;
		if (deferred) {
			deferred.lines += lines;
			deferred.columns += columns;
			deferred.follow = follow;
			deferred.discrete ||= discrete;
			return;
		}
		// Finish horizontal lookahead before vertical movement replaces its cached frames.
		if (lines) {
			this.scrolling.finishHorizontalMotion();
		}
		if (lines && this.scrolling.alignHorizontal()) {
			this.deferredScroll = { lines, columns, follow, discrete };
			this.schedule();
			return;
		}
		this.directScroll = true;
		const duration = this.animate ? (discrete ? 120 : 40) : 0;
		if (lines) {
			this.motion = undefined;
			this.scrolling.stopHorizontal();
			this.scrolling.request(lines, follow, duration);
		}
		if (columns) {
			this.scrolling.requestHorizontal(columns, follow, !lines, duration);
		}
	};

	private get animate(): boolean {
		return this.options.animationsRef.current && !this.reducedMotion.matches;
	}

	private stopMotion = (): void => {
		this.deferredScroll = undefined;
		this.motion = undefined;
		this.lastScrollTime = undefined;
		this.scrolling.stop();
	};

	/** Like stopMotion, but a sideways scroll in progress keeps its frame. */
	private pauseMotion = (): void => {
		this.deferredScroll = undefined;
		this.lastScrollTime = undefined;
		if (this.motion?.offsetX === undefined) {
			this.motion = undefined;
		}
		this.scrolling.stop(true);
	};

	private keyDown = (event: KeyboardEvent): void => {
		if (
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey &&
			!event.shiftKey &&
			!event.isComposing &&
			['j', 'k'].includes(event.key) &&
			['normal', 'visual', 'visual_line', 'visual_block'].includes(this.options.grid.mode)
		) {
			// Navigation retargets the visible scroll instead of snapping it first.
			this.scrolling.stop();
		} else {
			this.stopMotion();
		}
	};

	private pointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) {
			return;
		}
		this.pauseMotion();
		this.cursor.resetBlink();
	};

	// Zoom and monitor changes can change DPR without resizing the editor host.
	private watchResolution(): void {
		this.resolution?.removeEventListener('change', this.resolutionChanged);
		this.resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		this.resolution.addEventListener('change', this.resolutionChanged);
	}

	private resolutionChanged = (): void => {
		this.watchResolution();
		this.stopMotion();
	};

	/** Paint one frame, and request another while anything is still animating. */
	private render = (): void => {
		const { id, grid, host, surface, input, pixelScroll, onReady } = this.options;
		this.frame = 0;
		if (this.disposed || host.hidden || document.hidden) {
			return;
		}
		this.scrolling.pauseIfDisabled();
		if (!this.options.scrollEnabledRef.current) {
			this.deferredScroll = undefined;
		}
		if (!host.clientWidth || !host.clientHeight) {
			return;
		}
		const now = performance.now();
		this.advanceScrolling(now);
		const focused = document.activeElement === input;
		const cursorPosition = this.cursor.update(
			now,
			this.options.smoothCursorRef.current,
			this.directScroll || !!this.motion,
			focused
		);
		const dpr = window.devicePixelRatio || 1;
		const bounds = alignCanvasSurface(surface, host, dpr);
		grid.surfaceLeft = bounds.left;
		grid.surfaceTop = bounds.top;
		const reuseTarget = this.canReuseTarget(bounds, dpr, focused);
		if (!reuseTarget) {
			this.metrics = grid.draw(
				surface,
				bounds.width,
				bounds.height,
				this.options.fontSize,
				this.options.fontFamily,
				focused,
				cursorPosition,
				this.options.lineHeight,
				this.options.fontWeight
			);
			this.paintedFocus = focused;
			this.paintedCursorVisible = grid.cursorVisible;
			this.paintedCursorOpacity = grid.cursorOpacity;
		}
		this.cellWidth = this.metrics.cellWidth;
		this.paintMotion(dpr, reuseTarget);
		this.updateDescription();
		positionEditorInput(
			this.options.inputRef.current,
			bounds,
			grid,
			this.metrics.cellWidth,
			dpr
		);
		if (this.hasFrame && !this.ready) {
			this.ready = true;
			onReady?.(id);
		}
		const size = editorGridSize(bounds, this.metrics, pixelScroll, grid.extraRows);
		this.resizer.update(size.columns, size.rows);
		if (
			this.cursor.animating ||
			(this.motion && this.motion.offsetX === undefined) ||
			this.scrolling.animating ||
			this.deferredScroll ||
			(pixelScroll && this.scrolling.canPrefetch)
		) {
			cancelAnimationFrame(this.frame);
			this.frame = requestAnimationFrame(this.render);
		}
	};

	/** Apply a deferred scroll, step scroll animations, and prefetch rows past the viewport. */
	private advanceScrolling(now: number): void {
		const { grid, pixelScroll, attachedRef } = this.options;
		if (this.deferredScroll && !this.scrolling.alignHorizontal()) {
			const request = this.deferredScroll;
			this.deferredScroll = undefined;
			this.scroll(request.lines, request.follow, request.discrete, request.columns);
		}
		this.scrolling.advance(now, this.animate);
		if (this.motion?.offsetX !== undefined) {
			this.motion.offsetX = this.scrolling.horizontalOffset * this.cellWidth;
		}
		if (
			pixelScroll &&
			this.scrolling.canPrefetch &&
			!this.motion &&
			!this.preparingMotion &&
			grid.rows > 0 &&
			attachedRef.current
		) {
			this.scrolling.prefetch();
		}
		this.scrolling.flush();
	}

	/** A prepared animation target can be shown again when nothing it depends on changed. */
	private canReuseTarget(
		bounds: { width: number; height: number },
		dpr: number,
		focused: boolean
	): boolean {
		const { grid } = this.options;
		return !!(
			this.motion?.targetReady &&
			this.metrics.cellWidth &&
			(this.motion?.offsetX !== undefined || this.animate) &&
			this.targetFrame.width === Math.round(bounds.width * dpr) &&
			this.targetFrame.height === Math.round(bounds.height * dpr) &&
			this.paintedFocus === focused &&
			this.paintedCursorVisible === grid.cursorVisible &&
			this.paintedCursorOpacity === grid.cursorOpacity
		);
	}

	/** Composite the scroll animation over the painted frame and update overlay offsets. */
	private paintMotion(dpr: number, reuseTarget: boolean): void {
		const { grid, surface, backgroundOpacity } = this.options;
		const painted = paintEditorMotion({
			motion: this.motion,
			grid,
			surface,
			previousFrame: this.previousFrame,
			targetFrame: this.targetFrame,
			cellWidth: this.metrics.cellWidth,
			dpr,
			animate: this.animate,
			backgroundOpacity,
			reuseTarget
		});
		if (this.motion?.offsetX !== undefined && !painted.motion) {
			this.scrolling.discardHorizontalFrame();
		}
		this.motion = painted.motion;
		grid.horizontalOffset = painted.horizontalOffset;
		grid.horizontalColumn = this.scrolling.horizontalColumn;
		if (this.motion?.offsetX !== undefined) {
			grid.horizontalGutter = this.motion.left;
		}
		this.options.afterPaintRef.current(painted.overlayOffset);
	}

	/** Keep the canvas's accessible description in step with the grid. */
	private updateDescription(): void {
		if (!this.descriptionDirty) {
			return;
		}
		const description = this.options.grid.description;
		if (this.options.surface.getAttribute('aria-description') !== description) {
			this.options.surface.setAttribute('aria-description', description);
		}
		this.descriptionDirty = false;
	}

	/** Sizes the snapshot canvas to the surface and returns a context that overwrites it. */
	private snapshotContext(): CanvasRenderingContext2D {
		const { surface } = this.options;
		if (
			this.previousFrame.width !== surface.width ||
			this.previousFrame.height !== surface.height
		) {
			this.previousFrame.width = surface.width;
			this.previousFrame.height = surface.height;
		}
		const context = this.previousFrame.getContext('2d')!;
		context.globalCompositeOperation = 'copy';
		return context;
	}

	/** Paints the pre-scroll frame synchronously so motion can start from it. */
	private renderBeforeMotion(): void {
		this.preparingMotion = true;
		this.render();
		this.preparingMotion = false;
	}

	/** Apply one redraw batch from Neovim, starting a scroll animation first if it scrolls. */
	private receiveRedraw(event: Redraw): void {
		const { grid } = this.options;
		const redraw = summarizeRedraw(event.events);
		// Editing can shift grid rows without scrolling the viewport.
		const { edited, bufferChanged } = redraw;
		if (bufferChanged) {
			this.resetForBuffer(redraw);
		}
		if (edited) {
			this.stopMotion();
		}
		this.acknowledgeScroll(redraw);
		if (redraw.cursorJumped) {
			this.cursor.resetPosition();
		}
		this.prepareMotion(redraw, performance.now());

		const { row, column } = grid.cursor;
		const mode = grid.mode;
		if (grid.apply(event.events)) {
			this.afterFrame(redraw);
		}
		if (row !== grid.cursor.row || column !== grid.cursor.column || mode !== grid.mode) {
			this.cursor.resetBlink();
		}
		this.scrolling.finish();
	}

	/** Another buffer replaces every scroll and cursor animation of the previous one. */
	private resetForBuffer(redraw: RedrawSummary): void {
		this.deferredScroll = undefined;
		this.motion = undefined;
		this.lastScrollTime = undefined;
		this.directScroll = false;
		this.scrolling.reset();
		if (redraw.bufferColumn !== undefined) {
			this.scrolling.observeHorizontal(redraw.bufferColumn);
		}
		this.cursor.resetPosition();
	}

	/** Record the pixel offsets and sideways position that Neovim reports for its viewport. */
	private acknowledgeScroll(redraw: RedrawSummary): void {
		const { grid } = this.options;
		for (const args of redraw.pixelOffsets) {
			grid.scrollFraction = Number(args[0]);
			grid.scrollCursor = args[2] as { row: number; column: number } | undefined;
			this.directScroll = args[1] === true;
			this.scrolling.acknowledge(
				this.directScroll,
				typeof args[4] === 'number' ? args[4] : undefined
			);
		}
		if (!redraw.pixelOffsets.length && redraw.lastScrollColumn !== undefined) {
			this.scrolling.observeHorizontal(redraw.lastScrollColumn);
		}
	}

	/**
	 * Before the grid changes, snapshot the current frame and start a sideways or vertical
	 * scroll animation from it, or drop an animation that no longer applies.
	 */
	private prepareMotion(redraw: RedrawSummary, now: number): void {
		const { scroll, bufferChanged, edited } = redraw;
		if (
			scroll &&
			isHorizontalStep(scroll) &&
			this.directScroll &&
			this.scrolling.horizontalActive
		) {
			this.startHorizontalMotion(scroll, now);
		} else if (
			scroll &&
			!bufferChanged &&
			!edited &&
			!this.directScroll &&
			this.animate &&
			!this.options.host.hidden &&
			isAnimatableScroll(scroll)
		) {
			this.startVerticalMotion(scroll, now);
		} else if (
			redraw.viewportScrolls.length ||
			redraw.gridShifted ||
			(this.directScroll && this.motion?.offsetX === undefined)
		) {
			this.motion = undefined;
			if (
				scroll &&
				this.directScroll &&
				Math.abs(scroll.columns) >= scroll.right - scroll.left
			) {
				// shortcut: viewport-sized jumps snap, until horizontal overscan supplies the missing edge.
				this.scrolling.discardHorizontalFrame();
			}
		}
	}

	private startHorizontalMotion(scroll: Scroll, now: number): void {
		const { surface, grid } = this.options;
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		const previousContext = this.snapshotContext();
		if (
			this.motion?.offsetX !== undefined &&
			this.motion.targetReady &&
			this.targetFrame.width === surface.width &&
			this.targetFrame.height === surface.height
		) {
			previousContext.drawImage(this.targetFrame, 0, 0);
		} else {
			this.motion = undefined;
			grid.invalidatePaint();
			this.renderBeforeMotion();
			previousContext.drawImage(surface, 0, 0);
		}
		this.motion = horizontalMotion(
			scroll,
			this.cellWidth,
			this.scrolling.horizontalOffset * this.cellWidth,
			now
		);
	}

	private startVerticalMotion(scroll: Scroll, now: number): void {
		const { surface, grid } = this.options;
		const motion = this.motion;
		// An animation in progress continues from where it is now.
		const remaining = {
			y: motion ? scrollOffset(motion.distance, now - motion.start, motion.duration) : 0,
			x: motion ? scrollOffset(motion.distanceX, now - motion.start, motion.duration) : 0
		};
		cancelAnimationFrame(this.frame);
		this.renderBeforeMotion();
		this.snapshotContext().drawImage(surface, 0, 0);
		this.motion = scrollMotion(
			scroll,
			grid,
			this.cellWidth,
			remaining,
			now,
			this.lastScrollTime
		);
		this.lastScrollTime = now;
	}

	/** After a complete frame: refresh prefetched rows if the layout moved, then repaint. */
	private afterFrame(redraw: RedrawSummary): void {
		const { grid } = this.options;
		const { scroll } = redraw;
		if (this.motion) {
			this.motion.targetReady = false;
		}
		this.hasFrame = grid.rows > 0 && grid.columns > 0;
		this.descriptionDirty ||= !this.ready;
		if (
			!this.scrolling.prefetchPending &&
			(redraw.layoutReset ||
				(!grid.hasUpperRows && grid.needsUpperRows && redraw.viewportMoved) ||
				(this.directScroll && scroll && scroll.rows < 0 && grid.needsUpperRows))
		) {
			this.scrolling.invalidatePrefetch();
		}
		this.descriptionDirty ||= redraw.descriptionChanged;
		this.schedule();
	}
}
