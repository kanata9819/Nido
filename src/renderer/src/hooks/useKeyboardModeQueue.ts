import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Panel } from '../types';
import { isAltGraph } from '../keyboard';

const needsMode = (event: KeyboardEvent): boolean =>
	!event.altKey &&
	!event.metaKey &&
	((!event.ctrlKey &&
		(event.key === ' ' || (event.shiftKey && ['H', 'L'].includes(event.key)))) ||
		(event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'p'));

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
	checkingMode: React.RefObject<boolean>;
	defer: (event: KeyboardEvent, focusedInput: string | null | undefined) => boolean;
} {
	const queued = useRef<KeyboardEvent[]>([]);
	const checkingMode = useRef(false);
	const replayed = useRef(new WeakSet<KeyboardEvent>());
	const current = useRef({ active, panel, leader, mode });
	useLayoutEffect(() => {
		current.current = { active, panel, leader, mode };
	}, [active, panel, leader, mode]);

	const defer = (event: KeyboardEvent, focusedInput: string | null | undefined): boolean => {
		// Redraw mode notifications can trail rapid input. Check the actual mode before
		// consuming text as a Normal-mode UI shortcut, retaining following keys in order.
		if (
			!replayed.current.has(event) &&
			(checkingMode.current ||
				(focusedInput === 'editor' && !panel && !leader && needsMode(event)))
		) {
			event.preventDefault();
			event.stopPropagation();
			queued.current.push(
				new KeyboardEvent('keydown', {
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
				})
			);
			if (!checkingMode.current) {
				checkingMode.current = true;
				run(
					(async () => {
						try {
							while (queued.current.length) {
								const next = queued.current.shift()!;
								const context = current.current;
								if (
									document.activeElement?.getAttribute('data-editor-input') ===
										'editor' &&
									!context.panel &&
									!context.leader &&
									needsMode(next)
								) {
									const actual = await window.nido.inputMode(context.active);
									context.mode.current[context.active] =
										actual === 'n'
											? 'normal'
											: actual.startsWith('i')
												? 'insert'
												: actual;
								}
								replayed.current.add(next);
								// Commit a menu transition before handling the next buffered key.
								flushSync(() => document.activeElement?.dispatchEvent(next));
							}
						} finally {
							checkingMode.current = false;
							queued.current.length = 0;
						}
					})()
				);
			}
			return true;
		}
		return false;
	};

	return { checkingMode, defer };
}
