import { Leaf, Minus, Plus, Square, Star, X } from 'lucide-react';
import type { FavoriteWorkspace, Workspace } from '../../../shared/types';
import styles from '../assets/Nido.module.css';
import UpdateButton from './UpdateButton';

interface TitleBarProps {
    workspaces: Workspace[];
    favorites: FavoriteWorkspace[];
    favoriteBusy: boolean;
    toggleFavorite: (workspace: Workspace) => void;
    active: string;
    creating: boolean;
    activate: (id: string) => void;
    closeWorkspace: (id: string) => void;
    create: () => Promise<void>;
    run: (promise: Promise<unknown>) => void;
}

export default function TitleBar({
    workspaces,
    favorites,
    favoriteBusy,
    toggleFavorite,
    active,
    creating,
    activate,
    closeWorkspace,
    create,
    run
}: TitleBarProps): React.JSX.Element {
    return (
        <header className={styles.titlebar}>
            <div className={styles.brand}>
                <Leaf size={22} />
                <span>Nido</span>
            </div>
            <div className={styles.workspaces} role="tablist" aria-label="Workspaces">
                {workspaces.map((w, i) => (
                    <div
                        key={w.id}
                        className={`${styles.workspaceTab} ${active === w.id ? styles.activeWorkspace : ''}`}
                    >
                        <button
                            role="tab"
                            aria-selected={active === w.id}
                            aria-label={`Workspace ${w.name}`}
                            onClick={() => activate(w.id)}
                        >
                            <span
                                className={styles.workspaceDot}
                                style={{
                                    background: ['#a3cc94', '#b5a0dd', '#d5b77f', '#83bcd0'][i % 4]
                                }}
                            />
                            <span>{w.name}</span>
                            <kbd>Alt+{i + 1}</kbd>
                        </button>
                        <button
                            className={`${styles.tabClose} ${styles.favoriteToggle}`}
                            aria-label={`Favorite workspace ${w.name}`}
                            aria-pressed={favorites.some(
                                (f) => f.root === w.root && f.kind === (w.kind || 'editor')
                            )}
                            title="Toggle favorite"
                            disabled={favoriteBusy}
                            onClick={() => toggleFavorite(w)}
                        >
                            <Star size={13} />
                        </button>
                        <button
                            className={styles.tabClose}
                            aria-label={`Close workspace ${w.name}`}
                            onClick={() => closeWorkspace(w.id)}
                        >
                            <X size={12} />
                        </button>
                    </div>
                ))}
                <button
                    className={styles.addWorkspace}
                    title="Open workspace (Ctrl+Shift+N)"
                    aria-label="Open workspace"
                    disabled={creating}
                    onClick={() => void create()}
                >
                    <Plus size={19} />
                </button>
            </div>
            <div className={styles.dragArea} />
            <UpdateButton />
            <div className={styles.windowControls}>
                <button
                    aria-label="Minimize"
                    onClick={() => run(window.nido.windowAction('minimize'))}
                >
                    <Minus size={15} />
                </button>
                <button
                    aria-label="Maximize or restore"
                    onClick={() => run(window.nido.windowAction('maximize'))}
                >
                    <Square size={12} />
                </button>
                <button
                    aria-label="Close Nido"
                    onClick={() => run(window.nido.windowAction('close'))}
                >
                    <X size={17} />
                </button>
            </div>
        </header>
    );
}
