import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { onNidoEvent } from '../../../nidoEvents';

/** The insert-mode completion menu as Neovim shows it. */
export interface Menu {
	/** Neovim's popupmenu items: word, kind, menu and info. */
	items: [string, string, string, string][];
	selected: number;
	row: number;
	column: number;
	/** Whether the language server is still refreshing the items; selection waits until it is done. */
	pending?: boolean;
}

/**
 * The completion menu of workspace `id`, following Neovim's popupmenu_* redraw events. Keys
 * typed in the editor input (`inputRef`) that end completion close it.
 */
export function useCompletionMenu(
	id: string,
	inputRef: RefObject<HTMLTextAreaElement | null>
): Menu | undefined {
	const [menu, setMenu] = useState<Menu>();
	const refreshing = useRef(false);
	const currentMenu = useRef(menu);
	useLayoutEffect(() => {
		currentMenu.current = menu;
	}, [menu]);
	// Follow Neovim: show, select and hide the menu, and close it when insert mode ends.
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (event.id !== id) {
					return;
				}
				if (
					(event.type === 'state' || event.type === 'statePatch') &&
					event.state.mode &&
					!event.state.mode.startsWith('i')
				) {
					refreshing.current = false;
					setMenu(undefined);
				}
				if (event.type !== 'redraw') {
					return;
				}
				for (const [name, ...calls] of event.events) {
					for (const args of calls) {
						if (name === 'nido_completion_refresh') {
							const pending = args[0] === true;
							refreshing.current = pending;
							setMenu((current) => {
								if (!current) {
									return current;
								}
								if (pending) {
									return current.pending
										? current
										: { ...current, pending: true };
								}
								if (!current.pending) {
									return current;
								}
								return args[1] === true
									? { ...current, pending: false }
									: undefined;
							});
						}
						if (name === 'popupmenu_show') {
							// Grid -1 is command-line completion, which NeovimUI draws.
							if (Number(args[4]) === -1) {
								setMenu(undefined);
								continue;
							}
							setMenu({
								items: args[0] as Menu['items'],
								selected: Number(args[1]),
								row: Number(args[2]),
								column: Number(args[3]),
								pending: refreshing.current
							});
						}
						if (name === 'popupmenu_select') {
							setMenu(
								(current) => current && { ...current, selected: Number(args[0]) }
							);
						}
						if (name === 'popupmenu_hide') {
							const pending = refreshing.current;
							setMenu((current) =>
								pending && current
									? { ...current, pending: true, selected: -1 }
									: undefined
							);
						}
					}
				}
			}),
		[id]
	);
	// Close the menu on keys that end completion, and on blur. Keys that keep completing,
	// such as letters and Backspace, keep it open; while it refreshes, navigation waits.
	useEffect(() => {
		const anchor = inputRef.current;
		if (!anchor) {
			return;
		}
		const onKey = (event: KeyboardEvent): void => {
			if (
				event.isComposing ||
				event.keyCode === 229 ||
				anchor.hasAttribute('data-composing')
			) {
				return;
			}
			const navigation =
				['ArrowUp', 'ArrowDown'].includes(event.key) ||
				(event.ctrlKey && ['n', 'p'].includes(event.key));
			if (currentMenu.current?.pending && (navigation || event.key === 'Tab')) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (
				navigation ||
				['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) ||
				(event.ctrlKey && event.code === 'Space') ||
				(!event.ctrlKey &&
					!event.altKey &&
					!event.metaKey &&
					(event.key === 'Backspace' || /^[\p{L}\p{N}_]$/u.test(event.key)))
			) {
				return;
			}
			refreshing.current = false;
			setMenu(undefined);
		};
		const close = (): void => {
			refreshing.current = false;
			setMenu(undefined);
		};
		anchor.addEventListener('keydown', onKey, true);
		anchor.addEventListener('blur', close);
		return () => {
			anchor.removeEventListener('keydown', onKey, true);
			anchor.removeEventListener('blur', close);
		};
	}, [inputRef]);
	return menu;
}
