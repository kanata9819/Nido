import { app, dialog } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { Session } from './session';
import { readLayout, writeLayout } from './persistence';
import type { TerminalShell } from '../shared/types';
import type { HandlerDeps } from './handlers';

export function registerWorkspaceHandlers({
    window,
    sessions,
    state,
    neovimResources,
    send,
    handle,
    session,
    text,
    shellChoice
}: HandlerDeps & {
    handle: (name: string, action: (...args: unknown[]) => unknown) => void;
    session: (id: unknown) => Session;
    text: (value: unknown) => string;
    shellChoice: (value?: unknown) => TerminalShell;
}): void {
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
            noLink: true
        });
        if (response === 1) {
            return false;
        }
        if (response === 0) {
            await s.saveAll();
        }
        return true;
    }

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
                    ...[...sessions.keys()].filter((id) => !state.order.includes(id))
                ];
                await writeLayout(join(app.getPath('userData'), 'workspaces.json'), {
                    version: 1,
                    window: {
                        width: window.getNormalBounds().width,
                        height: window.getNormalBounds().height,
                        maximized: window.isMaximized()
                    },
                    workspaces: await Promise.all(ids.map((id) => session(id).snapshot())),
                    active: Math.max(0, ids.indexOf(state.active))
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

    handle('restore', (shell) => {
        const selectedShell = shellChoice(shell);
        state.restoration ??= (async () => {
            const errors: string[] = [];
            try {
                const saved = await readLayout(join(app.getPath('userData'), 'workspaces.json'));
                for (const [index, workspace] of saved.workspaces.entries()) {
                    try {
                        const s = await Session.create(workspace.root, send, neovimResources);
                        sessions.set(s.workspace.id, s);
                        errors.push(...(await s.restore(workspace, selectedShell)));
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
            return {
                workspaces: [...sessions.values()].map((s) => s.workspace),
                active: state.active,
                errors
            };
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

    handle('browseFolders', async (value) => {
        const requested = value === undefined || value === '' ? app.getPath('home') : text(value);
        if (!isAbsolute(requested)) {
            throw new Error('Enter an absolute folder path.');
        }
        const path = await realpath(requested);
        const entries = await readdir(path, { withFileTypes: true });
        return {
            path,
            parent: dirname(path),
            folders: entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => ({
                    name: entry.name,
                    path: join(path, entry.name),
                    directory: true
                }))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        };
    });

    handle('create', async (path, kind = 'editor', shell) => {
        const selectedShell = shellChoice(shell);
        if (kind !== 'editor' && kind !== 'terminal') {
            throw new Error('Invalid session type.');
        }
        if (!isAbsolute(text(path))) {
            throw new Error('Enter an absolute folder path.');
        }
        const s = await Session.create(text(path), send, neovimResources);
        try {
            if (kind === 'terminal') {
                await s.startTerminal(selectedShell);
            }
        } catch (error) {
            await s.stop();
            throw error;
        }
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
}
