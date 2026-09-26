import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { Session } from './session';
import { readLayout, writeLayout } from './persistence';
import type { DebugAction, NidoEvent, Workspace } from '../shared/types';

export interface AppState {
  order: string[];
  active: string;
  restoration:
    | Promise<{ workspaces: Workspace[]; active: string; errors: string[] }>
    | undefined;
  prompting: boolean;
  closing: boolean;
}

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
}: HandlerDeps): void {
  function session(id: unknown): Session {
    if (typeof id !== 'string' || !sessions.has(id)) {
      throw new Error('Workspace is no longer running.');
    }
    return sessions.get(id)!;
  }

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

  async function confirmClose(s: Session): Promise<boolean> {
    if (!(await s.modified())) {
      return true;
    }
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: `Save changes in ${s.workspace.name}?`,
      detail: 'Save all files before closing this workspace. Untitled buffers need a filename (:w path).',
      buttons: ['Save all', 'Cancel', 'Discard changes'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 1) {
      return false;
    }
    if (response === 0) {
      await s.saveAll();
    }
    return true;
  }

  // Only the application renderer may invoke the explicit API below.
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`nido:${name}`, (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Untrusted sender.');
      }
      return fn(...args);
    });
  };

  // Window close logic.
  window.on('close', (event) => {
    if (state.closing) {
      return;
    }
    event.preventDefault();
    if (state.prompting) {
      return;
    }
    state.prompting = true;
    void (async () => {
      try {
        if (state.restoration) {
          await state.restoration;
        }
        for (const s of sessions.values()) {
          if (!(await confirmClose(s))) {
            return;
          }
        }
        const ids = [
          ...state.order.filter((id) => sessions.has(id)),
          ...[...sessions.keys()].filter((id) => !state.order.includes(id)),
        ];
        await writeLayout(join(app.getPath('userData'), 'workspaces.json'), {
          version: 1,
          workspaces: await Promise.all(ids.map((id) => session(id).snapshot())),
          active: Math.max(0, ids.indexOf(state.active)),
        });
        state.closing = true;
        await Promise.all([...sessions.values()].map((s) => s.stop()));
        window.close();
      } catch (error) {
        await dialog.showMessageBox(window, { type: 'error', message: String(error) });
      } finally {
        state.prompting = false;
      }
    })();
  });

  handle('restore', () => {
    state.restoration ??= (async () => {
      const errors: string[] = [];
      try {
        const saved = await readLayout(join(app.getPath('userData'), 'workspaces.json'));
        for (const [index, workspace] of saved.workspaces.entries()) {
          try {
            const s = await Session.create(workspace.root, send, neovimResources);
            sessions.set(s.workspace.id, s);
            errors.push(...(await s.restore(workspace)));
            if (index === saved.active) {
              state.active = s.workspace.id;
            }
          } catch (error) {
            errors.push(`${workspace.root}: ${String(error)}`);
          }
        }
      } catch (error) {
        errors.push(`Workspace restore failed: ${String(error)}`);
      }
      state.order = [...sessions.keys()];
      state.active ||= state.order[0] || '';
      return { workspaces: [...sessions.values()].map((s) => s.workspace), active: state.active, errors };
    })();
    return state.restoration;
  });

  handle('layout', (ids, selected) => {
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === 'string' && sessions.has(id)) ||
      new Set(ids).size !== ids.length ||
      typeof selected !== 'string' ||
      (selected !== '' && !ids.includes(selected))
    ) {
      throw new Error('Invalid workspace layout.');
    }
    state.order = ids;
    state.active = selected;
  });

  handle('create', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open a workspace in Nido',
      properties: ['openDirectory'],
    });
    if (result.canceled) {
      return null;
    }
    const s = await Session.create(result.filePaths[0], send, neovimResources);
    sessions.set(s.workspace.id, s);
    return s.workspace;
  });

  handle('close', async (id) => {
    const s = session(id);
    if (!(await confirmClose(s))) {
      return false;
    }
    await s.stop();
    sessions.delete(s.workspace.id);
    send({ type: 'exit', id: s.workspace.id });
    return true;
  });

  handle('attach', (id, columns, rows) => session(id).attach(integer(columns, 1000), integer(rows, 500)));
  handle('resize', (id, columns, rows) => session(id).resize(integer(columns, 1000), integer(rows, 500)));
  handle('input', (id, keys) => session(id).input(text(keys)));
  handle('paste', (id, value) => session(id).paste(text(value)));
  handle('pasteClipboard', async (id) => session(id).paste(await clipboard.readText()));
  handle('files', (id, path) => session(id).files(text(path)));
  handle('findFiles', (id) => session(id).findFiles());
  handle('openFile', (id, path) => session(id).openFile(text(path)));
  handle('selectBuffer', (id, buffer) => session(id).selectBuffer(integer(buffer)));

  handle('closeBuffer', async (id, value) => {
    const s = session(id),
      buffer = integer(value);
    if (await s.bufferModified(buffer)) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Discard this file\u2019s unsaved changes?',
        buttons: ['Cancel', 'Discard'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) {
        return false;
      }
    }
    await s.closeBuffer(buffer, true);
    return true;
  });

  handle('save', (id) => session(id).save());
  handle('scroll', (id, lines) => {
    if (typeof lines !== 'number' || !Number.isInteger(lines) || Math.abs(lines) > 1000) throw new Error('Invalid scroll distance');
    return session(id).scroll(lines);
  });
  handle('debug', (id, action, target) => {
    if (typeof action !== 'string' || !['start', 'breakpoint', 'over', 'into', 'out', 'pause', 'stop', 'launch'].includes(action)) {
      throw new Error('Invalid debug action');
    }
    return session(id).debug(action as DebugAction, action === 'launch' ? integer(target) : undefined);
  });
  handle('setLineEnding', (id, format) => {
    if (format !== 'LF' && format !== 'CRLF') throw new Error('Invalid line ending');
    return session(id).setLineEnding(format);
  });

  handle('window', (action) => {
    if (action === 'minimize') {
      window.minimize();
    } else if (action === 'maximize') {
      window.isMaximized() ? window.unmaximize() : window.maximize();
    } else if (action === 'close') {
      window.close();
    } else {
      throw new Error('Unknown window action.');
    }
  });
}
