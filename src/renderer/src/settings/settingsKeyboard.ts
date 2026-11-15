import type { KeyboardEvent } from 'react';

/**
 * Keyboard navigation for the settings panel: j/k, the arrows and Ctrl+D/U move between
 * fields (wrapping around), and Enter toggles a checkbox. Keys a field needs itself, such as
 * arrows in a select or a number field and letters in a text field, are left alone.
 */
export function settingsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
	if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
		return;
	}
	const target = event.target as HTMLInputElement | HTMLSelectElement;
	const key = event.key.toLowerCase();
	const down = event.ctrlKey && key === 'd';
	const up = event.ctrlKey && key === 'u';
	if (target.tagName === 'SELECT' && !event.ctrlKey) {
		return;
	}
	if (
		target.type === 'number' &&
		!event.ctrlKey &&
		['ArrowUp', 'ArrowDown'].includes(event.key)
	) {
		return;
	}
	const text = target.type === 'text';
	const next = down || event.key === 'ArrowDown' || ((!text || event.ctrlKey) && key === 'j');
	const previous = up || event.key === 'ArrowUp' || ((!text || event.ctrlKey) && key === 'k');
	if (next || previous) {
		event.preventDefault();
		const inputs = [
			...event.currentTarget.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
				'input:not(:disabled), select:not(:disabled)'
			)
		];
		const index = inputs.indexOf(target);
		inputs[(index + (next ? 1 : -1) + inputs.length) % inputs.length]?.focus();
	} else if (event.key === 'Enter' && target.type === 'checkbox') {
		event.preventDefault();
		target.click();
	}
}
