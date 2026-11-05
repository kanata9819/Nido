// Registers the IPC handlers (`nido:<name>`) that the renderer calls.
// For example, window.nido.input() in the renderer makes preload send 'nido:input',
// which handle('input') below receives. Feature-specific handlers live in
// fileHandlers.ts, gitHandlers.ts, workspaceHandlers.ts and similar files.
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { release } from 'node:os';
import { Session } from './session';
import { registerFileHandlers } from './fileHandlers';
import { registerGitHandlers } from './gitHandlers';
import { registerWorkspaceHandlers } from './workspaceHandlers';
import { registerHistoryHandlers } from './historyHandlers';
import { registerLanguagePackHandlers } from './languagePackHandlers';
import { terminalShells, uiThemes, type TerminalShell, type UITheme } from '../shared/types';
import type { DebugAction, NidoEvent, Workspace } from '../shared/types';
import type { Updates } from './updater';
import { translate, type Language } from '../shared/i18n';
import { LanguagePacks } from './languagePacks';
import { availableTerminalShells } from './terminalShells';

/** Application-wide state, created in index.ts and shared by every handler. */
export interface AppState {
  language?: Language;
  order: string[];
  active: string;
  restoration: Promise<{ workspaces: Workspace[]; active: string; errors: string[] }> | undefined;
  prompting: boolean;
  closing: boolean;
  historyEnabled?: boolean;
}

/** Dependencies for registering handlers, also passed to each register*Handlers. */
export interface HandlerDeps {
  window: BrowserWindow;
  sessions: Map<string, Session>;
  state: AppState;
  neovimResources: string;
  send: (event: NidoEvent) => void;
}

