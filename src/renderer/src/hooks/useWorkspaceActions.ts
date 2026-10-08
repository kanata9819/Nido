import { useState, type Dispatch, type SetStateAction } from 'react';
import type { FavoriteWorkspace, TerminalShell, Workspace } from '../../../shared/types';

interface Options {
    workspaces: Workspace[];
    active: string;
    restoring: boolean;
    terminalShell: TerminalShell;
    setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
    setActive: Dispatch<SetStateAction<string>>;
    focusEditor: () => void;
    requestEditorFocus: () => void;
    dismissLeader: () => void;
    showFolders: () => void;
    closeOverlay: () => void;
    report: (message: string) => void;
    run: (promise: Promise<unknown>) => void;
}

interface WorkspaceActions {
    creating: boolean;
    create: () => Promise<void>;
    activate: (id: string) => void;
    openWorkspace: (path: string, kind: 'editor' | 'terminal') => Promise<void>;
    openFavorite: (favorite: FavoriteWorkspace) => Promise<void>;
    nextWorkspace: (offset: number) => void;
    moveWorkspace: (offset: number) => void;
    closeWorkspace: (id: string) => void;
}

/** Own workspace creation, activation, ordering and close requests. */
export function useWorkspaceActions({
    workspaces,
    active,
    restoring,
    terminalShell,
    setWorkspaces,
    setActive,
    focusEditor,
    requestEditorFocus,
    dismissLeader,
    showFolders,
    closeOverlay,
    report,
    run
}: Options): WorkspaceActions {
    const [creating, setCreating] = useState(false);
    const activate = (id: string): void => {
        setActive(id);
        focusEditor();
    };
    const create = async (): Promise<void> => {
        if (creating) {
            return;
        }
        dismissLeader();
        showFolders();
    };
    const openWorkspace = async (path: string, kind: 'editor' | 'terminal'): Promise<void> => {
        if (creating || restoring) {
            return;
        }
        setCreating(true);
        dismissLeader();
        try {
            const added = await window.nido.createWorkspace(path, kind, terminalShell);
            if (added) {
                setWorkspaces((old) => [...old, added]);
                setActive(added.id);
                closeOverlay();
            }
        } catch (error) {
            report(String(error));
        } finally {
            setCreating(false);
            requestEditorFocus();
        }
    };
    const openFavorite = async (favorite: FavoriteWorkspace): Promise<void> => {
        const opened = workspaces.find(
            (w) => w.root === favorite.root && (w.kind || 'editor') === favorite.kind
        );
        if (opened) {
            activate(opened.id);
        } else {
            await openWorkspace(favorite.root, favorite.kind);
        }
    };
    const nextWorkspace = (offset: number): void => {
        if (!workspaces.length) {
            return;
        }
        activate(
            workspaces[
                (workspaces.findIndex((w) => w.id === active) + offset + workspaces.length) %
                    workspaces.length
            ].id
        );
    };
    const moveWorkspace = (offset: number): void => {
        setWorkspaces((old) => {
            const index = old.findIndex((w) => w.id === active);
            const target = index + offset;
            if (target < 0 || target >= old.length) {
                return old;
            }
            const next = [...old];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
        focusEditor();
    };
    const closeWorkspace = (id: string): void => {
        run(window.nido.closeWorkspace(id).then(requestEditorFocus));
    };

    return {
        creating,
        create,
        activate,
        openWorkspace,
        openFavorite,
        nextWorkspace,
        moveWorkspace,
        closeWorkspace
    };
}
