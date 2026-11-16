// The shortcut handlers of useKeyboardShortcuts, one per group of keys. Each reads the app
// state and actions from a ShortcutContext and returns whether it handled the key.
import type { Panel } from '../types';
import { debugActionFor, debugKeys, isCtrl, isCtrlShift, isUnmodified } from './shortcutKeys';
import type { UseKeyboardShortcutsParams } from './useKeyboardShortcuts';

/** One key press and the focus state that decides which shortcut it triggers. */
export interface Shortcut {
	event: KeyboardEvent;
	/** The key in lower case. */
	key: string;
	/** Stop the key from reaching Neovim or the browser. */
	consume: () => void;
	/** 'editor' or 'terminal' when Neovim's input has focus. */
	focusedInput: string | null | undefined;
	terminalFocused: boolean;
	isNormalMode: boolean;
	/** The active workspace is an editor rather than a standalone terminal. */
	editorWorkspace: boolean;
}

/** What the handlers act on: the hook's parameters, and whether the selected workspace wakes. */
export interface ShortcutContext extends UseKeyboardShortcutsParams {
	waking: boolean;
}

function currentBufferIndex({ state }: ShortcutContext): number {
	return state.buffers.findIndex((buffer) => buffer.id === state.current);
}

/** Moves the current tab one place left or right, stopping at the ends. */
function moveCurrentBuffer(context: ShortcutContext, offset: -1 | 1): void {
	const { state, active, run } = context;
	const index = currentBufferIndex(context);
	const target = state.buffers[index + offset];
	if (index >= 0 && target) {
		run(window.nido.moveBuffer(active, state.current, target.id));
	}
}

/** Selects the previous or next tab, wrapping around. */
function selectAdjacentBuffer(context: ShortcutContext, offset: -1 | 1): void {
	const { state, active, run } = context;
	const count = state.buffers.length;
	const next = state.buffers[(currentBufferIndex(context) + offset + count) % count];
	run(window.nido.selectBuffer(active, next.id));
}

/** Escape closes or leaves whatever has focus. Returns whether to stop handling the key. */
export function handleEscape(context: ShortcutContext, shortcut: Shortcut): boolean {
	const { event, consume, focusedInput, terminalFocused } = shortcut;
	const { panel, leader, error, closeReferences, dismissError, focusEditor, waking } = context;
	if (event.key !== 'Escape') {
		return false;
	}
	// The Git browser and the GitHub page handle Escape themselves, stepping back first.
	if (panel === 'git' || panel === 'github') {
		return true;
	}
	if (terminalFocused && !panel) {
		return true;
	}
	if (document.activeElement?.closest('[data-references-panel]')) {
		consume();
		closeReferences();
		return true;
	}
	if (error) {
		consume();
		dismissError();
		return true;
	}
	// While the selected workspace wakes, nothing has focus and its typing waits for it:
	// Escape is part of that typing, as in `ifoo<Esc>`.
	const idle =
		document.activeElement === document.body ||
		document.activeElement === document.documentElement;
	if (!panel && !leader && idle && waking) {
		return true;
	}
	if (panel || leader || focusedInput !== 'editor') {
		consume();
		focusEditor();
		return true;
	}
	return false;
}

/** Panel toggles work even while another panel is open. Returns whether the key was handled. */
export function handlePanelToggles(context: ShortcutContext, shortcut: Shortcut): boolean {
	const { event, consume, terminalFocused, editorWorkspace } = shortcut;
	const { active, panel, state, focusEditor, showPanel } = context;
	const togglePanel = (value: Exclude<Panel, null>): void => {
		if (panel === value) {
			focusEditor();
		} else {
			showPanel(value);
		}
	};
	if (active && isCtrlShift(event, 'm')) {
		consume();
		togglePanel('problems');
		return true;
	}
	if (
		active &&
		!terminalFocused &&
		state.filetype === 'markdown' &&
		isCtrlShift(event, 'v') &&
		(!panel || panel === 'markdown')
	) {
		consume();
		togglePanel('markdown');
		return true;
	}
	if (isCtrlShift(event, 'x')) {
		consume();
		if (!event.repeat) {
			togglePanel('extensions');
		}
		return true;
	}
	if (active && !terminalFocused && isCtrlShift(event, 'h')) {
		consume();
		if (!event.repeat) {
			togglePanel('history');
		}
		return true;
	}
	if (active && editorWorkspace && isCtrlShift(event, 'f')) {
		consume();
		if (!event.repeat) {
			showPanel('search');
		}
		return true;
	}
	if (active && !terminalFocused && editorWorkspace && isCtrlShift(event, 'o')) {
		consume();
		if (!event.repeat) {
			showPanel('symbols');
		}
		return true;
	}
	return false;
}

/**
 * Shortcuts for tabs, the debugger, workspaces, the terminal and the main panels, available in
 * editors and terminals alike. Returns whether the key was handled.
 */
