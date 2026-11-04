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

  const keydown = (event: KeyboardEvent): void => {
    if (isOwnedByFocusedElement(event, checkingMode.current)) {
      return;
    }
    if (isAltGraph(event) && !checkingMode.current) {
      return;
    }

    const consume = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const focusedInput = document.activeElement?.getAttribute('data-editor-input');
    const terminalFocused = focusedInput === 'terminal';
    if (defer(event, focusedInput)) {
      return;
    }
    if (isAltGraph(event)) {
      return;
    }
    const key = event.key.toLowerCase();
    const isNormalMode = (mode.current[active] || 'normal') === 'normal';
    const editorWorkspace =
      workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal';
    const togglePanel = (value: Exclude<Panel, null>): void => {
      if (panel === value) {
        focusEditor();
      } else {
        showPanel(value);
      }
    };

    if (focusedInput === 'editor' && isNormalMode && isCtrl(event, '*', '#')) {
      consume();
      run(window.nido.input(active, event.key));
      return;
    }

    if (event.key === 'Escape') {
      if (panel === 'git') {
        return;
      }
      if (terminalFocused && !panel) {
        return;
      }
      if (document.activeElement?.closest('[data-references-panel]')) {
        consume();
        closeReferences();
        return;
      }
      if (error) {
        consume();
        dismissError();
        return;
      }

      if (panel || leader || focusedInput !== 'editor') {
        consume();
        focusEditor();
        return;
      }
    }

    // Panel toggles: these work even while another panel is open.
    if (active && isCtrlShift(event, 'm')) {
      consume();
      togglePanel('problems');
      return;
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
      return;
    }
    if (isCtrlShift(event, 'x')) {
      consume();
      if (!event.repeat) {
        togglePanel('extensions');
      }
      return;
    }
    if (active && !terminalFocused && isCtrlShift(event, 'h')) {
      consume();
      if (!event.repeat) {
        togglePanel('history');
      }
      return;
    }
    if (active && editorWorkspace && isCtrlShift(event, 'f')) {
      consume();
      if (!event.repeat) {
        showPanel('search');
      }
      return;
    }
    if (active && !terminalFocused && editorWorkspace && isCtrlShift(event, 'o')) {
      consume();
      if (!event.repeat) {
        showPanel('symbols');
      }
      return;
    }
    if (panel) {
      if (modal.current && trapTabFocus(modal.current, event)) {
        consume();
      }
      return;
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
          moveCurrentBuffer(key === 'pageup' ? -1 : 1);
        }
        focusEditor();
      }
      return;
    }
    if (active && !terminalFocused && isUnmodified(event) && debugKeys.includes(event.key)) {
      consume();
      run(window.nido.debug(active, debugActionFor(event)));
      if (!document.activeElement?.closest('[data-debug-panel]')) {
        focusEditor();
      }
      return;
    }
    if (event.ctrlKey && event.key === 'Tab') {
      consume();
      nextWorkspace(event.shiftKey ? -1 : 1);
      return;
    }
    if (active && isCtrl(event, '@', '`')) {
      consume();
      toggleTerminal();
      return;
    }
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
      return;
    }
    if (event.altKey && /^[1-9]$/.test(event.key)) {
      consume();
      const w = workspaces[Number(event.key) - 1];
      if (w) {
        activate(w.id);
      }
      return;
    }
    if (event.ctrlKey && event.shiftKey && key === 'n') {
      consume();
      void create();
      return;
    }
    if (event.ctrlKey && event.shiftKey && key === 'p') {
      consume();
      showPanel('commands');
      return;
    }
    if (active && isCtrlShift(event, 'g')) {
      consume();
      showPanel('git');
      return;
    }
    if (terminalFocused) {
      if (isCtrlShift(event, 'r')) {
        consume();
        if (!event.repeat) {
          restartShell();
        }
      }
      return;
    }

    // Editor-only shortcuts below.
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

  return keydown;
}
