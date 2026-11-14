import type { Panel, Item } from '../types';
import type { Workspace } from '../../../shared/types';
import { isAltGraph } from '../keyboard';
import {
	debugActionFor,
	debugKeys,
	isCtrl,
	isCtrlShift,
	isOwnedByFocusedElement,
	isUnmodified,
	trapTabFocus
} from '../shortcutKeys';
import { useKeyboardModeQueue } from './useKeyboardModeQueue';

/** One key press and the focus state that decides which shortcut it triggers. */
interface Shortcut {
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

/** What the shortcuts act on: app state and the actions they trigger. */
interface UseKeyboardShortcutsParams {
	save: () => void;
	panel: Panel;
	leader: boolean;
	error: string;
	/** Clears the error notice and hands focus back to the editor. */
	dismissError: () => void;
	focusEditor: () => void;
	modal: React.RefObject<HTMLDivElement | null>;
	mode: React.MutableRefObject<Record<string, string>>;
	active: string;
	workspaces: Workspace[];
	nextWorkspace: (offset: number) => void;
	showExplorer: () => void;
	showDebugger: () => void;
	closeReferences: () => void;
	toggleTerminal: () => void;
	restartShell: () => void;
	create: () => Promise<void>;
	showPanel: (value: Panel) => void;
	commands: Item[];
	state: { buffers: { id: number }[]; current: number; filetype: string };
	run: (promise: Promise<unknown>) => void;
	setLeader: (value: boolean) => void;
	activate: (id: string) => void;
}

/**
 * The window-wide keydown handler for Nido's shortcuts: the Space leader menu, Ctrl+Shift
 * shortcuts, tab and workspace switching, and Escape. Keys that depend on Neovim's mode wait
 * in useKeyboardModeQueue until the mode is known.
 */
export function useKeyboardShortcuts({
	save,
	panel,
	leader,
	error,
	dismissError,
	focusEditor,
	modal,
	mode,
	active,
	workspaces,
	nextWorkspace,
	showExplorer,
	showDebugger,
	closeReferences,
	toggleTerminal,
	restartShell,
	create,
	showPanel,
	commands,
	state,
	run,
	setLeader,
	activate
}: UseKeyboardShortcutsParams): (event: KeyboardEvent) => void {
	const { checkingMode, defer } = useKeyboardModeQueue({ active, panel, leader, mode, run });

	const currentBufferIndex = (): number =>
		state.buffers.findIndex((buffer) => buffer.id === state.current);
	/** Moves the current tab one place left or right, stopping at the ends. */
	const moveCurrentBuffer = (offset: -1 | 1): void => {
		const index = currentBufferIndex();
		const target = state.buffers[index + offset];
		if (index >= 0 && target) {
			run(window.nido.moveBuffer(active, state.current, target.id));
		}
	};
	/** Selects the previous or next tab, wrapping around. */
	const selectAdjacentBuffer = (offset: -1 | 1): void => {
		const count = state.buffers.length;
		const next = state.buffers[(currentBufferIndex() + offset + count) % count];
		run(window.nido.selectBuffer(active, next.id));
	};

	const waking = !!workspaces.find((workspace) => workspace.id === active)?.sleeping;

	/** Escape closes or leaves whatever has focus. Returns whether to stop handling the key. */
	const handleEscape = (shortcut: Shortcut): boolean => {
		const { event, consume, focusedInput, terminalFocused } = shortcut;
		if (event.key !== 'Escape') {
			return false;
		}
		if (panel === 'git') {
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
	};

	/** Panel toggles work even while another panel is open. Returns whether the key was handled. */
	const handlePanelToggles = (shortcut: Shortcut): boolean => {
		const { event, consume, terminalFocused, editorWorkspace } = shortcut;
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
	};

	/**
	 * Shortcuts for tabs, the debugger, workspaces, the terminal and the main panels, available in
	 * editors and terminals alike. Returns whether the key was handled.
	 */
	const handleWorkspaceShortcuts = (shortcut: Shortcut): boolean => {
		const { event, key, consume, focusedInput, terminalFocused, editorWorkspace } = shortcut;
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
					moveCurrentBuffer(key === 'pageup' ? -1 : 1);
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
			nextWorkspace(event.shiftKey ? -1 : 1);
			return true;
		}
		if (active && isCtrl(event, '@', '`')) {
			consume();
			toggleTerminal();
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
				showExplorer();
			} else if (key === 'j') {
				showDebugger();
			} else {
				focusEditor();
			}
			return true;
		}
		if (event.altKey && /^[1-9]$/.test(event.key)) {
			consume();
			const w = workspaces[Number(event.key) - 1];
			if (w) {
				activate(w.id);
			}
			return true;
		}
		if (event.ctrlKey && event.shiftKey && key === 'n') {
			consume();
			void create();
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
	};

	/** Shortcuts while an editor, not a terminal, has focus. */
	const handleEditorShortcuts = (shortcut: Shortcut): void => {
		const { event, key, consume, focusedInput, isNormalMode } = shortcut;
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
			save();
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
			selectAdjacentBuffer(event.key === 'H' ? -1 : 1);
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
			setLeader(true);
		}
	};

	const keydown = (event: KeyboardEvent): void => {
		if (isOwnedByFocusedElement(event, checkingMode.current)) {
			return;
		}
		if (isAltGraph(event) && !checkingMode.current) {
			return;
		}
		const focusedInput = document.activeElement?.getAttribute('data-editor-input');
		if (defer(event, focusedInput)) {
			return;
		}
		if (isAltGraph(event)) {
			return;
		}
		const shortcut: Shortcut = {
			event,
			key: event.key.toLowerCase(),
			consume: () => {
				event.preventDefault();
				event.stopPropagation();
			},
			focusedInput,
			terminalFocused: focusedInput === 'terminal',
			isNormalMode: (mode.current[active] || 'normal') === 'normal',
			editorWorkspace:
				workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal'
		};

		// Ctrl+* and Ctrl+# reach Neovim as plain * and # in Normal mode.
		if (focusedInput === 'editor' && shortcut.isNormalMode && isCtrl(event, '*', '#')) {
			shortcut.consume();
			run(window.nido.input(active, event.key));
			return;
		}
		if (handleEscape(shortcut) || handlePanelToggles(shortcut)) {
			return;
		}
		// While a panel is open, Tab stays inside it and other shortcuts are left to the panel.
		if (panel) {
			if (modal.current && trapTabFocus(modal.current, event)) {
				shortcut.consume();
			}
			return;
		}
		if (handleWorkspaceShortcuts(shortcut)) {
			return;
		}
		if (shortcut.terminalFocused) {
			if (isCtrlShift(event, 'r')) {
				shortcut.consume();
				if (!event.repeat) {
					restartShell();
				}
			}
			return;
		}
		handleEditorShortcuts(shortcut);
	};

	return keydown;
}
