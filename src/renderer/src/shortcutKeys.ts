import type { DebugAction } from '../../shared/types';

type Modifiers = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** Ctrl+Shift with no Alt/Meta, on any of the given (lower-case) keys. */
export function isCtrlShift(event: Modifiers, ...keys: string[]): boolean {
	return (
		event.ctrlKey &&
		event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		keys.includes(event.key.toLowerCase())
	);
}

/** Ctrl with no Alt/Meta (Shift is ignored), on any of the given keys as typed. */
export function isCtrl(event: Modifiers, ...keys: string[]): boolean {
	return event.ctrlKey && !event.altKey && !event.metaKey && keys.includes(event.key);
}

/** No Ctrl/Alt/Meta held. Shift is allowed. */
export function isUnmodified(event: Modifiers): boolean {
	return !event.ctrlKey && !event.altKey && !event.metaKey;
}

/** Elements that handle their own keyboard input and must not see app shortcuts. */
const selfHandledRegions =
	'[data-type-information], [data-diagnostic-information], [data-explorer-commands], [data-neovim-ui]';

/**
 * Keys that app shortcuts must leave alone entirely because the focused element,
 * an IME composition or a pending Neovim command line owns them.
 */
export function isOwnedByFocusedElement(event: KeyboardEvent, checkingMode: boolean): boolean {
	const focused = document.activeElement;
	if (event.key === 'Escape' && focused?.closest('[data-workspace-search]')) {
		return true;
	}
	if (
		focused?.closest('[data-markdown-preview]') &&
		(event.key === 'Escape' || (event.ctrlKey && event.key.toLowerCase() === 'j'))
	) {
		return true;
	}
	if (focused?.closest(selfHandledRegions)) {
		return true;
	}
	// Deferring command text for Normal-mode shortcuts lets Unicode overtake spaces.
	// Ctrl+P still checks the actual mode: the command card can outlive queued Enter input.
	if (
		!checkingMode &&
		focused?.hasAttribute('data-nvim-command-active') &&
		isUnmodified(event) &&
		event.key.length === 1
	) {
		return true;
	}
	return event.isComposing || event.keyCode === 229;
}

const focusable =
	'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';

/** Keeps Tab focus cycling inside `container`. Returns true when it moved focus. */
export function trapTabFocus(container: HTMLElement, event: KeyboardEvent): boolean {
	if (event.key !== 'Tab') {
		return false;
	}
	const nodes = [...container.querySelectorAll<HTMLElement>(focusable)];
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		last?.focus();
		return true;
	}
	if (!event.shiftKey && document.activeElement === last) {
		first?.focus();
		return true;
	}
	return false;
}

export const debugKeys = ['F5', 'F9', 'F10', 'F11'];

/** F5 start / Shift+F5 stop, F9 breakpoint, F10 over, F11 into / Shift+F11 out. */
export function debugActionFor(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): DebugAction {
	switch (event.key) {
		case 'F9':
			return 'breakpoint';
		case 'F10':
			return 'over';
		case 'F11':
			return event.shiftKey ? 'out' : 'into';
		default:
			return event.shiftKey ? 'stop' : 'start';
	}
}
