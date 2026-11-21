import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ListViewport } from './virtualRows';

/**
 * Track the whole rows intersecting a virtual list's viewport while `shown`.
 * Call `scrolled` from the list's scroll handler.
 */
export function useListViewport(
	listRef: RefObject<HTMLElement | null>,
	shown: boolean,
	rowHeight: number,
	initial: ListViewport
): { viewport: ListViewport; scrolled: (list: HTMLElement) => void } {
	const [viewport, setViewport] = useState(initial);
	const latest = useRef(initial);
	const scrolled = useCallback(
		(list: HTMLElement): void => {
			const scrollTop = list.scrollTop;
			const top = Math.floor(scrollTop / rowHeight) * rowHeight;
			const height = Math.ceil((scrollTop + list.clientHeight) / rowHeight) * rowHeight - top;
			if (latest.current.top !== top || latest.current.height !== height) {
				latest.current = { top, height };
				setViewport(latest.current);
			}
		},
		[rowHeight]
	);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!shown || !list) {
			return;
		}
		const update = (): void => scrolled(list);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(list);
		return () => observer.disconnect();
	}, [shown, listRef, scrolled]);
	return { viewport, scrolled };
}
