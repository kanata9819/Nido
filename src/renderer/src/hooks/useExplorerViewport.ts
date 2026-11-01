import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react';
import type { getVisibleEntries } from '../sidebarTree';

export const explorerRowHeight = 26;
const rowHeight = explorerRowHeight;
const overscan = 8;

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
  const [top, setTop] = useState(initialScrollTop);
  const viewport = useRef(initialScrollTop);
  const restored = useRef(false);
  const previousSelection = useRef(selected);
  const previousReveal = useRef(0);
  const [height, setHeight] = useState(200);
  const first = Math.max(
    0,
    Math.min(visible.length - 1, Math.floor(Math.max(0, top - 5) / rowHeight) - overscan)
  );
  const last = Math.min(visible.length, Math.ceil((top + height) / rowHeight) + overscan);
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  if (selectedIndex >= 0 && selectedIndex < first) {
    indices.unshift(selectedIndex);
  } else if (selectedIndex >= last) {
    indices.push(selectedIndex);
  }
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
      const rowTop = selectedIndex * rowHeight + 5;
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
    setTop(node.scrollTop);
  }, [selected, selectedIndex, reveal, visible, active, ready, tree, rememberScroll]);
  useEffect(() => {
    const node = tree.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setHeight(node.clientHeight);
      setTop(node.scrollTop);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tree]);
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const top = event.currentTarget.scrollTop;
    setTop(top);
    if (active && restored.current) {
      viewport.current = top;
      rememberScroll(top);
    }
  };
  return { indices, onScroll };
}
