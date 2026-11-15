import { useEffect, useRef, useState, type RefObject } from 'react';

/** The height of one drawn diff row, in pixels. */
export const rowHeight = 22;

export type Side = 'before' | 'after';

/**
 * Keep the before and after panes of a split diff scrolled together, vertically and
 * horizontally. A position set by code is remembered, so its scroll event is not mirrored back
 * and a delayed one cannot overwrite a newer gesture in the other pane. A new `diff` starts at
 * the top left; `height` follows the after pane, which appears once `hasLines`.
 */
export function usePaneSync(
	diff: string,
	hasLines: boolean
): {
	before: RefObject<HTMLPreElement | null>;
	after: RefObject<HTMLPreElement | null>;
	/** The visible height of the panes, in pixels. */
	height: number;
	/** Scroll both panes so drawn row `position` is at the top. */
	scrollTo: (position: number) => void;
	/** Give the before pane the after pane's horizontal offset, after a layout switch. */
	alignHorizontally: () => void;
	/** Mirror a pane's scroll in the other one; resolves the first visible row after a gesture. */
	scrolled: (side: Side, pane: HTMLPreElement) => number | undefined;
} {
	// The vertical position set by code, so its scroll event is not mirrored back.
	const before = useRef<HTMLPreElement>(null);
	const after = useRef<HTMLPreElement>(null);
	const [height, setHeight] = useState(600);
	const synchronized = useRef(new WeakMap<HTMLPreElement, number>());
	const horizontalPositions = useRef(new WeakMap<HTMLPreElement, number>());

	function scrollTo(position: number): void {
		for (const pane of [before.current, after.current]) {
			pane?.scrollTo({ top: position * rowHeight, behavior: 'instant' });
			if (pane) {
				synchronized.current.set(pane, pane.scrollTop);
			}
		}
	}

	// Track the pane height to know how many rows are visible. The pane appears once a
	// message such as "Loading diff…" gives way to lines.
	useEffect(() => {
		const pane = after.current;
		if (!pane) {
			return;
		}
		setHeight(pane.clientHeight);
		const observer = new ResizeObserver(() => setHeight(pane.clientHeight));
		observer.observe(pane);
		return () => observer.disconnect();
	}, [hasLines]);
	useEffect(() => {
		horizontalPositions.current = new WeakMap();
		before.current?.scrollTo({ top: 0, left: 0 });
		after.current?.scrollTo({ top: 0, left: 0 });
	}, [diff]);

	function alignHorizontally(): void {
		if (before.current && after.current) {
			before.current.scrollLeft = after.current.scrollLeft;
			horizontalPositions.current.set(before.current, before.current.scrollLeft);
		}
	}

	function scrolled(side: Side, pane: HTMLPreElement): number | undefined {
		const other = side === 'before' ? after.current : before.current;
		const left = pane.scrollLeft;
		if (left !== (horizontalPositions.current.get(pane) ?? 0)) {
			horizontalPositions.current.set(pane, left);
			if (other && other.scrollLeft !== left) {
				other.scrollLeft = left;
				// Record the applied offset in case this pane has a shorter scroll range.
				horizontalPositions.current.set(other, other.scrollLeft);
			}
		}
		const expected = synchronized.current.get(pane);
		// A delayed programmatic event must not overwrite a newer gesture in the other pane.
		if (expected !== undefined && Math.abs(pane.scrollTop - expected) <= 1) {
			return undefined;
		}
		synchronized.current.delete(pane);
		const row = Math.floor(pane.scrollTop / rowHeight);
		if (other && Math.abs(other.scrollTop - pane.scrollTop) > 1) {
			other.scrollTop = pane.scrollTop;
			synchronized.current.set(other, other.scrollTop);
		}
		return row;
	}

	return { before, after, height, scrollTo, alignHorizontally, scrolled };
}
