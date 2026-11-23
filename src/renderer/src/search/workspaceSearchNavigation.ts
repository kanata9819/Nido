import type { KeyboardEvent, SetStateAction } from 'react';

/**
 * Whether a key leaves typing in a text field and returns to its list, like leaving Insert
 * mode in Vim: Escape, or Ctrl+C while no text is selected (so copying selected text works).
 */
export const isLeaveTypingKey = (event: KeyboardEvent<HTMLElement>): boolean => {
	if (event.altKey || event.metaKey || event.shiftKey) {
		return false;
	}
	if (event.key === 'Escape') {
		return !event.ctrlKey;
	}
	if (!event.ctrlKey || event.key.toLowerCase() !== 'c') {
		return false;
	}
	// Text selected in the panel (outside a field) is being copied.
	if (window.getSelection()?.toString()) {
		return false;
	}
	const field = event.target;
	return !(
		field instanceof HTMLInputElement &&
		field.selectionStart !== null &&
		field.selectionStart !== field.selectionEnd
	);
};

/** Whether a key in a list starts typing in its text field, like i, a and / in Vim. */
export const isStartTypingKey = (event: KeyboardEvent): boolean =>
	!event.ctrlKey && !event.altKey && !event.metaKey && ['i', 'a', '/'].includes(event.key);

/** How many rows fit in the requested fraction of the list's viewport. */
function pageRows(list: Element | null, fraction: number): number {
	const row = list?.querySelector('[aria-selected], [role="option"], button');
	const rowHeight = row?.getBoundingClientRect().height || 0;
	const height = list?.clientHeight || 0;
	return rowHeight > 0 && height > 0
		? Math.max(1, Math.floor((height * fraction) / rowHeight))
		: 20 * fraction;
}

/**
 * Move the selection of a search result list with Vim-style keys: j/k and the arrows by one,
 * Ctrl+D/U by half a page, Ctrl+F/B by a full page, g/Home and G/End to the ends. Ctrl+J/K also
 * work, so they can be used from a text field. `list` is the scrolling list used to size a page
 * (the event's own element by default). Returns whether the key was handled.
 */
export const navigateSearchList = (
	event: KeyboardEvent,
	count: number,
	move: (value: SetStateAction<number>) => void,
	list: Element | null = event.currentTarget as Element | null
): boolean => {
	const key = event.key.length === 1 && event.ctrlKey ? event.key.toLowerCase() : event.key;
	const page = event.ctrlKey && !event.shiftKey && ['d', 'u', 'f', 'b'].includes(key);
	if (
		!(page || ['j', 'k', 'g', 'G', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) ||
		event.altKey ||
		event.metaKey ||
		(event.ctrlKey && !page && !['j', 'k'].includes(key))
	) {
		return false;
	}
	event.preventDefault();
	const rows = page ? pageRows(list, ['d', 'u'].includes(key) ? 0.5 : 1) : 1;
	move((index) => {
		let next: number;
		if (['g', 'Home'].includes(key)) {
			next = 0;
		} else if (['G', 'End'].includes(key)) {
			next = count - 1;
		} else {
			const down = ['j', 'ArrowDown', 'd', 'f'].includes(key);
			next = Math.max(0, index) + (down ? rows : -rows);
		}
		return Math.max(0, Math.min(count - 1, next));
	});
	return true;
};
