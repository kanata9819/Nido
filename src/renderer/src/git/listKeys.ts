import type { KeyboardEvent } from 'react';

/**
 * The keys of a keyboard-driven list (a listbox whose rows are [role="option"]): j/k and the
 * arrows move, g/G and Home/End jump, Ctrl+D/U move half a page, Ctrl+F/B and PageDown/PageUp
 * a page, and Enter opens. Returns whether the key was handled.
 */
export function handleListKey(
	event: KeyboardEvent<HTMLElement>,
	{
		count,
		index,
		setIndex,
		open
	}: { count: number; index: number; setIndex: (index: number) => void; open: () => void }
): boolean {
	if (event.altKey || event.metaKey || event.nativeEvent.isComposing || event.keyCode === 229) {
		return false;
	}
	const key = event.key.toLowerCase();
	const halfPage = event.ctrlKey && !event.shiftKey && ['d', 'u'].includes(key);
	const fullPage =
		(event.ctrlKey && !event.shiftKey && ['f', 'b'].includes(key)) ||
		(!event.ctrlKey && ['PageDown', 'PageUp'].includes(event.key));
	if (halfPage || fullPage) {
		event.preventDefault();
		const row = event.currentTarget.querySelector<HTMLElement>('[role="option"]');
		const step = Math.max(
			1,
			Math.floor(
				event.currentTarget.clientHeight /
					(row?.getBoundingClientRect().height || 1) /
					(halfPage ? 2 : 1)
			)
		);
		const direction = ['d', 'f', 'pagedown'].includes(key) ? 1 : -1;
		setIndex(Math.max(0, Math.min(count - 1, index + direction * step)));
		return true;
	}
	if (event.ctrlKey) {
		return false;
	}
	if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'G'].includes(event.key)) {
		event.preventDefault();
		let next = index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1);
		if (event.key === 'Home' || event.key === 'g') {
			next = 0;
		}
		if (event.key === 'End' || event.key === 'G') {
			next = count - 1;
		}
		setIndex(Math.max(0, Math.min(count - 1, next)));
		return true;
	}
	if (event.key === 'Enter') {
		event.preventDefault();
		open();
		return true;
	}
	return false;
}