export function registerHandlers({
  window,
  sessions,
  state,
  neovimResources,
  send,
  updates
}: HandlerDeps & { updates: Updates }): () => Promise<boolean> {
  // Find the Session for a workspace ID. A terminal ID resolves to that terminal's Session.
  function session(id: unknown): Session {
    const found =
      typeof id === 'string'
        ? sessions.get(id) ||
          [...sessions.values()].find((s) => s.terminal?.workspace.id === id)?.terminal
        : undefined;
    if (!found) {
      throw new Error('Workspace is no longer running.');
    }
    return found;
  }

  function shellChoice(value: unknown = 'auto'): TerminalShell {
    if (!terminalShells.includes(value as TerminalShell)) {
      throw new Error('Invalid terminal shell.');
    }
    return value as TerminalShell;
  }

  // Values from the renderer are untrusted: check their type and size before use.
  function text(value: unknown): string {
    if (typeof value !== 'string' || value.length > 4_000_000) {
      throw new Error('Invalid text.');
    }
    return value;
  }

  function integer(value: unknown, max = 1_000_000): number {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
      throw new Error('Invalid number.');
    }
    return Number(value);
  }

  // Register one handler. Only the application renderer may invoke the explicit API below.
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`nido:${name}`, (event, ...args: unknown[]) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      ) {
        throw new Error('Untrusted sender.');
      }
      return fn(...args);
    });
  };

  handle('availableTerminalShells', () => availableTerminalShells());

  const languagePacks = new LanguagePacks(neovimResources, app.getPath('userData'));
  registerLanguagePackHandlers({ window, sessions, state, send, handle, languagePacks });

  handle('updateState', () => updates.snapshot());
  handle('language', (value) => {
    if (value !== 'en' && value !== 'ja') {
      throw new Error('Invalid language.');
    }
    state.language = value;
  });
  handle('updateAction', (action) => {
    switch (action) {
      case 'check':
        return updates.check();
      case 'download':
        return updates.download();
      case 'install':
        return updates.install();
      default:
        throw new Error('Unknown update action.');
    }
  });

  const captureHistory = registerHistoryHandlers({
    window,
    sessions,
    state,
    neovimResources,
    send,
    handle,
    session,
    text
  });
  const prepareToQuit = registerWorkspaceHandlers({
    window,
    sessions,
    state,
    neovimResources,
    languagePacks,
    send,
    handle,
    session,
    text,
    shellChoice,
    captureHistory
  });

  handle('attach', (id, columns, rows) =>
    session(id).attach(integer(columns, 1000), integer(rows, 500))
  );
  handle(
    'openTerminal',
    async (id, shell) => (await session(id).openTerminal(shellChoice(shell))).workspace
  );
  handle('restartTerminal', (id, shell) => {
    const s = session(id);
    if (s.workspace.kind !== 'terminal') {
      throw new Error('Not a terminal session.');
    }
    return s.startTerminal(shellChoice(shell));
  });
  handle('resize', (id, columns, rows) =>
    session(id).resize(integer(columns, 1000), integer(rows, 500))
  );
  handle('input', (id, keys) => session(id).input(text(keys)));
  handle('inputMode', (id) => session(id).inputMode());
  handle('selectCompletion', (id, index) => {
    if (typeof index !== 'number') {
      throw new Error('Invalid completion index.');
    }
    return session(id).selectCompletion(integer(index + 1) - 1);
  });
  handle('markdownPreview', (id, token) =>
    session(id).markdownPreview(token === undefined ? '' : text(token))
  );
  handle('clipboardSharing', (id, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid clipboard setting.');
    }
    return session(id).setClipboardSharing(enabled);
  });
  handle('relativeLineNumbers', (id, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid line number setting.');
    }
    return session(id).setRelativeLineNumbers(enabled);
  });
  handle('editorConfig', (id, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid EditorConfig setting.');
    }
    return session(id).setEditorConfig(enabled);
  });
  handle('wordWrap', (id, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid word wrap setting.');
    }
    return session(id).setWordWrap(enabled);
  });
  handle('methodSeparators', (id, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Invalid method separator setting.');
    }
    return session(id).setMethodSeparators(enabled);
  });
  handle('openDocumentation', (value) => {
    const url = new URL(text(value));
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new Error('Unsupported documentation URL.');
    }
    return shell.openExternal(url.href);
  });
  handle('click', (id, row, column) => {
    if (typeof row !== 'number' || typeof column !== 'number') {
      throw new Error('Invalid mouse position.');
    }
    return session(id).click(integer(row + 1, 500) - 1, integer(column + 1, 1000) - 1);
  });
  handle('paste', (id, value) => session(id).paste(text(value)));
  handle('pasteClipboard', (id) => session(id).paste(() => clipboard.readText()));
  registerFileHandlers({
    handle,
    session,
    text,
    integer,
    sessions,
    send,
    trash: (file) => shell.trashItem(file)
  });
  handle('highlightSources', (id, path, before, after) =>
    session(id).highlightSources(text(path), text(before), text(after))
  );
  registerGitHandlers({ handle, session, text, sessions, send });
  handle('findSymbols', (id) => session(id).findSymbols());
  handle('openSymbol', (id, index, version) =>
    session(id).openSymbol(integer(index), integer(version))
  );
  handle('openReference', (id, index, version) =>
    session(id).openReference(integer(index), integer(version))
  );
  handle('openProblem', (id, index, version) =>
    session(id).openProblem(integer(index), integer(version))
  );
  handle('previewReference', (id, index, version) =>
    session(id).previewReference(integer(index), integer(version))
  );
  handle('selectBuffer', (id, buffer) => session(id).selectBuffer(integer(buffer)));
  handle('moveBuffer', (id, buffer, target) =>
    session(id).moveBuffer(integer(buffer), integer(target))
  );
  handle('reopenBuffer', (id) => session(id).reopenBuffer());

  handle('closeBuffer', async (id, value) => {
    const s = session(id);
    const buffer = integer(value);
    let force = false;
    if (await s.bufferModified(buffer)) {
      const t = (message: string): string => translate(state.language ?? 'en', message);
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: t('Discard this file\u2019s unsaved changes?'),
        buttons: [t('Cancel'), t('Discard')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (response !== 1) {
        return false;
      }
      force = true;
    }
    await s.closeBuffer(buffer, force);
    return true;
  });

  handle('save', (id, format) => session(id).save(format === true));
  handle('prefetchScroll', (id, down) => session(id).prefetchScroll(down === true));
  handle('jumpSticky', (id, window, buffer, line) =>
    session(id).jumpSticky(integer(window), integer(buffer), integer(line))
  );
  handle('scroll', (id, lines, follow, pixel, columns = 0) => {
    if (
      typeof lines !== 'number' ||
      !Number.isFinite(lines) ||
      (pixel !== true && !Number.isInteger(lines)) ||
      Math.abs(lines) > 1000 ||
      typeof columns !== 'number' ||
      !Number.isInteger(columns) ||
      Math.abs(columns) > 1000
    ) {
      throw new Error('Invalid scroll distance');
    }
    return session(id).scroll(lines, follow !== false, pixel === true, columns);
  });

  handle('debug', (id, action, target) => {
    if (
      typeof action !== 'string' ||
      ![
        'start',
        'breakpoint',
        'over',
        'into',
        'out',
        'pause',
        'stop',
        'launch',
        'variable'
      ].includes(action)
    ) {
      throw new Error('Invalid debug action');
    }
    return session(id).debug(
      action as DebugAction,
      action === 'launch' || action === 'variable' ? integer(target) : undefined
    );
  });

  handle('setLineEnding', (id, format) => {
    if (format !== 'LF' && format !== 'CRLF') {
      throw new Error('Invalid line ending');
    }
    return session(id).setLineEnding(format);
  });

  handle('theme', (value) => {
    if (!uiThemes.includes(value as UITheme)) {
      throw new Error('Invalid theme.');
    }
    // Native acrylic needs Windows 11 22H2; older systems keep an opaque backing.
    const nativeBackdrop = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
    const acrylic = value === 'acrylic' && nativeBackdrop;
    if (nativeBackdrop) {
      nativeTheme.themeSource = 'dark';
      window.setBackgroundMaterial(acrylic ? 'acrylic' : 'none');
    }
    window.setBackgroundColor(acrylic ? '#00000000' : value === 'neon' ? '#07080b' : '#141414');
  });

  handle('windowState', () => ({ maximized: window.isMaximized() }));
  handle('window', (action) => {
    switch (action) {
      case 'minimize': {
        window.minimize();
        break;
      }
      case 'maximize': {
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
        break;
      }
      case 'close': {
        window.close();
        break;
      }
      default: {
        throw new Error('Unknown window action.');
      }
    }
  });
  return prepareToQuit;
}
