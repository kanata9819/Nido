/** The scroll position and visible height of a list, in pixels. */
export interface ListViewport {
	top: number;
	height: number;
}

/**
 * The rows of a virtual list to draw: those in view and `overscan` rows around them, plus the
 * selected row when it is outside them, in order. With `keepLast`, a list scrolled past its
 * end still draws its last row.
 */
export function virtualRows(
	viewport: ListViewport,
	count: number,
	rowHeight: number,
	overscan: number,
	{ selected = -1, keepLast = false }: { selected?: number; keepLast?: boolean } = {}
): number[] {
	const first = Math.min(
		keepLast ? Math.max(0, count - 1) : count,
		Math.max(0, Math.floor(viewport.top / rowHeight) - overscan)
	);
	const last = Math.min(
		count,
		Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan
	);
	const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
	if (selected >= 0 && selected < count && !indices.includes(selected)) {
		indices.push(selected);
		indices.sort((a, b) => a - b);
	}
	return indices;
}
