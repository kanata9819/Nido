// Converts browser keyboard events to Vim key notation (:help key-notation) for nvim_input.

/** Keys that only modify or start composing another key, so they send nothing alone. */
const ignoredKeys = [
	'Shift',
	'Control',
	'Alt',
	'AltGraph',
	'Meta',
	'Dead',
	'Process',
	'Unidentified'
];

/** Browser key names and their Vim names. */
const specialKeys: Record<string, string> = {
	Escape: 'Esc',
	Enter: 'CR',
	Backspace: 'BS',
	Delete: 'Del',
	Tab: 'Tab',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Home: 'Home',
	End: 'End',
	PageUp: 'PageUp',
	PageDown: 'PageDown',
	Insert: 'Insert'
};

/** Whether AltGr is held. Windows reports AltGr as Ctrl+Alt, which must not become <C-M-...>. */
export function isAltGraph(event: Partial<Pick<KeyboardEvent, 'getModifierState'>>): boolean {
	return event.getModifierState?.('AltGraph') === true;
}

/**
 * The Vim notation of a key press, such as <C-s>, <Esc> or a, or null for keys that send
 * nothing (modifiers alone, IME composition, keys without a Vim name).
 */
export function vimKey(
	event: Pick<
		KeyboardEvent,
		'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'
	> &
		Partial<Pick<KeyboardEvent, 'getModifierState'>>
): string | null {
	if (event.isComposing || ignoredKeys.includes(event.key)) {
		return null;
	}
	const special = specialKeys[event.key];
	const functionKey = /^F\d+$/.test(event.key);

	// Other named keys, such as CapsLock, ContextMenu or the Japanese Zenkaku/Hankaku and
	// Convert keys, have no Vim notation. Sending their names would type them as text.
	if (!special && !functionKey && [...event.key].length > 1) {
		return null;
	}

	const altGraph = isAltGraph(event);
	const ctrlKey = event.ctrlKey && !altGraph;
	const altKey = event.altKey && !altGraph;
	let key = special || event.key;
	if (functionKey || special || ctrlKey || altKey || event.metaKey) {
		if (key === ' ') {
			key = 'Space';
		}
		const modifiers =
			(ctrlKey ? 'C-' : '') +
			(altKey ? 'M-' : '') +
			(event.metaKey ? 'D-' : '') +
			// Shift is part of the notation only where it is not already in the character.
			(event.shiftKey && (special || functionKey || ctrlKey || altKey) ? 'S-' : '');
		return `<${modifiers}${key}>`;
	}
	return key === '<' ? '<LT>' : key;
}
