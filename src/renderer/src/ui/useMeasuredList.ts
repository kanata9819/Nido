import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { useListViewport } from './useListViewport';

interface Measurements<T> {
	items: readonly T[];
	width: number;
	heights: Map<number, number>;
}

interface MeasuredList {
	height: number;
	rows: { index: number; top: number }[] | undefined;
	scrolled: (list: HTMLElement) => void;
}

/** Index of the row spanning a pixel offset, or the final row at the end. */
function rowAt(offsets: number[], top: number): number {
	let left = 0;
	let right = offsets.length - 1;
	while (left + 1 < right) {
		const mid = Math.floor((left + right) / 2);
		if (offsets[mid] <= top) {
			left = mid;
		} else {
			right = mid;
		}
	}
	return left;
}

/** Keep a large list's DOM bounded while allowing mounted rows to wrap to their natural height. */
export function useMeasuredList<T>(
	listRef: RefObject<HTMLElement | null>,
	items: readonly T[],
	selected: number,
	enabled: boolean,
	estimate: (item: T, index: number) => number
): MeasuredList {
	const { viewport, scrolled } = useListViewport(listRef, enabled, 1, { top: 0, height: 300 });
	const [measurements, setMeasurements] = useState<Measurements<T>>();
	const offsets = useMemo(() => {
		if (!enabled) {
			return [0];
		}
		const heights = measurements?.items === items ? measurements.heights : undefined;
		const positions = [0];
		for (const [index, item] of items.entries()) {
			positions.push(positions[index] + (heights?.get(index) ?? estimate(item, index)));
		}
		return positions;
	}, [enabled, items, measurements, estimate]);
	const first = Math.max(0, rowAt(offsets, viewport.top) - 6);
	const end = Math.min(items.length, rowAt(offsets, viewport.top + viewport.height) + 7);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!enabled || !list) {
			return;
		}
		const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-virtual-row]'));
		function measure(): void {
			const width = list!.clientWidth;
			const rows = nodes.map((node): [number, number] => [
				Number(node.dataset.virtualRow),
				Math.ceil(node.getBoundingClientRect().height)
			]);
			setMeasurements((previous) => {
				const current =
					previous?.items === items && previous.width === width
						? previous.heights
						: undefined;
				if (
					current &&
					rows.every(([index, height]) => !height || current.get(index) === height)
				) {
					return previous;
				}
				const heights = new Map(current);
				for (const [index, height] of rows) {
					if (height > 0) {
						heights.set(index, height);
					}
				}
				return { items, width, heights };
			});
		}
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		for (const node of nodes) {
			observer.observe(node);
		}
		return () => observer.disconnect();
	}, [enabled, items, first, end, selected, listRef]);

	const rows = enabled
		? Array.from({ length: end - first }, (_, offset) => ({
				index: first + offset,
				top: offsets[first + offset]
			}))
		: undefined;
	if (rows && selected >= 0 && selected < items.length && (selected < first || selected >= end)) {
		rows.splice(selected < first ? 0 : rows.length, 0, {
			index: selected,
			top: offsets[selected]
		});
	}
	return { height: offsets[offsets.length - 1], rows, scrolled };
}
