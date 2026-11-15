import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../../../grid/grid';
import type { ListViewport } from '../../../ui/virtualRows';
import type { Menu } from './useCompletionMenu';

/**
 * Place the menu (`cardRef`) at the cursor, and report its list's scroll position for virtual
 * rendering. The menu opens above or below the cursor and keeps that side while it stays open,
 * so it does not jump as the items change. The input carries the menu for assistive technology.
 */
export function useMenuPlacement({
	menu,
	hidden,
	listId,
	gridRef,
	inputRef,
	cardRef,
	setViewport
}: {
	menu: Menu | undefined;
	hidden: boolean;
	listId: string;
	gridRef: RefObject<Grid>;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	cardRef: RefObject<HTMLDivElement | null>;
	setViewport: (update: (previous: ListViewport) => ListViewport) => void;
}): void {
	const placement = useRef<
		{ element: HTMLDivElement; above: boolean; height: number } | undefined
	>(undefined);
	useLayoutEffect(() => {
		const element = cardRef.current;
		const anchor = inputRef.current;
		if (!menu || !element || !anchor || hidden) {
			return;
		}
		const host = element.parentElement!;
		const list = element.querySelector<HTMLElement>('[role="listbox"]')!;
		const updateViewport = (): void => {
			const top = list.scrollTop;
			const height = list.clientHeight;
			setViewport((previous) =>
				previous.top === top && previous.height === height ? previous : { top, height }
			);
		};
		const position = (): void => {
			const { cellWidth, cellHeight } = gridRef.current;
			const top = anchor.offsetTop + cellHeight + 6;
			if (placement.current?.element !== element) {
				placement.current = {
					element,
					above: top + element.offsetHeight > host.clientHeight - cellHeight,
					height: list.offsetHeight
				};
			}
			placement.current.height = Math.max(placement.current.height, list.offsetHeight);
			list.style.minHeight = `${placement.current.height}px`;
			element.style.left = `${Math.max(6, Math.min(gridRef.current.surfaceLeft + menu.column * cellWidth, host.clientWidth - element.offsetWidth - 6))}px`;
			element.style.top = `${Math.max(
				6,
				Math.min(
					placement.current.above ? anchor.offsetTop - element.offsetHeight - 6 : top,
					host.clientHeight - element.offsetHeight - 6
				)
			)}px`;
			updateViewport();
		};
		position();
		element.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		updateViewport();
		anchor.setAttribute('aria-autocomplete', 'list');
		anchor.setAttribute('aria-controls', listId);
		if (menu.selected >= 0) {
			anchor.setAttribute('aria-activedescendant', `${listId}-${menu.selected}`);
		}

		const observer = new ResizeObserver(position);
		observer.observe(host);
		observer.observe(element);
		const cursorObserver = new MutationObserver(position);
		cursorObserver.observe(anchor, { attributes: true, attributeFilter: ['style'] });
		return () => {
			observer.disconnect();
			cursorObserver.disconnect();
			anchor.removeAttribute('aria-autocomplete');
			anchor.removeAttribute('aria-controls');
			anchor.removeAttribute('aria-activedescendant');
		};
	}, [menu, gridRef, inputRef, cardRef, listId, hidden, setViewport]);
}
