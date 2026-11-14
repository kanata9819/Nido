import type { KeyboardEvent, SetStateAction } from 'react';

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
