import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FavoriteWorkspace, FileEntry, SessionState, Workspace } from '../../shared/types';
import type { Panel } from './types';
import Editor from './Editor';
import TerminalPanel from './components/TerminalPanel';
import Notification from './components/Notification';
import NavigationRail from './components/NavigationRail';
import { useSessionSettings } from './hooks/useSessionSettings';
import Sidebar from './Sidebar';
import DebugPanel from './components/DebugPanel';
import FileHeader from './components/FileHeader';
import KeyboardGuide from './components/KeyboardGuide';
import { Panel as PanelComponent } from './components/Panel';
import ReferencesPanel from './components/ReferencesPanel';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';
import { Welcome, WorkspaceWelcome } from './components/Welcome';
import { buildItems } from './commands';
import { fileDecorations } from './fileDecorations';
import { defaultFontFamily, useEditorSettings } from './hooks/useEditorSettings';
import { useGitFileStatus } from './hooks/useGitFileStatus';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePointerVisibility } from './hooks/usePointerVisibility';
import { useWorkspaceSessions } from './hooks/useWorkspaceSessions';
import styles from './assets/Nido.module.css';
import notificationStyles from './assets/Notification.module.css';
import { useNotificationDismissal } from './hooks/useNotificationDismissal';

const defaultState: SessionState = {
    buffers: [],
    current: 0,
    mode: 'n',
    line: 1,
    column: 1,
    filetype: ''
};

