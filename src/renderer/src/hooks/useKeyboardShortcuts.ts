import type { Panel, Item } from '../types';
import type { Workspace } from '../../../shared/types';

interface UseKeyboardShortcutsParams {
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
  create: () => Promise<void>;
  showPanel: (value: Panel) => void;
  commands: Item[];
  state: { buffers: { id: number }[]; current: number };
  run: (promise: Promise<unknown>) => void;
  setLeader: (value: boolean) => void;
  activate: (id: string) => void;
}

export function useKeyboardShortcuts({
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

    if (event.key === 'Escape') {
      if (error) {
        consume();
        setError('');
        setFocusTick((n) => n + 1);
        return;
      }

      if (panel || leader || (document.activeElement as HTMLElement)?.getAttribute('aria-label') !== 'Neovim input') {
        consume();
        focusEditor();
        return;
      }
    }
    if (panel) {
      if (event.key === 'Tab' && modal.current) {
        const nodes = [...modal.current.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')];
        const first = nodes[0],
          last = nodes[nodes.length - 1];
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
    if (active && !event.ctrlKey && !event.altKey && !event.metaKey && ['F5', 'F9', 'F10', 'F11'].includes(event.key)) {
      consume();
      const action = event.key === 'F9' ? 'breakpoint' : event.key === 'F10' ? 'over' : event.key === 'F11' ? (event.shiftKey ? 'out' : 'into') : (event.shiftKey ? 'stop' : 'start');
      run(window.nido.debug(active, action));
      focusEditor();
      return;
    }
    if (event.ctrlKey && event.key === 'Tab') {
      consume();
      nextWorkspace(event.shiftKey ? -1 : 1);
      return;
    }
    if (
      active &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      ['h', 'l'].includes(event.key.toLowerCase())
    ) {
      consume();
      if (event.key.toLowerCase() === 'h') {
        showExplorer();
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
    if (event.ctrlKey && event.key.toLowerCase() === 'p' && active && !mode.current[active]?.startsWith('insert')) {
      consume();
      showPanel('files');
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 's' && active) {
      consume();
      run(window.nido.save(active));
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
      document.activeElement?.getAttribute('aria-label') === 'Neovim input' &&
      (mode.current[active] || 'normal') === 'normal' &&
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
      document.activeElement?.getAttribute('aria-label') === 'Neovim input' &&
      (mode.current[active] || 'normal') === 'normal'
    ) {
      consume();
      setLeader(true);
    }
  };

  return keydown;
}
