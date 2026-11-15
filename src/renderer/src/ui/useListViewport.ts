import { useLayoutEffect, useState, type RefObject } from 'react';
import type { ListViewport } from './virtualRows';

/**
 * Track a virtual list's scroll position and height while `shown`, starting at `initial`.
 * Call `scrolled` from the list's scroll handler.
 */
export function useListViewport(
	listRef: RefObject<HTMLElement | null>,
	shown: boolean,
	initial: ListViewport
): { viewport: ListViewport; scrolled: (list: HTMLElement) => void } {
	const [viewport, setViewport] = useState(initial);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!shown || !list) {
			return;
		}
		const update = (): void => {
			const top = list.scrollTop;
			const height = list.clientHeight;
			setViewport((previous) =>
				previous.top === top && previous.height === height ? previous : { top, height }
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(list);
		return () => observer.disconnect();
	}, [shown, listRef]);
	return {
		viewport,
		scrolled: (list) => setViewport({ top: list.scrollTop, height: list.clientHeight })
	};
}