export default function App(): React.JSX.Element {
    const pointerHidden = usePointerVisibility();
    const [panel, setPanel] = useState<Panel>(null);
    const [leader, setLeader] = useState(false);
    const [query, setQuery] = useState('');
    const [selection, setSelection] = useState(0);
    const [fileList, setFileList] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [favorites, setFavorites] = useState<FavoriteWorkspace[]>([]);
    const [favoritesReady, setFavoritesReady] = useState(false);
    const [savingFavorite, setSavingFavorite] = useState(false);
    const favoritePending = useRef(false);
    const [errorNotice, setErrorNotice] = useState<{ message: string }>();
    const error = errorNotice?.message || '';
    const setError = useCallback(
        (message: string): void => setErrorNotice(message ? { message } : undefined),
        []
    );
    const dismissError = useCallback(() => setError(''), [setError]);
    const report = useCallback(
        (message: string): void =>
            setError(message.replace(/^Error: Error invoking remote method '[^']+': Error: /, '')),
        [setError]
    );

    const { workspaces, setWorkspaces, active, setActive, states, mode, restoring } =
        useWorkspaceSessions(report);
    useEffect(() => {
        void window.nido
            .favoriteWorkspaces()
            .then((saved) => {
                setFavorites(saved);
                setFavoritesReady(true);
            })
            .catch((e) => report(String(e)));
    }, [report]);

    const toggleFavorite = (w: Workspace | FavoriteWorkspace): void => {
        if (!favoritesReady || favoritePending.current) {
            return;
        }
        favoritePending.current = true;
        setSavingFavorite(true);
        const kind = w.kind || 'editor';
        const enabled = !favorites.some((f) => f.root === w.root && f.kind === kind);
        void window.nido
            .setWorkspaceFavorite(w.root, kind, enabled)
            .then(setFavorites)
            .catch((e) => report(String(e)))
            .finally(() => {
                favoritePending.current = false;
                setSavingFavorite(false);
            });
    };
    const [debugVisible, setDebugVisible] = useState(false);
    const [debugFocusTick, setDebugFocusTick] = useState(0);
    const [referencesVisible, setReferencesVisible] = useState(false);
    const [referencesFocusTick, setReferencesFocusTick] = useState(0);
    const [bottomPanel, setBottomPanel] = useState<'debug' | 'references' | 'terminal'>('debug');
    const [terminalVisible, setTerminalVisible] = useState(false);
    const [terminalFocusTick, setTerminalFocusTick] = useState(0);
    const [focusTick, setFocusTick] = useState(0);
    const settings = useEditorSettings();
    const {
        theme,
        sidebar,
        setSidebar,
        animations,
        smoothCursor,
        smoothBlink,
        scrollFollowCursor,
        formatOnSave,
        fontFamily,
        fontSize,
        lineHeight,
        sidebarWidth,
        resizeSidebar
    } = settings;
    useLayoutEffect(() => {
        document.documentElement.dataset.theme = theme;
        void window.nido.setTheme(theme).catch((error) => report(String(error)));
    }, [theme, report]);
    const errorFading = useNotificationDismissal(errorNotice, animations, dismissError);
    useSessionSettings(workspaces, settings, report);

    const modal = useRef<HTMLDivElement>(null);
    const state = states[active] || defaultState;
    const gitFiles = useGitFileStatus(active, state.buffers, panel);
    const hasDebugger = !!state.debug;
    useEffect(() => {
        if (state.references) {
            setBottomPanel('references');
            setReferencesVisible(true);
            setReferencesFocusTick((value) => value + 1);
        }
    }, [active, state.references?.version, state.references?.loading]);

    useEffect(() => {
        if (hasDebugger) {
            setDebugVisible(true);
        }
    }, [hasDebugger, active]);

    useEffect(() => {
        if (state.debug?.status === 'building' || state.debug?.status === 'running') {
            setBottomPanel('debug');
            setDebugVisible(true);
        }
    }, [active, state.debug?.status]);

    const workspace = workspaces.find((w) => w.id === active);
    const decorations = useMemo(
        () => fileDecorations(workspace?.root || '', gitFiles, state.diagnostics, state.problems),
        [workspace?.root, gitFiles, state.diagnostics, state.problems]
    );
    const focusEditor = (): void => {
        setPanel(null);
        setLeader(false);
        setFocusTick((n) => n + 1);
    };

    const closeReferences = (): void => {
        setReferencesVisible(false);
        focusEditor();
    };

    const run = (promise: Promise<unknown>): void => {
        void promise.catch((e) => report(String(e)));
    };

    const showTerminal = (): void => {
        if (!active) {
            return;
        }
        if (workspace?.kind === 'terminal') {
            focusEditor();
            return;
        }
        setLeader(false);
        if (workspace?.terminalId) {
            setBottomPanel('terminal');
            setTerminalVisible(true);
            setTerminalFocusTick((value) => value + 1);
            return;
        }
        const owner = active;
        run(
            window.nido.openTerminal(owner, settings.terminalShell).then((terminal) => {
                setWorkspaces((old) =>
                    old.map((w) => (w.id === owner ? { ...w, terminalId: terminal.id } : w))
                );
                setBottomPanel('terminal');
                setTerminalVisible(true);
                setTerminalFocusTick((value) => value + 1);
            })
        );
    };

    const toggleTerminal = (): void => {
        if (terminalVisible && bottomPanel === 'terminal' && workspace?.kind !== 'terminal') {
            setTerminalVisible(false);
            focusEditor();
        } else {
            showTerminal();
        }
    };

    const restartShell = (id: string): void => {
        run(
            window.nido.restartTerminal(id, settings.terminalShell).then(() => {
                if (id === active) {
                    focusEditor();
                } else {
                    setTerminalFocusTick((value) => value + 1);
                }
            })
        );
    };

    const activate = (id: string): void => {
        setActive(id);
        focusEditor();
    };

    useEffect(() => {
        if (panel !== 'files' || !active) {
            return;
        }
        let cancelled = false;
        window.nido
            .findFiles(active)
            .then((files) => {
                if (!cancelled) {
                    setFileList(files);
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    report(String(e));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [panel, active, report]);

    const create = async (): Promise<void> => {
        if (creating) {
            return;
        }
        setLeader(false);
        setPanel('folders');
    };

    const openWorkspace = async (path: string, kind: 'editor' | 'terminal'): Promise<void> => {
        if (creating || restoring) {
            return;
        }
        setCreating(true);
        setLeader(false);

        try {
            const added = await window.nido.createWorkspace(path, kind, settings.terminalShell);
            if (added) {
                setWorkspaces((old) => [...old, added]);
                setActive(added.id);
                setPanel(null);
            }
        } catch (e) {
            report(String(e));
        } finally {
            setCreating(false);
            setFocusTick((n) => n + 1);
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

    const openFile = (path: string): void => {
        run(window.nido.openFile(active, path).then(focusEditor));
    };

    const closeWorkspace = (id: string): void => {
        run(
            window.nido.closeWorkspace(id).then(() => {
                setFocusTick((n) => n + 1);
            })
        );
    };

    const showPanel = (value: Panel): void => {
        setLeader(false);
        setQuery('');
        setSelection(0);
        setPanel(value);

        if (value === 'files') {
            setLoading(true);
            setFileList([]);
        }
    };

    const showExplorer = (): void => {
        if (workspace?.kind === 'terminal') {
            focusEditor();
            return;
        }
        setLeader(false);
        setPanel(null);
        setSidebar(true);
        requestAnimationFrame(() =>
            document.querySelector<HTMLElement>('aside:not([hidden]) [role="tree"]')?.focus()
        );
    };

    const save = (): void => run(window.nido.save(active, formatOnSave));
    const openDebugger = (): void => {
        setLeader(false);
        setPanel(null);
        setBottomPanel('debug');
        setDebugVisible(true);
        setDebugFocusTick((value) => value + 1);
    };
    const { commands, filtered } = buildItems(active, panel, workspaces, fileList, state, query, {
        save,
        showPanel,
        moveWorkspace,
        run,
        focusEditor,
        closeWorkspace,
        create,
        showExplorer,
        openDebugger,
        openFile,
        activate,
        toggleFavorite: () => {
            if (workspace) {
                toggleFavorite(workspace);
            }
        },
        isFavorite: favorites.some(
            (f) => f.root === workspace?.root && f.kind === (workspace?.kind || 'editor')
        )
    });

    const keydown = useKeyboardShortcuts({
        save,
        restartShell: () => {
            const id = workspace?.kind === 'terminal' ? active : workspace?.terminalId;
            if (id) {
                restartShell(id);
            }
        },
        toggleTerminal,
        closeReferences,
        showDebugger: () => {
            setLeader(false);
            if (
                bottomPanel === 'terminal' ||
                workspace?.kind === 'terminal' ||
                (workspace?.terminalId && !state.debug && !state.references)
            ) {
                showTerminal();
            } else if (bottomPanel === 'references' && state.references) {
                setReferencesVisible(true);
                setReferencesFocusTick((value) => value + 1);
            } else {
                openDebugger();
            }
        },
        panel,
        leader,
        error,
        setError,
        setFocusTick,
        focusEditor,
        modal,
        mode,
        active,
        workspaces,
        nextWorkspace,
        showExplorer,
        create,
        showPanel,
        commands,
        state: { buffers: state.buffers, current: state.current, filetype: state.filetype },
        run,
        setLeader,
        activate
    });

    useLayoutEffect(() => {
        document.addEventListener('keydown', keydown, true);
        return () => document.removeEventListener('keydown', keydown, true);
    });

    return (
        <div
            className={styles.app}
            data-animations={animations}
            data-pointer-hidden={pointerHidden}
        >
            <TitleBar
                workspaces={workspaces}
                favorites={favorites}
                favoriteBusy={!favoritesReady || savingFavorite}
                toggleFavorite={toggleFavorite}
                active={active}
                creating={creating}
                activate={activate}
                closeWorkspace={closeWorkspace}
                create={create}
                run={run}
            />
            <div className={styles.body}>
                <NavigationRail
                    sidebar={sidebar}
                    active={active}
                    showExplorer={showExplorer}
                    showPanel={showPanel}
                />
                {sidebar &&
                    workspace?.kind !== 'terminal' &&
                    workspaces.map((w) => (
                        <Sidebar
                            gitFiles={w.id === active ? decorations : {}}
                            width={sidebarWidth}
                            onResize={resizeSidebar}
                            key={w.id}
                            workspace={w}
                            active={w.id === active}
                            currentFile={
                                states[w.id]?.buffers.find(
                                    (buffer) => buffer.id === states[w.id]?.current
                                )?.name || ''
                            }
                            onOpen={openFile}
                            onError={report}
                        />
                    ))}
                <main id="editor-preview-host" className={styles.main}>
                    {workspace ? (
                        <FileHeader
                            workspace={workspace}
                            state={state}
                            decorations={decorations}
                            focusEditor={focusEditor}
                            restartShell={restartShell}
                            run={run}
                        />
                    ) : (
                        <Welcome creating={creating} create={create} />
                    )}
                    {workspaces.map((w) => (
                        <Editor
                            key={w.id}
                            theme={theme}
                            id={w.id}
                            terminal={w.kind === 'terminal'}
                            active={w.id === active}
                            fontSize={fontSize}
                            lineHeight={lineHeight}
                            animations={animations}
                            smoothCursor={smoothCursor}
                            smoothBlink={smoothBlink}
                            scrollFollowCursor={scrollFollowCursor}
                            stickyScroll={settings.stickyScroll}
                            stickyScrollMaxLines={settings.stickyScrollMaxLines}
                            blocked={!!panel || leader}
                            focusTick={focusTick}
                            fontFamily={fontFamily.trim() || defaultFontFamily}
                            onError={report}
                        >
                            {w.kind !== 'terminal' &&
                                states[w.id]?.empty &&
                                states[w.id]?.mode === 'n' && (
                                    <WorkspaceWelcome onOpen={() => showPanel('files')} />
                                )}
                        </Editor>
                    ))}
                    {leader && <KeyboardGuide commands={commands} focusEditor={focusEditor} />}
                    {workspaces
                        .filter((w) => w.terminalId)
                        .map((w) => (
                            <TerminalPanel
                                key={w.id}
                                id={w.terminalId!}
                                name={w.name}
                                active={
                                    w.id === active && terminalVisible && bottomPanel === 'terminal'
                                }
                                blocked={!!panel || leader}
                                focusTick={terminalFocusTick}
                                settings={settings}
                                restartShell={restartShell}
                                onError={report}
                                onClose={() => {
                                    setTerminalVisible(false);
                                    focusEditor();
                                }}
                            />
                        ))}
                </main>
            </div>
            {active && state.references && (
                <ReferencesPanel
                    key={active}
                    workspaceId={active}
                    state={state.references}
                    root={workspace?.root || ''}
                    visible={referencesVisible && bottomPanel === 'references'}
                    focusTick={referencesFocusTick}
                    animations={animations}
                    onClose={closeReferences}
                    onOpen={(index) =>
                        run(
                            window.nido
                                .openReference(active, index, state.references!.version)
                                .then(focusEditor)
                        )
                    }
                />
            )}
            {active &&
                workspace?.kind !== 'terminal' &&
                debugVisible &&
                bottomPanel === 'debug' && (
                    <DebugPanel
                        state={state.debug}
                        focusTick={debugFocusTick}
                        onClose={() => {
                            setDebugVisible(false);
                            focusEditor();
                        }}
                        action={(action, target) => {
                            run(window.nido.debug(active, action, target));
                        }}
                    />
                )}
            <StatusBar
                onSearch={(key) => {
                    run(window.nido.input(active, '<Esc>' + key));
                    focusEditor();
                }}
                active={active}
                workspace={workspace}
                state={state}
                sessionCount={workspaces.length}
                onToggleTerminal={toggleTerminal}
                onToggleDebugger={() => {
                    setBottomPanel('debug');
                    setDebugVisible(bottomPanel !== 'debug' || !debugVisible);
                }}
                onToggleReferences={() => {
                    setBottomPanel('references');
                    setReferencesVisible(bottomPanel !== 'references' || !referencesVisible);
                    setReferencesFocusTick((value) => value + 1);
                }}
                onLineEnding={(format) => {
                    run(window.nido.setLineEnding(active, format));
                    focusEditor();
                }}
            />
            <Notification workspaceId={active} animations={animations} />
            {error && (
                <div
                    className={`${styles.error} ${notificationStyles.dismissal}`}
                    data-animations={animations}
                    data-fading={errorFading}
                    role="alert"
                >
                    <span>{error}</span>
                    <button
                        aria-label="Dismiss error"
                        onClick={() => {
                            setError('');
                            setFocusTick((n) => n + 1);
                        }}
                    >
                        <X size={16} />
                    </button>
                </div>
            )}
            <PanelComponent
                settings={settings}
                workspaceId={active}
                initialFolder={workspace?.root || ''}
                favorites={favorites}
                favoriteBusy={!favoritesReady || savingFavorite}
                openFavorite={openFavorite}
                removeFavorite={toggleFavorite}
                creating={creating || restoring}
                openWorkspace={openWorkspace}
                panel={panel}
                filtered={filtered}
                selection={selection}
                query={query}
                loading={loading}
                modal={modal}
                focusEditor={focusEditor}
                setQuery={setQuery}
                setSelection={setSelection}
            />
        </div>
    );
}
