import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { Session } from './session';
import {
    gitStatus,
    gitDiff,
    gitStage,
    gitCommit,
    gitHistory,
    gitCommitFiles,
    gitCommitDiff,
    gitBranches,
    gitSwitch
} from './git';
import { readLayout, writeLayout } from './persistence';
import type { DebugAction, NidoEvent, Workspace } from '../shared/types';

export interface AppState {
    order: string[];
    active: string;
    restoration: Promise<{ workspaces: Workspace[]; active: string; errors: string[] }> | undefined;
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
    send
}: HandlerDeps): void {
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

    // Only the application renderer may invoke the explicit API below.
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

    handle('create', async (path, kind = 'editor') => {
        if (kind !== 'editor' && kind !== 'terminal') {
            throw new Error('Invalid session type.');
        }
        if (!isAbsolute(text(path))) {
            throw new Error('Enter an absolute folder path.');
        }
        const s = await Session.create(text(path), send, neovimResources);
        try {
            if (kind === 'terminal') {
                await s.startTerminal();
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

    handle('attach', (id, columns, rows) =>
        session(id).attach(integer(columns, 1000), integer(rows, 500))
    );
    handle('openTerminal', async (id) => (await session(id).openTerminal()).workspace);
    handle('restartTerminal', (id) => {
        const s = session(id);
        if (s.workspace.kind !== 'terminal') {
            throw new Error('Not a terminal session.');
        }
        return s.startTerminal();
    });
    handle('resize', (id, columns, rows) =>
        session(id).resize(integer(columns, 1000), integer(rows, 500))
    );
    handle('input', (id, keys) => session(id).input(text(keys)));
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
        if (typeof enabled !== 'boolean') throw new Error('Invalid EditorConfig setting.');
        return session(id).setEditorConfig(enabled);
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
    handle('pasteClipboard', async (id) => session(id).paste(await clipboard.readText()));
    handle('files', (id, path) => session(id).files(text(path)));
    handle('gitStatus', (id) => gitStatus(session(id).workspace.root));
    handle('highlightSources', (id, path, before, after) =>
        session(id).highlightSources(text(path), text(before), text(after))
    );
    handle('gitHistory', (id, skip) => {
        if (typeof skip !== 'number') {
            throw new Error('Invalid history offset.');
        }
        return gitHistory(session(id).workspace.root, skip);
    });
    handle('gitCommitFiles', (id, hash) => gitCommitFiles(session(id).workspace.root, text(hash)));
    handle('gitCommitDiff', (id, hash, path) =>
        gitCommitDiff(session(id).workspace.root, text(hash), text(path))
    );
    handle('gitBranches', (id) => gitBranches(session(id).workspace.root));
    handle('gitSwitch', async (id, name, create) => {
        const current = session(id);
        if (typeof create !== 'boolean') {
            throw new Error('Invalid branch action.');
        }
        for (const open of sessions.values()) {
            if (await open.modified()) {
                throw new Error('Save unsaved editor changes before switching branches.');
            }
        }
        await gitSwitch(current.workspace.root, text(name), create);
        for (const open of sessions.values()) {
            await open.refreshFiles();
            send({ type: 'filesChanged', id: open.workspace.id });
        }
    });
    for (const [name, action] of [
        ['gitDiff', gitDiff],
        ['gitStage', gitStage]
    ] as const) {
        handle(name, (id, path, staged) => {
            if (typeof staged !== 'boolean') {
                throw new Error('Invalid Git selection.');
            }
            return action(session(id).workspace.root, text(path), staged);
        });
    }
    handle('gitCommit', (id, message) => gitCommit(session(id).workspace.root, text(message)));
    handle('findFiles', (id) => session(id).findFiles());
    handle('openFile', (id, path) => session(id).openFile(text(path)));
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

    handle('closeBuffer', async (id, value) => {
        const s = session(id);
        const buffer = integer(value);
        if (await s.bufferModified(buffer)) {
            const { response } = await dialog.showMessageBox(window, {
                type: 'warning',
                message: 'Discard this file\u2019s unsaved changes?',
                buttons: ['Cancel', 'Discard'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
            if (response !== 1) {
                return false;
            }
        }
        await s.closeBuffer(buffer, true);
        return true;
    });

    handle('save', (id, format) => session(id).save(format === true));
    handle('scroll', (id, lines, follow, pixel) => {
        if (
            typeof lines !== 'number' ||
            !Number.isFinite(lines) ||
            (pixel !== true && !Number.isInteger(lines)) ||
            Math.abs(lines) > 1000
        ) {
            throw new Error('Invalid scroll distance');
        }
        return session(id).scroll(lines, follow !== false, pixel === true);
    });

    handle('debug', (id, action, target) => {
        if (
            typeof action !== 'string' ||
            !['start', 'breakpoint', 'over', 'into', 'out', 'pause', 'stop', 'launch'].includes(
                action
            )
        ) {
            throw new Error('Invalid debug action');
        }
        return session(id).debug(
            action as DebugAction,
            action === 'launch' ? integer(target) : undefined
        );
    });

    handle('setLineEnding', (id, format) => {
        if (format !== 'LF' && format !== 'CRLF') {
            throw new Error('Invalid line ending');
        }
        return session(id).setLineEnding(format);
    });

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
}
