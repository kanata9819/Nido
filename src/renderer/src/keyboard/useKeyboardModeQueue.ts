import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Panel } from '../types';
import { isAltGraph } from './keyboard';
import { afterEditorClick } from '../editor/editorClick';

/**
 * Whether a key is a UI shortcut only in Normal mode (Space for the leader, Shift+H/L for
 * tabs, Ctrl+P for files), so its meaning depends on Neovim's current mode.
 */
const needsMode = (event: KeyboardEvent): boolean =>
	!event.altKey &&
	!event.metaKey &&
	((!event.ctrlKey &&
		(event.key === ' ' || (event.shiftKey && ['H', 'L'].includes(event.key)))) ||
		(event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'p'));

/** A new keydown event with the same key, to dispatch again after the mode is known. */
function copyKeyDown(event: KeyboardEvent): KeyboardEvent {
	return new KeyboardEvent('keydown', {
		key: event.key,
		code: event.code,
		location: event.location,
		repeat: event.repeat,
		ctrlKey: event.ctrlKey,
		altKey: event.altKey,
		shiftKey: event.shiftKey,
		metaKey: event.metaKey,
		modifierAltGraph: isAltGraph(event),
		bubbles: true,
		cancelable: true
	});
}

/** A dispatched keydown has no browser default action. Replay printable text in native fields. */
function replayText(target: Element, event: KeyboardEvent): void {
	if (
		!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) ||
		target.disabled ||
		target.readOnly ||
		event.metaKey ||
		((event.ctrlKey || event.altKey) && !isAltGraph(event)) ||
		[...event.key].length !== 1
	) {
		return;
	}
	const { selectionStart: start, selectionEnd: end, maxLength } = target;
	if (
		start === null ||
		end === null ||
		(maxLength >= 0 && target.value.length - (end - start) + event.key.length > maxLength)
	) {
		return;
	}
	const input = { data: event.key, inputType: 'insertText', bubbles: true, composed: true };
	if (!target.dispatchEvent(new InputEvent('beforeinput', { ...input, cancelable: true }))) {
		return;
	}
	target.setRangeText(event.key, start, end, 'end');
	target.dispatchEvent(new InputEvent('input', input));
}

/** The mode name the shortcuts use, from Neovim's mode() value. */
function modeName(mode: string): string {
	if (mode === 'n') {
		return 'normal';
	}
	return mode.startsWith('i') ? 'insert' : mode;
}

/**
 * Holds keys whose meaning depends on Neovim's mode until the real mode is known. The mode
 * the renderer last heard of can trail fast typing: Space typed right after i must insert a
 * space, not open the leader menu. `defer` takes such a key, asks Neovim for its mode, and
 * dispatches the key (and every key typed meanwhile) again in order. A focus or workspace
 * change outside that replay discards the waiting keys.
 */
export function useKeyboardModeQueue({
	active,
	panel,
	leader,
	mode,
	run
}: {
	active: string;
	panel: Panel;
	leader: boolean;
	mode: React.MutableRefObject<Record<string, string>>;
	run: (promise: Promise<unknown>) => void;
}): {
	checkingMode: () => boolean;
	defer: (event: KeyboardEvent, focusedInput: string | null | undefined) => boolean;
} {
	// Keys waiting for the mode check, and the copies already dispatched again, which pass.
	const pending = useRef<KeyboardEvent[]>(undefined);
	const replaying = useRef(false);
	const replayed = useRef(new WeakSet<KeyboardEvent>());
	const current = useRef({ active, panel, leader, mode });
	useLayoutEffect(() => {
		if (current.current.active !== active) {
			pending.current = undefined;
		}
		current.current = { active, panel, leader, mode };
	}, [active, panel, leader, mode]);
	useLayoutEffect(() => {
		const focusChanged = (): void => {
			if (!replaying.current) {
				pending.current = undefined;
			}
		};
		document.addEventListener('focusout', focusChanged);
		return () => {
			pending.current = undefined;
			document.removeEventListener('focusout', focusChanged);
		};
	}, []);

	async function replayKeys(keys: KeyboardEvent[]): Promise<void> {
		try {
			for (const next of keys) {
				if (pending.current !== keys) {
					return;
				}
				const context = current.current;
				const target = document.activeElement;
				if (
					target?.getAttribute('data-editor-input') === 'editor' &&
					!context.panel &&
					!context.leader &&
					needsMode(next)
				) {
					const actual = await afterEditorClick(context.active, () =>
						window.nido.inputMode(context.active)
					);
					if (pending.current !== keys || document.activeElement !== target) {
						return;
					}
					context.mode.current[context.active] = modeName(actual);
				}
				replayed.current.add(next);
				// A replayed shortcut may itself focus a menu for the remaining keys.
				replaying.current = true;
				try {
					flushSync(() => {
						if (target?.dispatchEvent(next) && target === document.activeElement) {
							replayText(target, next);
						}
					});
				} finally {
					replaying.current = false;
				}
			}
		} catch (error) {
			if (pending.current === keys) {
				throw error;
			}
		} finally {
			if (pending.current === keys) {
				pending.current = undefined;
			}
		}
	}

	const defer = (event: KeyboardEvent, focusedInput: string | null | undefined): boolean => {
		// Redraw mode notifications can trail rapid input. Check the actual mode before
		// consuming text as a Normal-mode UI shortcut, retaining following keys in order.
		if (
			replayed.current.has(event) ||
			(!pending.current &&
				!(focusedInput === 'editor' && !panel && !leader && needsMode(event)))
		) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		const key = copyKeyDown(event);
		if (pending.current) {
			pending.current.push(key);
			return true;
		}
		const keys = [key];
		pending.current = keys;
		run(replayKeys(keys));
		return true;
	};

	return { checkingMode: () => pending.current !== undefined, defer };
}
