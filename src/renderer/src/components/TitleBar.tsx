import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    Copy,
    Keyboard,
    Leaf,
    Minus,
    Plus,
    Settings2,
    Square,
    SquareTerminal,
    Star,
    X
} from 'lucide-react';
import type { FavoriteWorkspace, Workspace } from '../../../shared/types';
import styles from '../assets/Nido.module.css';
import UpdateButton from './UpdateButton';

interface TitleBarProps {
    compact: boolean;
    workspaces: Workspace[];
    favorites: FavoriteWorkspace[];
    favoriteBusy: boolean;
    toggleFavorite: (workspace: Workspace) => void;
    active: string;
    creating: boolean;
    activate: (id: string) => void;
    closeWorkspace: (id: string) => void;
    create: () => Promise<void>;
    createTerminal: () => Promise<void>;
    showPanel: (panel: 'commands' | 'settings') => void;
    run: (promise: Promise<unknown>) => void;
}

export default function TitleBar({
    compact,
    workspaces,
    favorites,
    favoriteBusy,
    toggleFavorite,
    active,
    creating,
    activate,
    closeWorkspace,
    create,
    createTerminal,
    showPanel,
    run
}: TitleBarProps): React.JSX.Element {
    const t = useI18n();
    const header = useRef<HTMLElement>(null);
    const selectedTab = useRef<HTMLDivElement>(null);
    const [maximized, setMaximized] = useState(false);
    useLayoutEffect(() => {
        selectedTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [active, compact]);
    useEffect(() => {
        if (!compact) {
            return;
        }
        const focusTabs = (event: KeyboardEvent): void => {
            if (
                !event.isComposing &&
                !event.ctrlKey &&
                !event.metaKey &&
                event.altKey &&
                event.shiftKey &&
                event.key.toLowerCase() === 'w' &&
                !document.querySelector('[role="dialog"]')
            ) {
                event.preventDefault();
                event.stopPropagation();
                header.current
                    ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
                    ?.focus();
            }
        };
        document.addEventListener('keydown', focusTabs, true);
        return () => document.removeEventListener('keydown', focusTabs, true);
    }, [compact]);
    useEffect(() => {
        let active = true;
        let received = false;
        const unsubscribe = window.nido.onEvent((event) => {
            if (event.type === 'windowState') {
                received = true;
                setMaximized(event.state.maximized);
            }
        });
        run(
            window.nido.windowState().then((state) => {
                if (active && !received) {
                    setMaximized(state.maximized);
                }
            })
        );
        return () => {
            active = false;
            unsubscribe();
        };
    }, [run]);
    return (
        <header ref={header} className={styles.titlebar}>
            <div className={styles.brand}>
                <Leaf size={22} />
                <span>Nido</span>
            </div>
            <div className={styles.workspaces} role="tablist" aria-label={t('Workspaces')}>
                {workspaces.map((w, i) => (
                    <div
                        key={w.id}
                        ref={active === w.id ? selectedTab : undefined}
                        className={`${styles.workspaceTab} ${active === w.id ? styles.activeWorkspace : ''}`}
                    >
                        <button
                            role="tab"
                            aria-selected={active === w.id}
                            aria-label={t('Workspace {name}', { name: w.name })}
                            title={compact ? t('Session tabs (Alt+Shift+W)') : undefined}
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
                            aria-label={t('Favorite workspace {name}', { name: w.name })}
                            aria-pressed={favorites.some(
                                (f) => f.root === w.root && f.kind === (w.kind || 'editor')
                            )}
                            title={t('Toggle favorite')}
                            disabled={favoriteBusy}
                            onClick={() => toggleFavorite(w)}
                        >
                            <Star size={13} />
                        </button>
                        <button
                            className={styles.tabClose}
                            aria-label={t('Close workspace {name}', { name: w.name })}
                            onClick={() => closeWorkspace(w.id)}
                        >
                            <X size={12} />
                        </button>
                    </div>
                ))}
                <button
                    className={styles.addWorkspace}
                    title={t('Open workspace (Ctrl+Shift+N)')}
                    aria-label={t('Open workspace')}
                    disabled={creating}
                    onClick={() => void create()}
                >
                    <Plus size={19} />
                </button>
                <button
                    className={styles.addWorkspace}
                    title={t('New terminal session')}
                    aria-label={t('New terminal session')}
                    disabled={creating}
                    onClick={() => void createTerminal()}
                >
                    <SquareTerminal size={19} />
                </button>
            </div>
            <div className={styles.dragArea} />
            <UpdateButton />
            <div className={styles.titlebarActions}>
                <button
                    aria-label={t('Command palette')}
                    title={t('Commands (Ctrl+Shift+P)')}
                    onClick={() => showPanel('commands')}
                >
                    <Keyboard size={19} />
                </button>
                <button
                    aria-label={t('Settings')}
                    title={t('Settings (Space ,)')}
                    onClick={() => showPanel('settings')}
                >
                    <Settings2 size={19} />
                </button>
            </div>
            <div className={styles.windowControls}>
                <button
                    aria-label={t('Minimize')}
                    title={t('Minimize (Space -)')}
                    onClick={() => run(window.nido.windowAction('minimize'))}
                >
                    <Minus size={15} />
                </button>
                <button
                    aria-label={t(maximized ? 'Restore window' : 'Maximize')}
                    title={t(maximized ? 'Restore window (Space +)' : 'Maximize (Space +)')}
                    onClick={() => run(window.nido.windowAction('maximize'))}
                >
                    {maximized ? <Copy size={12} /> : <Square size={12} />}
                </button>
                <button
                    aria-label={t('Close Nido')}
                    title={t('Close Nido (Space q)')}
                    onClick={() => run(window.nido.windowAction('close'))}
                >
                    <X size={17} />
                </button>
            </div>
        </header>
    );
}
