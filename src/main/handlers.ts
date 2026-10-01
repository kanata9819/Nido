import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { isAbsolute, relative, sep } from 'node:path';
import { Session } from './session';
import { registerGitHandlers } from './gitHandlers';
import { registerWorkspaceHandlers } from './workspaceHandlers';
import { terminalShells, type TerminalShell } from '../shared/types';
import type { DebugAction, FileAction, NidoEvent, Workspace } from '../shared/types';

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

    function shellChoice(value: unknown = 'auto'): TerminalShell {
        if (!terminalShells.includes(value as TerminalShell))
            throw new Error('Invalid terminal shell.');
        return value as TerminalShell;
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

    registerWorkspaceHandlers({
        window,
        sessions,
        state,
        neovimResources,
        send,
        handle,
        session,
        text,
        shellChoice
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
    handle('markdownPreview', (id) => session(id).markdownPreview());
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
    handle('highlightSources', (id, path, before, after) =>
        session(id).highlightSources(text(path), text(before), text(after))
    );
    registerGitHandlers({ handle, session, text, sessions, send });
    handle('findFiles', (id) => session(id).findFiles());
    handle('openFile', (id, path) => session(id).openFile(text(path)));
    handle('fileAction', async (id, action, path, target) => {
        if (
            typeof action !== 'string' ||
            !['createFile', 'createDirectory', 'rename', 'copy', 'delete'].includes(action)
        ) {
            throw new Error('Invalid file action.');
        }
        const current = session(id);
        if (action === 'rename' || action === 'delete' || action === 'copy') {
            const source = await current.path(text(path));
            for (const open of sessions.values()) {
                if (open === current) continue;
                if (
                    open.state.buffers.some((buffer) => {
                        if (!buffer.name) return false;
                        const child = relative(source, buffer.name);
                        return (
                            child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
                        );
                    })
                )
                    throw new Error(
                        'Close this file or folder in the other workspace session first.'
                    );
            }
        }
        await current.fileAction(
            action as FileAction,
            text(path),
            target === undefined ? '' : text(target),
            (file) => shell.trashItem(file)
        );
        for (const open of sessions.values()) {
            if (open.workspace.root === current.workspace.root)
                send({ type: 'filesChanged', id: open.workspace.id });
        }
    });
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
