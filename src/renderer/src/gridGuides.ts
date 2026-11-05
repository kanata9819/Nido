import type { Grid } from './grid';

interface GuideRect {
	x: number;
	top: number;
	bottom: number;
	width: number;
	documentTop: number;
	documentBottom: number;
	color: string;
	alpha: number;
}

/** Build bracket guide geometry and the indent pixels it covers for one paint band. */
export function createGridGuides(
	grid: Grid,
	cellWidth: number,
	dpr: number
): {
	guideRects: GuideRect[];
	indentCuts: (column: number) => [number, number][];
	rowCuts: (columns: number[], top: number, height: number) => number[];
} {
	const commandRow = grid.rows - 1;
	const origin = grid.scrollOrigin;
	const documentY = (row: number): number =>
		(row === commandRow
			? grid.contentHeight + grid.scrollOffset + origin
			: grid.rowTop(row) + origin) * dpr;
	const guideRects: GuideRect[] = [];
	for (const guide of grid.bracketGuides) {
		const snap = (value: number): number => Math.round(value * dpr) / dpr;
		const first = guide.opening >= 0 ? guide.top + 1 : guide.top;
		const last = guide.closing >= 0 ? guide.bottom + 1 : guide.bottom;
		const inset = guide.opening >= 0 ? 1 : 0;
		const endInset = guide.closing >= 0 ? 1 : 0;
		const rect = {
			x: snap(guide.column * cellWidth) - 1 / dpr,
			top: grid.rowY(first) - inset / dpr,
			bottom: grid.rowY(last) - endInset / dpr,
			width: 1 / dpr,
			documentTop: documentY(first) - inset,
			documentBottom: documentY(last) - endInset,
			color: guide.color,
			alpha: guide.active ? 0.9 : 0.3
		};
		guideRects.push(rect);
		if (guide.active) {
			for (const [column, top, documentTop] of [
				[guide.opening, rect.top, rect.documentTop],
				[guide.closing, rect.bottom, rect.documentBottom]
			]) {
				if (column >= 0) {
					guideRects.push({
						...rect,
						top,
						bottom: top + 1 / dpr,
						width: Math.max(1 / dpr, snap((column + 1) * cellWidth) - rect.x),
						documentTop,
						documentBottom: documentTop + 1
					});
				}
			}
		}
	}
	const coveredColumns = new Map<number, [number, number][]>();
	const indentCuts = (column: number): [number, number][] => {
		let cuts = coveredColumns.get(column);
		if (!cuts) {
			const left = Math.round(column * cellWidth * dpr) - 1;
			const spans = guideRects
				.filter(
					(rect) =>
						Math.round(rect.x * dpr) < left + 1 &&
						Math.round((rect.x + rect.width) * dpr) > left
				)
				.map((rect): [number, number] => [rect.documentTop, rect.documentBottom])
				.sort((a, b) => a[0] - b[0]);
			cuts = [];
			for (const span of spans) {
				const previous = cuts[cuts.length - 1];
				if (previous && span[0] <= previous[1]) {
					previous[1] = Math.max(previous[1], span[1]);
				} else {
					cuts.push(span);
				}
			}
			coveredColumns.set(column, cuts);
		}
		return cuts;
	};
	const rowCuts = (columns: number[], top: number, height: number): number[] => {
		const cuts: number[] = [];
		for (const column of columns) {
			for (const [start, end] of indentCuts(column)) {
				const first = Math.max(0, start - top);
				const last = Math.min(height, end - top);
				if (first < last) {
					cuts.push(column, first, last);
				}
			}
		}
		return cuts;
	};
	return { guideRects, indentCuts, rowCuts };
}
