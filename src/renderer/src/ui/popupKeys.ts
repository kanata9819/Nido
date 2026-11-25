// Keyboard scrolling and focus shared by the editor's popup cards (hover and diagnostics).

/** Ctrl+D/U scroll half a page down or up, Ctrl+F/B a whole page. `key` is lower case. */
export function scrollPage(content: HTMLElement, key: string): void {
	content.scrollTop +=
		(['d', 'f'].includes(key) ? 1 : -1) *
		content.clientHeight *
		(['d', 'u'].includes(key) ? 0.5 : 1);
}

/**
 * j/k and the arrow keys scroll by a line, PageUp/PageDown by most of a page, Home and End to
 * either end. `key` is lower case.
 */
export function scrollLines(content: HTMLElement, key: string): void {
	if (key === 'home') {
		content.scrollTop = 0;
	} else if (key === 'end') {
		content.scrollTop = content.scrollHeight;
	} else {
		content.scrollTop +=
			(['j', 'arrowdown', 'pagedown'].includes(key) ? 1 : -1) *
			(key.startsWith('page') ? content.clientHeight * 0.8 : 32);
	}
}

/** KeyboardEvent.key values that scroll the card by lines or pages. */
export const lineKeys = ['j', 'k', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];

/** Tab and Shift+Tab: move focus to the next or previous of `nodes`, wrapping around. */
export function cycleFocus(nodes: HTMLElement[], backwards: boolean): void {
	const index = nodes.indexOf(document.activeElement as HTMLElement);
	nodes[(index + (backwards ? -1 : 1) + nodes.length) % nodes.length]?.focus();
}
