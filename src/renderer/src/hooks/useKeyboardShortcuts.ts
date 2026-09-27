import type { Panel, Item } from '../types';
import type { DebugAction, Workspace } from '../../../shared/types';

interface UseKeyboardShortcutsParams {
  save: () => void;
  panel: Panel;
  leader: boolean;
  error: string;
  setError: (value: string) => void;
  setFocusTick: React.Dispatch<React.SetStateAction<number>>;
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
  state: { buffers: { id: number }[]; current: number };
  run: (promise: Promise<unknown>) => void;
  setLeader: (value: boolean) => void;
  activate: (id: string) => void;
}

export function useKeyboardShortcuts({
  save,
  panel,
  leader,
  error,
  setError,
  setFocusTick,
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
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    const consume = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const focusedLabel = document.activeElement?.getAttribute('aria-label');
    const terminalFocused = focusedLabel === 'Terminal input';
    const isNormalMode = (mode.current[active] || 'normal') === 'normal';

    if (event.key === 'Escape') {
      if (panel === 'git') {
        return;
      }
      if (terminalFocused && !panel) {
        return;
      }
      if (document.activeElement?.closest('[aria-label="References"]')) {
        consume();
        closeReferences();
        return;
      }
      if (error) {
        consume();
        setError('');
        setFocusTick((n) => n + 1);
        return;
      }

      if (panel || leader || focusedLabel !== 'Neovim input') {
        consume();
        focusEditor();
        return;
      }
    }
    if (
      active &&
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === 'm'
    ) {
      consume();
      if (panel === 'problems') {
        focusEditor();
      } else {
        showPanel('problems');
      }
      return;
    }
    if (panel) {
      if (event.key === 'Tab' && modal.current) {
        const nodes = [
          ...modal.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
          )
        ];
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          consume();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          consume();
          first?.focus();
        }
      }
      return;
    }
    if (
      active &&
      !terminalFocused &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      ['F5', 'F9', 'F10', 'F11'].includes(event.key)
    ) {
      consume();
      let action: DebugAction = 'start';
      if (event.key === 'F9') {
        action = 'breakpoint';
      } else if (event.key === 'F10') {
        action = 'over';
      } else if (event.key === 'F11') {
        action = event.shiftKey ? 'out' : 'into';
      } else if (event.shiftKey) {
        action = 'stop';
      }
      run(window.nido.debug(active, action));
      if (!document.activeElement?.closest('[aria-label="Debugger"]')) {
        focusEditor();
      }
      return;
    }
    if (event.ctrlKey && event.key === 'Tab') {
      consume();
      nextWorkspace(event.shiftKey ? -1 : 1);
      return;
    }
    if (active && event.ctrlKey && !event.altKey && !event.metaKey && ['@', '`'].includes(event.key)) {
      consume();
      toggleTerminal();
      return;
    }
    if (
      active &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      ['h', 'j', 'k', 'l'].includes(event.key.toLowerCase())
    ) {
      consume();
      if (event.key.toLowerCase() === 'h') {
        showExplorer();
      } else if (event.key.toLowerCase() === 'j') {
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
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'n') {
      consume();
      void create();
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
      consume();
      showPanel('commands');
      return;
    }
    if (
      active &&
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === 'g'
    ) {
      consume();
      showPanel('git');
      return;
    }
    if (terminalFocused) {
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'r') {
        consume();
        if (!event.repeat) {
          restartShell();
        }
      }
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'p' && active && !mode.current[active]?.startsWith('insert')) {
      consume();
      showPanel('files');
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 's' && active) {
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
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      ['H', 'L'].includes(event.key) &&
      focusedLabel === 'Neovim input' &&
      isNormalMode &&
      state.buffers.length > 0
    ) {
      consume();
      const index = state.buffers.findIndex((buffer) => buffer.id === state.current);
      const offset = event.key === 'H' ? -1 : 1;
      const next = state.buffers[(index + offset + state.buffers.length) % state.buffers.length];
      run(window.nido.selectBuffer(active, next.id));
      return;
    }
    if (
      event.key === ' ' &&
      !event.ctrlKey &&
      !event.altKey &&
      focusedLabel === 'Neovim input' &&
      isNormalMode
    ) {
      consume();
      setLeader(true);
    }
  };

  return keydown;
}
