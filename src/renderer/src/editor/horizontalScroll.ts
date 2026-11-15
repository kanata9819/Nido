/**
 * Sideways scrolling, which Neovim does in whole columns while the editor shows a smooth
 * (fractional) position. Neovim is asked to scroll a few columns ahead, so the columns that
 * come into view are already drawn; the editor then shifts the grid by `offset` columns to
 * show the exact position. Keep the native view ahead of the fractional position shown
 * between two frames.
 */
export class HorizontalScroll {
	// Neovim's leftcol, and the one before its last change: together they bound the columns that
	// are drawn.
	private column = 0;
	private previous = 0;
	// The fractional column shown; undefined when not scrolling sideways.
	private position?: number;
	// The leftcol asked of Neovim so far, including requests it has not answered.
	private requested = 0;
	// The rightmost position Neovim allowed (it stops at the end of the longest line).
	private limit?: number;

	/** Neovim's leftcol. */
	get native(): number {
		return this.column;
	}

	/** Whether a sideways scroll is in progress. */
	get active(): boolean {
		return this.position !== undefined;
	}

	/** How far the shown position is from Neovim's leftcol, in columns. */
	get offset(): number {
		return this.column - (this.position ?? this.column);
	}

	/** Whether the drawn columns include `position`, so Neovim need not scroll for it. */
	private covers(position: number): boolean {
		return (
			position >= Math.min(this.previous, this.column) &&
			position <= Math.max(this.previous, this.column)
		);
	}

	/**
	 * Move the shown position by `delta` columns. Returns how many columns to ask Neovim to
	 * scroll: in steps of `ahead` columns, and only when the shown position leaves the drawn ones.
	 */
	request(delta: number, ahead = 1): number {
		if (!Number.isFinite(delta) || !delta) {
			return 0;
		}
		const position = Math.max(
			0,
			Math.min(this.limit ?? Infinity, (this.position ?? this.requested) + delta)
		);
		if (!Number.isFinite(position)) {
			return 0;
		}
		const rounded = Math.round(position);
		this.position = Math.abs(position - rounded) < 1e-9 ? rounded : position;
		const distance = (this.position - this.column) / ahead;
		const target =
			ahead === 1 && Number.isInteger(this.position)
				? this.position
				: this.covers(this.position)
					? this.column
					: Math.max(
							0,
							this.column +
								(distance < 0 ? Math.floor(distance) : Math.ceil(distance)) * ahead
						);
		const movement = target - this.requested;
		this.requested = target;
		return movement;
	}

	/** Once scrolling stops, the columns to scroll so Neovim's leftcol is next to the position. */
	settle(): number {
		if (
			this.position === undefined ||
			this.column === Math.floor(this.position) ||
			this.column === Math.ceil(this.position)
		) {
			return 0;
		}
		const target =
			this.column > this.position ? Math.floor(this.position) : Math.ceil(this.position);
		const movement = target - this.requested;
		this.requested = target;
		return movement;
	}

	/**
	 * Neovim reports its leftcol; `expected` is how far our request in flight moves it. Returns
	 * whether the queued sideways movement must be dropped, because Neovim ended elsewhere.
	 */
	acknowledge(column: number, expected: number): boolean {
		if (!Number.isSafeInteger(column) || column < 0) {
			return false;
		}
		const previous = this.column;
		if (column !== previous) {
			this.previous = previous;
		}
		this.column = column;
		if (!this.active) {
			this.previous = column;
			this.requested = column;
			return false;
		}
		if (column !== previous + expected) {
			const limited = expected > 0 && column >= previous && column < previous + expected;
			this.position = limited ? Math.min(this.position!, column) : column;
			this.requested = column;
			this.limit = limited ? column : undefined;
			if (!limited) {
				this.previous = column;
			}
			return true;
		}
		if (
			this.position !== undefined &&
			this.covers(this.position) &&
			this.requested !== column
		) {
			this.requested = column;
			return true;
		}
		return false;
	}

	/** Forget the right edge, for example after vertical scrolling brought longer lines. */
	invalidateLimit(): void {
		this.limit = undefined;
	}

	/** The previous columns are no longer drawn. */
	discardFrame(): void {
		this.previous = this.column;
	}

	/** End the gesture; `preservePosition` keeps the fractional position to settle later. */
	stop(pendingColumns = 0, preservePosition = false): void {
		if (!preservePosition) {
			this.position = undefined;
			this.previous = this.column;
			this.invalidateLimit();
		}
		this.requested = Math.max(0, this.column + pendingColumns);
	}

	/** Start over at column 0. */
	reset(): void {
		this.column = 0;
		this.stop();
	}
}
