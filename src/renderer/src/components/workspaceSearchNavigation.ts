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

/**
 * Move the selection of a search result list with Vim-style keys: j/k and the arrows by one,
 * g/Home and G/End to the ends. Ctrl+J/K also work, so they can be used from a text field.
 * Returns whether the key was handled.
 */
export const navigateSearchList = (
	event: KeyboardEvent,
	count: number,
	move: (value: SetStateAction<number>) => void
): boolean => {
	const key = event.key;
	if (
		!['j', 'k', 'g', 'G', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) ||
		event.altKey ||
		event.metaKey ||
		(event.ctrlKey && !['j', 'k'].includes(key))
	) {
		return false;
	}
	event.preventDefault();
	move((index) => {
		let next: number;
		if (['g', 'Home'].includes(key)) {
			next = 0;
		} else if (['G', 'End'].includes(key)) {
			next = count - 1;
		} else {
			next = index + (['j', 'ArrowDown'].includes(key) ? 1 : -1);
		}
		return Math.max(0, Math.min(count - 1, next));
	});
	return true;
};