export function handleWorkspaceShortcuts(context: ShortcutContext, shortcut: Shortcut): boolean {
	const { event, key, consume, focusedInput, terminalFocused, editorWorkspace } = shortcut;
	const { active, workspaces, run, focusEditor, showPanel } = context;
	if (
		active &&
		event.altKey &&
		event.shiftKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		(key === 'pageup' || key === 'pagedown')
	) {
		consume();
		if (!event.repeat) {
			context.moveWorkspace(key === 'pageup' ? -1 : 1);
		}
		return true;
	}
	if (
		active &&
		!terminalFocused &&
		editorWorkspace &&
		isCtrlShift(event, 't', 'pageup', 'pagedown')
	) {
		consume();
		if (!event.repeat) {
			if (key === 't') {
				run(window.nido.reopenBuffer(active));
			} else {
				moveCurrentBuffer(context, key === 'pageup' ? -1 : 1);
			}
			focusEditor();
		}
		return true;
	}
	if (active && !terminalFocused && isUnmodified(event) && debugKeys.includes(event.key)) {
		consume();
		run(window.nido.debug(active, debugActionFor(event)));
		if (!document.activeElement?.closest('[data-debug-panel]')) {
			focusEditor();
		}
		return true;
	}
	if (event.ctrlKey && event.key === 'Tab') {
		consume();
		context.nextWorkspace(event.shiftKey ? -1 : 1);
		return true;
	}
	if (active && isCtrl(event, '@', '`')) {
		consume();
		context.toggleTerminal();
		return true;
	}
	// Ctrl+H/J/K/L move between the Explorer, the debugger and the editor.
	if (
		active &&
		event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		['h', 'j', 'k', 'l'].includes(key) &&
		!(key === 'k' && focusedInput === 'editor')
	) {
		consume();
		if (key === 'h') {
			context.showExplorer();
		} else if (key === 'j') {
			context.showDebugger();
		} else {
			focusEditor();
		}
		return true;
	}
	if (event.altKey && /^[1-9]$/.test(event.key)) {
		consume();
		const w = workspaces[Number(event.key) - 1];
		if (w) {
			context.activate(w.id);
		}
		return true;
	}
	if (event.ctrlKey && event.shiftKey && key === 'n') {
		consume();
		void context.create();
		return true;
	}
	if (event.ctrlKey && event.shiftKey && key === 'p') {
		consume();
		showPanel('commands');
		return true;
	}
	if (active && isCtrlShift(event, 'g')) {
		consume();
		showPanel('git');
		return true;
	}
	return false;
}

/** Shortcuts while an editor, not a terminal, has focus. */
export function handleEditorShortcuts(context: ShortcutContext, shortcut: Shortcut): void {
	const { event, key, consume, focusedInput, isNormalMode } = shortcut;
	const { active, mode, leader, commands, state, showPanel } = context;
	if (
		event.ctrlKey &&
		key === 'p' &&
		active &&
		!mode.current[active]?.startsWith('insert') &&
		!mode.current[active]?.startsWith('c')
	) {
		consume();
		showPanel('files');
		return;
	}
	if (event.ctrlKey && key === 's' && active) {
		consume();
		context.save();
		return;
	}
	// After Space, the next key runs the command bound to it.
	if (leader) {
		consume();
		if (event.key === ' ') {
			showPanel('commands');
		} else {
			commands.find((command) => command.key === event.key)?.run();
		}
		return;
	}
	if (
		event.shiftKey &&
		isUnmodified(event) &&
		['H', 'L'].includes(event.key) &&
		focusedInput === 'editor' &&
		isNormalMode &&
		state.buffers.length > 0
	) {
		consume();
		selectAdjacentBuffer(context, event.key === 'H' ? -1 : 1);
		return;
	}
	if (
		event.key === ' ' &&
		!event.ctrlKey &&
		!event.altKey &&
		focusedInput === 'editor' &&
		isNormalMode
	) {
		consume();
		context.setLeader(true);
	}
}

/**
 * Shortcuts while a terminal has focus: restart its shell or enter copy mode, and in the
 * terminal panel start, close or switch shells and maximize the panel.
 */
export function handleTerminalShortcuts(context: ShortcutContext, shortcut: Shortcut): void {
	const { event, key, consume, editorWorkspace } = shortcut;
	if (editorWorkspace && isCtrlShift(event, 't', 'w', 'pageup', 'pagedown', 'enter')) {
		consume();
		if (!event.repeat) {
			if (key === 'enter') {
				context.toggleTerminalMaximized();
			} else {
				context.terminalShell(
					key === 't'
						? 'add'
						: key === 'w'
							? 'close'
							: key === 'pageup'
								? 'previous'
								: 'next'
				);
			}
		}
		return;
	}
	if (isCtrlShift(event, 'r')) {
		consume();
		if (!event.repeat) {
			context.restartShell();
		}
	}
	// Ctrl+Shift+C: copy mode, to move through the output with Vim keys and copy it.
	if (isCtrlShift(event, 'c')) {
		consume();
		if (!event.repeat) {
			context.terminalCopyMode();
		}
	}
}
