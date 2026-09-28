import { useEffect, useState } from 'react';
import type { BufferInfo } from '../../../shared/types';

import { gitFileKey, type Decoration } from '../fileDecorations';
export { gitFileKey, type Decoration } from '../fileDecorations';

export function useGitFileStatus(
    workspaceId: string,
    buffers: BufferInfo[],
    panel: string | null
): Record<string, Decoration> {
    const [decorations, setDecorations] = useState<Record<string, Decoration>>({});
    const files = JSON.stringify(buffers.map(({ name, modified }) => [name, modified]));

    useEffect(() => {
        setDecorations({});
    }, [workspaceId]);

    useEffect(() => {
        if (!workspaceId) {
            setDecorations({});
            return;
        }
        let cancelled = false;
        let pending = false;
        const refresh = async (): Promise<void> => {
            if (pending || document.hidden) {
                return;
            }
            pending = true;
            try {
                const status = await window.nido.gitStatus(workspaceId);
                const next: Record<string, Decoration> = {};
                // Worktree changes take precedence over the staged version of the same file.
                for (const change of [...status.changes].sort(
                    (a, b) => Number(b.staged) - Number(a.staged)
                )) {
                    const code = change.status === '?' ? 'U' : change.status;
                    const label =
                        change.status === '?'
                            ? 'Untracked'
                            : change.status === 'U'
                              ? 'Conflict'
                              : {
                                    M: 'Modified',
                                    A: 'Added',
                                    D: 'Deleted',
                                    R: 'Renamed',
                                    C: 'Copied',
                                    T: 'Type changed'
                                }[code] || code;
                    next[gitFileKey(`${status.root}/${change.path}`)] = {
                        code,
                        title: `Git: ${label}${change.staged ? ' (staged)' : ''}`
                    };
                }
                if (!cancelled) {
                    setDecorations(next);
                }
            } catch {
                // Git is optional: ordinary folders and unavailable repositories have no badges.
                if (!cancelled) {
                    setDecorations({});
                }
            } finally {
                pending = false;
            }
        };
        const initial = window.setTimeout(() => void refresh(), 200);
        // Poll only the active workspace so external Git commands are reflected too.
        const timer = window.setInterval(() => void refresh(), 3000);
        const focus = (): void => {
            void refresh();
        };
        window.addEventListener('focus', focus);
        const unsubscribe = window.nido.onEvent((event) => {
            if (event.type === 'filesChanged' && event.id === workspaceId) {
                void refresh();
            }
        });
        return () => {
            cancelled = true;
            window.clearTimeout(initial);
            window.clearInterval(timer);
            window.removeEventListener('focus', focus);
            unsubscribe();
        };
    }, [workspaceId, files, panel]);

    return decorations;
}
