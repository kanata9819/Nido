import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react';
import { virtualRows } from '../ui/virtualRows';
import type { getVisibleEntries } from './sidebarTree';

// Explorer rows are drawn virtually: only the visible rows and `overscan` rows around them exist.
export const explorerRowHeight = 26;
const rowHeight = explorerRowHeight;
const overscan = 8;
const treePadding = 5;

function rowStart(top: number): number {
	return Math.floor(Math.max(0, top - treePadding) / rowHeight) * rowHeight;
}

/**
 * The explorer rows to draw for the current scroll position, restoring the saved scroll
 * position and keeping the selected row in view.
 */
export function useExplorerViewport({
	initialScrollTop,
	selected,
	selectedIndex,
	reveal,
	visible,
	active,
	ready,
	tree,
	rememberScroll
}: {
	initialScrollTop: number;
	selected: string;
	selectedIndex: number;
	reveal: number;
	visible: ReturnType<typeof getVisibleEntries>;
	active: boolean;
	ready: boolean;
	tree: RefObject<HTMLDivElement | null>;
	rememberScroll: (top: number) => void;
}): { indices: number[]; onScroll: (event: UIEvent<HTMLDivElement>) => void } {
	const [top, setTop] = useState(() => rowStart(initialScrollTop));
	const viewport = useRef(initialScrollTop);
	const restored = useRef(false);
	const previousSelection = useRef(selected);
	const previousReveal = useRef(0);
	const [height, setHeight] = useState(200);
	// Cover the partial row at the far edge without rendering on each scroll pixel.
	const indices = virtualRows(
		{ top, height: height + rowHeight },
		visible.length,
		rowHeight,
		overscan,
		{ selected: selectedIndex, keepLast: true }
	);
	useLayoutEffect(() => {
		const node = tree.current;
		if (!active) {
			restored.current = false;
		}
		if (!node || !active || !ready) {
			return;
		}
		// Measure synchronously before paint to preserve the restored scroll position.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setHeight(node.clientHeight);
		if (!restored.current) {
			node.scrollTo({ top: viewport.current });
			restored.current = true;
			previousSelection.current = selected;
			rememberScroll(node.scrollTop);
		}
		if (
			(selected !== previousSelection.current || reveal !== previousReveal.current) &&
			selectedIndex >= 0
		) {
			const rowTop = selectedIndex * rowHeight + treePadding;
			if (rowTop < node.scrollTop) {
				node.scrollTo({ top: rowTop });
			} else if (rowTop + rowHeight > node.scrollTop + node.clientHeight) {
				node.scrollTo({ top: rowTop + rowHeight - node.clientHeight });
			}
		}
		if (selectedIndex >= 0 || !selected) {
			previousSelection.current = selected;
			previousReveal.current = reveal;
		}
		viewport.current = node.scrollTop;
		setTop(rowStart(viewport.current));
	}, [selected, selectedIndex, reveal, visible, active, ready, tree, rememberScroll]);
	useEffect(() => {
		const node = tree.current;
		if (!node) {
			return;
		}
		const observer = new ResizeObserver(() => {
			setHeight(node.clientHeight);
			setTop(rowStart(node.scrollTop));
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [tree]);
	const onScroll = (event: UIEvent<HTMLDivElement>): void => {
		const top = event.currentTarget.scrollTop;
		setTop(rowStart(top));
		if (active && restored.current) {
			viewport.current = top;
			rememberScroll(top);
		}
	};
	return { indices, onScroll };
}
