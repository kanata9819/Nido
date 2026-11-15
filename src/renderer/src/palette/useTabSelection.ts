import { useLayoutEffect, useRef, useState } from 'react';
import type { Item, Panel } from '../types';

type SetSelection = React.Dispatch<React.SetStateAction<number>>;

/**
 * A palette's selection. In the workspace and open-file palettes, rows are tabs that Shift+J/K
 * reorder: the selection follows its tab rather than its index, and a move waits until the new
 * order is published before another one can start.
 */
export function useTabSelection({
	panel,
	filtered,
	fallbackSelection,
	setFallbackSelection
}: {
	panel: Exclude<Panel, null>;
	filtered: Item[];
	/** The selected index, used when no tab is selected. */
	fallbackSelection: number;
	setFallbackSelection: SetSelection;
}): {
	selection: number;
	setSelection: SetSelection;
	reorderable: boolean;
	/** Shift+J/K: move the selected tab down or up. Returns whether the key was handled. */
	reorderTab: (event: React.KeyboardEvent) => boolean;
	/** Forget the selected tab, such as when the filter changes. */
	clearTab: () => void;
} {
	const pendingMove = useRef<{
		source: string | number;
		target: string | number;
		offset: number;
	}>(undefined);
	const [selectedTab, setSelectedTab] = useState<string | number>();
	const selectedIndex =
		selectedTab === undefined ? -1 : filtered.findIndex((item) => item.tab?.id === selectedTab);
	const selection = selectedIndex < 0 ? fallbackSelection : selectedIndex;
	const reorderable = panel === 'workspaces' || panel === 'buffers';
	const setSelection: SetSelection = (value) => {
		if (reorderable) {
			const index = typeof value === 'function' ? value(selection) : value;
			setSelectedTab(filtered[index]?.tab?.id);
			setFallbackSelection(index);
		} else {
			setFallbackSelection(value);
		}
	};
	// A move ends once the published order has the tab on the target's side.
	useLayoutEffect(() => {
		const move = pendingMove.current;
		if (move) {
			const source = filtered.findIndex((item) => item.tab?.id === move.source);
			const target = filtered.findIndex((item) => item.tab?.id === move.target);
			if (source < 0 || target < 0 || (target - source) * move.offset < 0) {
				pendingMove.current = undefined;
			}
		}
	}, [filtered]);

	const reorderTab = (event: React.KeyboardEvent): boolean => {
		if (
			!reorderable ||
			!event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			(event.key !== 'J' && event.key !== 'K')
		) {
			return false;
		}
		event.preventDefault();
		const offset = event.key === 'K' ? -1 : 1;
		const tab = filtered[selection]?.tab;
		const target = filtered[selection + offset]?.tab;
		if (tab && target && !pendingMove.current) {
			// Buffer order is published asynchronously. Wait for it before targeting another row.
			const move = { source: tab.id, target: target.id, offset };
			pendingMove.current = move;
			setSelectedTab(tab.id);
			void tab.moveTo(target.id)?.catch(() => {
				if (pendingMove.current === move) {
					pendingMove.current = undefined;
				}
			});
		}
		return true;
	};

	return {
		selection,
		setSelection,
		reorderable,
		reorderTab,
		clearTab: () => setSelectedTab(undefined)
	};
}
