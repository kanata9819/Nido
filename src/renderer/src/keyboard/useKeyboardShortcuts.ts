import { isAltGraph } from './keyboard';
import { isCtrl, isOwnedByFocusedElement, trapTabFocus } from './shortcutKeys';
import { useKeyboardModeQueue } from './useKeyboardModeQueue';
import type { Panel, Item } from '../types';
import type { Workspace } from '../../../shared/types';
import {
	handleEditorShortcuts,
	handleEscape,
	handlePanelToggles,
	handleTerminalShortcuts,
	handleWorkspaceShortcuts,
	type Shortcut,
	type ShortcutContext
} from './shortcutHandlers';

/** What the shortcuts act on: app state and the actions they trigger. */
export interface UseKeyboardShortcutsParams {
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
	moveWorkspace: (offset: number) => void;
	showExplorer: () => void;
	showDebugger: () => void;
	closeReferences: () => void;
	toggleTerminal: () => void;
	restartShell: () => void;
	/** Put the focused terminal in copy mode. */
	terminalCopyMode: () => void;
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
 * in useKeyboardModeQueue until the mode is known. The shortcuts themselves are in
 * shortcutHandlers.ts.
 */
export function useKeyboardShortcuts(
	params: UseKeyboardShortcutsParams
): (event: KeyboardEvent) => void {
	const { active, panel, leader, mode, run, workspaces, modal } = params;
	const { checkingMode, defer } = useKeyboardModeQueue({ active, panel, leader, mode, run });
	const workspace = workspaces.find((w) => w.id === active);
	const context: ShortcutContext = { ...params, waking: !!workspace?.sleeping };

	return (event: KeyboardEvent): void => {
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
			editorWorkspace: workspace?.kind !== 'terminal'
		};

		// Ctrl+* and Ctrl+# reach Neovim as plain * and # in Normal mode.
		if (focusedInput === 'editor' && shortcut.isNormalMode && isCtrl(event, '*', '#')) {
			shortcut.consume();
			run(window.nido.input(active, event.key));
			return;
		}
		if (handleEscape(context, shortcut) || handlePanelToggles(context, shortcut)) {
			return;
		}
		// While a panel is open, Tab stays inside it and other shortcuts are left to the panel.
		if (panel) {
			if (modal.current && trapTabFocus(modal.current, event)) {
				shortcut.consume();
			}
			return;
		}
		if (handleWorkspaceShortcuts(context, shortcut)) {
			return;
		}
		if (shortcut.terminalFocused) {
			handleTerminalShortcuts(context, shortcut);
			return;
		}
		handleEditorShortcuts(context, shortcut);
	};
}
