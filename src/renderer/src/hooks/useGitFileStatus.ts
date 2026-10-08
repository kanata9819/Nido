import { useEffect, useMemo, useState } from 'react';
import type { BufferInfo } from '../../../shared/types';

import { gitFileKey, type Decoration } from '../fileDecorations';
export { gitFileKey, type Decoration } from '../fileDecorations';

const emptyDecorations: Record<string, Decoration> = {};

export function useGitFileStatus(
    workspaceId: string,
    buffers: BufferInfo[],
    panel: string | null
): Record<string, Decoration> {
    const [result, setResult] = useState<{
        workspaceId: string;
        decorations: Record<string, Decoration>;
    }>();
    const files = useMemo(
        () => JSON.stringify(buffers.map(({ name, modified }) => [name, modified])),
        [buffers]
    );

    useEffect(() => {
        if (!workspaceId) {
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
                    setResult((previous) => {
                        const paths = Object.keys(next);
                        if (
                            previous?.workspaceId === workspaceId &&
                            Object.keys(previous.decorations).length === paths.length &&
                            paths.every(
                                (path) =>
                                    previous.decorations[path]?.code === next[path].code &&
                                    previous.decorations[path]?.title === next[path].title
                            )
                        ) {
                            return previous;
                        }
                        return { workspaceId, decorations: next };
                    });
                }
            } catch {
                // Git is optional: ordinary folders and unavailable repositories have no badges.
                if (!cancelled) {
                    setResult((previous) =>
                        previous?.workspaceId === workspaceId &&
                        !Object.keys(previous.decorations).length
                            ? previous
                            : { workspaceId, decorations: emptyDecorations }
                    );
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

    return result?.workspaceId === workspaceId ? result.decorations : emptyDecorations;
}
