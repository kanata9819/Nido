import { app, dialog } from 'electron';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { Session } from './session';
import { readFavorites, readLayout, writeFavorites, writeLayout } from './persistence';
import { WorkspaceCheckpoints } from './workspaceCheckpoints';
import type { TerminalShell } from '../shared/types';
import type { HandlerDeps } from './handlers';
import { createTranslator } from '../shared/i18n';

export function registerWorkspaceHandlers({
    window,
    sessions,
    state,
    neovimResources,
    send,
    handle,
    session,
    text,
    shellChoice,
    captureHistory
}: HandlerDeps & {
    handle: (name: string, action: (...args: unknown[]) => unknown) => void;
    session: (id: unknown) => Session;
    text: (value: unknown) => string;
    shellChoice: (value?: unknown) => TerminalShell;
    captureHistory: (session: Session) => Promise<void>;
}): () => Promise<boolean> {
    const favoritesPath = join(app.getPath('userData'), 'favorites.json');
    const layoutPath = join(app.getPath('userData'), 'workspaces.json');
    let checkpointReady = false;
    const orderedIds = (): string[] => [
        ...state.order.filter((id) => sessions.has(id)),
        ...[...sessions.keys()].filter((id) => !state.order.includes(id))
    ];
    const windowLayout = (): { width: number; height: number; maximized: boolean } => ({
        width: window.getNormalBounds().width,
        height: window.getNormalBounds().height,
        maximized: window.isMaximized()
    });
    const canCheckpoint = (): boolean =>
        checkpointReady && !state.prompting && !state.closing && !window.isDestroyed();
    const checkpoints = new WorkspaceCheckpoints(
        async () => {
            if (!canCheckpoint()) {
                return;
            }
            const ids = orderedIds();
            const active = state.active;
            const current = ids.map((id) => session(id));
            // Fast mode queries remain available while Vim waits for a prompt or a key.
            const modes = await Promise.all(
                current.map((s) => s.client.request('nvim_get_mode', []))
            );
            if (modes.some((mode: { blocking: boolean }) => mode.blocking)) {
                return;
            }
            const workspaces = await Promise.all(
                current.map((s) => s.snapshot({ restoreScroll: false }))
            );
            if (
                !canCheckpoint() ||
                active !== state.active ||
                JSON.stringify(ids) !== JSON.stringify(orderedIds())
            ) {
                return;
            }
            return {
                version: 1,
                window: windowLayout(),
                workspaces,
                active: Math.max(0, ids.indexOf(active))
            };
        },
        (layout) => writeLayout(layoutPath, layout),
        (error) =>
            send({
                type: 'notification',
                id: state.active,
                title: 'Workspace recovery',
                message: String(error),
                severity: 'error'
            })
    );
    const checkpointTimer = setInterval(() => void checkpoints.save(), 5000);
    checkpointTimer.unref();
    window.once('closed', () => {
        clearInterval(checkpointTimer);
        checkpoints.dispose();
    });
    let favoriteWrite: Promise<unknown> = Promise.resolve();
    handle('favorites', async () => {
        await favoriteWrite;
        return readFavorites(favoritesPath);
    });
    handle('favorite', (value, kind, enabled) => {
        const path = text(value);
        if (
            !isAbsolute(path) ||
            (kind !== 'editor' && kind !== 'terminal') ||
            typeof enabled !== 'boolean'
        ) {
            throw new Error('Invalid favorite workspace.');
        }
        // Serialize read/modify/write so simultaneous requests cannot overwrite each other.
        const update = favoriteWrite.then(async () => {
            const root = enabled ? await realpath(path) : path;
            if (enabled && !(await stat(root)).isDirectory()) {
                throw new Error('Choose a project folder.');
            }
            const favorites = (await readFavorites(favoritesPath)).filter(
                (w) => w.root !== root || w.kind !== kind
            );
            if (enabled) {
                favorites.push({ root, name: basename(root) || root, kind });
            }
            await writeFavorites(favoritesPath, favorites);
            return favorites;
        });
        favoriteWrite = update.catch(() => {});
        return update;
    });

    async function confirmClose(s: Session): Promise<boolean> {
        if (!(await s.modified())) {
            return true;
        }
        const t = createTranslator(state.language ?? 'en');
        const { response } = await dialog.showMessageBox(window, {
            type: 'warning',
            title: t('Unsaved changes'),
            message: t('Save changes in {name}?', { name: s.workspace.name }),
            detail: t(
                'Save all files before closing this workspace. Untitled buffers need a filename (:w path).'
            ),
            buttons: [t('Save all'), t('Cancel'), t('Discard changes')],
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

    // Ordinary close and update restart share the same save and session shutdown sequence.
    async function prepareToQuit(): Promise<boolean> {
        if (state.closing) {
            return true;
        }
        if (state.prompting) {
            return false;
        }
        state.prompting = true;
        try {
            if (state.restoration) {
                await state.restoration;
            }
            for (const s of sessions.values()) {
                if (!(await confirmClose(s))) {
                    return false;
                }
            }
            await Promise.all([...sessions.values()].map(captureHistory));
            // A background write must finish before the final shutdown snapshot replaces it.
            await checkpoints.idle();
            const ids = orderedIds();
            await writeLayout(layoutPath, {
                version: 1,
                window: windowLayout(),
                workspaces: await Promise.all(ids.map((id) => session(id).snapshot())),
                active: Math.max(0, ids.indexOf(state.active))
            });
            await Promise.all([...sessions.values()].map((s) => s.stop()));
            state.closing = true;
            return true;
        } finally {
            state.prompting = false;
        }
    }
    window.on('close', (event) => {
        if (state.closing) {
            return;
        }
        event.preventDefault();
        void prepareToQuit()
            .then((ready) => {
                if (ready) {
                    window.close();
                }
            })
            .catch((error: unknown) =>
                dialog.showMessageBox(window, { type: 'error', message: String(error) })
            );
    });

    handle('restore', (shell) => {
        const selectedShell = shellChoice(shell);
        state.restoration ??= (async () => {
            const errors: string[] = [];
            try {
                const saved = await readLayout(layoutPath);
                // Independent sessions can start together; insert results in saved tab order.
                const restored = await Promise.all(
                    saved.workspaces.map(async (workspace, index) => {
                        let s: Session | undefined;
                        try {
                            s = await Session.create(workspace.root, send, neovimResources);
                            errors.push(...(await s.restore(workspace, selectedShell)));
                            if (index === saved.active) {
                                state.active = s.workspace.id;
                            }
                            return s;
                        } catch (error) {
                            await s?.stop();
                            errors.push(`${workspace.root}: ${String(error)}`);
                            return undefined;
                        }
                    })
                );
                for (const s of restored) {
                    if (s) {
                        sessions.set(s.workspace.id, s);
                    }
                }
                checkpointReady = true;
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
            if (state.prompting || state.closing || window.isDestroyed()) {
                throw new Error('The window is closing.');
            }
        } catch (error) {
            await s.stop();
            throw error;
        }
        sessions.set(s.workspace.id, s);
        checkpointReady = true;
        return s.workspace;
    });

    handle('close', async (id) => {
        const s = session(id);
        if (!(await confirmClose(s))) {
            return false;
        }
        await captureHistory(s);
        await s.stop();
        sessions.delete(s.workspace.id);
        send({ type: 'exit', id: s.workspace.id });
        return true;
    });
    return prepareToQuit;
}
