import { useCallback, useEffect, useRef, useState } from 'react';
import type { FavoriteWorkspace, Workspace } from '../../../shared/types';

interface FavoriteWorkspaces {
    favorites: FavoriteWorkspace[];
    ready: boolean;
    busy: boolean;
    toggleFavorite: (workspace: Workspace | FavoriteWorkspace) => void;
}

export function useFavoriteWorkspaces(report: (message: string) => void): FavoriteWorkspaces {
    const [favorites, setFavorites] = useState<FavoriteWorkspace[]>([]);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);

    useEffect(() => {
        let cancelled = false;
        void window.nido.favoriteWorkspaces().then(
            (saved) => {
                if (!cancelled) {
                    setFavorites(saved);
                    setReady(true);
                }
            },
            (error) => {
                if (!cancelled) {
                    report(String(error));
                }
            }
        );
        return () => {
            cancelled = true;
        };
    }, [report]);

    const toggleFavorite = useCallback(
        (workspace: Workspace | FavoriteWorkspace): void => {
            if (!ready || pending.current) {
                return;
            }
            pending.current = true;
            setBusy(true);
            const kind = workspace.kind || 'editor';
            const enabled = !favorites.some(
                (favorite) => favorite.root === workspace.root && favorite.kind === kind
            );
            void window.nido
                .setWorkspaceFavorite(workspace.root, kind, enabled)
                .then(setFavorites)
                .catch((error) => report(String(error)))
                .finally(() => {
                    pending.current = false;
                    setBusy(false);
                });
        },
        [favorites, ready, report]
    );

    return { favorites, ready, busy, toggleFavorite };
}
