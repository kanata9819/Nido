export function scrollOffset(distance: number, elapsed: number, duration = 120): number {
	const progress = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
	return distance * (1 - progress) ** 3;
}

export function accumulateScroll(
	remainder: number,
	delta: number,
	mode: number,
	lineHeight: number,
	pageHeight: number
): { lines: number; remainder: number } {
	let unit = 1;
	if (mode === 1) {
		unit = lineHeight;
	} else if (mode === 2) {
		unit = pageHeight;
	}
	const pixels = delta * unit;
	if (!pixels || !Number.isFinite(pixels)) {
		return { lines: 0, remainder };
	}
	if (Math.sign(pixels) !== Math.sign(remainder)) {
		remainder = 0;
	}
	const total = remainder + pixels;
	const lines = Math.trunc(total / lineHeight);
	return { lines, remainder: total - lines * lineHeight };
}

interface ScrollCommand {
	lines: number;
	follow: boolean;
	columns?: number;
}

interface PendingScroll extends ScrollCommand {
	acknowledged: boolean;
	completed: boolean;
}

// Keep one command in flight while coalescing new wheel input.
export class ScrollQueue {
	private queued = 0;
	private horizontal = 0;
	private follow = true;
	private inFlight: PendingScroll | undefined;

	get hasQueued(): boolean {
		return this.queued !== 0 || this.horizontal !== 0;
	}

	get pending(): boolean {
		return this.inFlight !== undefined;
	}

	get verticalPending(): boolean {
		return this.queued !== 0 || !!this.inFlight?.lines;
	}

	get pendingColumns(): number {
		return this.inFlight?.acknowledged ? 0 : (this.inFlight?.columns ?? 0);
	}

	cancelHorizontal(): void {
		this.horizontal = 0;
	}

	get preview(): number {
		// A redraw already includes the sent distance; only unsent input remains to preview.
		return this.queued + (this.inFlight?.acknowledged ? 0 : (this.inFlight?.lines ?? 0));
	}

	enqueue(lines: number, follow: boolean, columns = 0): void {
		this.queued += lines;
		this.horizontal += columns;
		this.follow = follow;
	}

	cancelQueued(): void {
		this.queued = 0;
		this.horizontal = 0;
	}

	reset(): void {
		this.cancelQueued();
		this.inFlight = undefined;
	}

	start(): ScrollCommand | undefined {
		if (this.pending || !this.hasQueued) {
			return undefined;
		}
		const columns = Math.max(-1000, Math.min(1000, this.horizontal));
		const command = {
			lines: Math.max(-1000, Math.min(1000, this.queued)),
			follow: this.follow,
			...(columns ? { columns } : {})
		};
		this.queued -= command.lines;
		this.horizontal -= columns;
		this.inFlight = { ...command, acknowledged: false, completed: false };
		return command;
	}

	acknowledge(): void {
		if (this.inFlight) {
			this.inFlight.acknowledged = true;
		}
	}

	complete(): void {
		if (this.inFlight) {
			this.inFlight.completed = true;
		}
	}

	fail(): void {
		this.cancelQueued();
		// Failed commands have no redraw to acknowledge.
		this.acknowledge();
	}

	finish(): boolean {
		// Invoke replies and redraw notifications can arrive in either order.
		if (!this.inFlight?.acknowledged || !this.inFlight.completed) {
			return false;
		}
		this.inFlight = undefined;
		return true;
	}
}

/**
 * Convert a wheel delta to pixels. deltaMode 0 is pixels, 1 is lines and 2 is pages.
 * The page size is read only for page deltas, because reading layout can force a reflow.
 */
function wheelPixels(delta: number, mode: number, line: number, page: () => number): number {
	return delta * (mode === 1 ? line : mode === 2 ? page() : 1);
}

export interface WheelMotion {
	/** Vertical distance in rows, which may be fractional. */
	lines: number;
	/** Horizontal distance in columns. */
	columns: number;
	/** Wheel notches move in steps; fine touchpad deltas move smoothly. */
	discrete: boolean;
}

/**
 * Turn an editor wheel event into vertical and horizontal motion. Horizontal touchpad motion
 * accumulates in `horizontalWheel` across events less than 200ms apart; the returned
 * `horizontalWheel` replaces it. `motion` is undefined when the event moves nothing.
 */
export function editorWheelMotion(
	event: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean },
	view: {
		surface: { clientWidth: number; clientHeight: number };
		lineHeight: number;
		cellWidth: number;
	},
	horizontalWheel: { remainder: number; time: number },
	now: number
): { horizontalWheel: { remainder: number; time: number }; motion?: WheelMotion } {
	const { surface, lineHeight, cellWidth } = view;
	const delta = event.deltaY * 0.5;
	const horizontal = event.deltaX || (event.shiftKey ? event.deltaY : 0);
	// Precision touchpads add small vertical deltas during horizontal gestures.
	const diagonal =
		!event.shiftKey &&
		delta !== 0 &&
		(event.deltaMode !== 0 || Math.abs(event.deltaY) * 4 >= Math.abs(horizontal));
	const result =
		cellWidth && diagonal
			? accumulateScroll(
					now - horizontalWheel.time > 200 ? 0 : horizontalWheel.remainder,
					horizontal * 0.5,
					event.deltaMode,
					cellWidth,
					surface.clientWidth
				)
			: { lines: 0, remainder: 0 };
	const nextWheel = horizontal
		? { remainder: diagonal ? result.remainder : 0, time: now }
		: horizontalWheel;
	const pixels = wheelPixels(
		diagonal ? delta : 0,
		event.deltaMode,
		lineHeight,
		() => surface.clientHeight
	);
	const horizontalPixels = wheelPixels(
		horizontal * 0.5,
		event.deltaMode,
		cellWidth,
		() => surface.clientWidth
	);
	const columns = pixels ? result.lines : horizontalPixels / cellWidth;
	if (!(Number.isFinite(pixels) && pixels) && !(Number.isFinite(columns) && columns)) {
		return { horizontalWheel: nextWheel };
	}
	return {
		horizontalWheel: nextWheel,
		motion: {
			lines: Number.isFinite(pixels) ? pixels / lineHeight : 0,
			columns: Number.isFinite(columns) ? columns : 0,
			// Fine pixel deltas already describe smooth touchpad motion; wheel notches
			// (including Shift+wheel and tilt) move several lines or columns at once.
			discrete:
				event.deltaMode !== 0 ||
				Math.abs(pixels) >= lineHeight ||
				Math.abs(horizontalPixels) >= 3 * cellWidth
		}
	};
}
