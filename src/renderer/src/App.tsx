import { LanguageContext, useI18n } from './i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FileEntry, SessionState } from '../../shared/types';
import type { Panel } from './types';
import Editor from './Editor';
import TerminalPanel from './components/TerminalPanel';
import Notification from './components/Notification';
import NavigationRail from './components/NavigationRail';
// import FeaturesPage from './components/FeaturesPage';
import { useSessionSettings } from './hooks/useSessionSettings';
import Sidebar from './Sidebar';
import FileHeader from './components/FileHeader';
import KeyboardGuide from './components/KeyboardGuide';
import { Panel as PanelComponent } from './components/Panel';
import WorkspacePanels from './components/WorkspacePanels';
import { useBottomPanels } from './hooks/useBottomPanels';
import { useWorkspaceActions } from './hooks/useWorkspaceActions';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';
import { Welcome, WorkspaceWelcome } from './components/Welcome';
import WorkspaceLoading from './components/WorkspaceLoading';
import { buildItems } from './commands';
import { fileDecorations } from './fileDecorations';
import {
    defaultFontFamily,
    useEditorSettings,
    type EditorSettings
} from './hooks/useEditorSettings';
import { useFavoriteWorkspaces } from './hooks/useFavoriteWorkspaces';
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
    const settings = useEditorSettings();
    return (
        <LanguageContext value={settings.language}>
            <AppContent settings={settings} />
        </LanguageContext>
    );
}

function AppContent({ settings }: { settings: EditorSettings }): React.JSX.Element {
    const t = useI18n();
    const pointerHidden = usePointerVisibility();
    const [panel, setPanel] = useState<Panel>(null);
    const [leader, setLeader] = useState(false);
    const [query, setQuery] = useState('');
    const [selection, setSelection] = useState(0);
    const [fileList, setFileList] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
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
    const [initializedEditors, setInitializedEditors] = useState<ReadonlySet<string>>(
        () => new Set()
    );
    const finishEditorLoading = useCallback((id: string): void => {
        setInitializedEditors((old) => (old.has(id) ? old : new Set([...old, id])));
    }, []);
    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.type === 'exit') {
                    setInitializedEditors((old) => {
                        if (!old.has(event.id)) {
                            return old;
                        }
                        const next = new Set(old);
                        next.delete(event.id);
                        return next;
                    });
                }
            }),
        []
    );
    const {
        favorites,
        ready: favoritesReady,
        busy: savingFavorite,
        toggleFavorite
    } = useFavoriteWorkspaces(report);
    const [focusTick, setFocusTick] = useState(0);
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
    useLayoutEffect(() => {
        document.documentElement.lang = settings.language;
        void window.nido.setLanguage(settings.language).catch((error) => report(String(error)));
    }, [settings.language, report]);
    const errorFading = useNotificationDismissal(errorNotice, animations, dismissError);
    useSessionSettings(workspaces, settings, report);

    const modal = useRef<HTMLDivElement>(null);
    const state = states[active] || defaultState;
    const gitFiles = useGitFileStatus(active, state.buffers, panel);
    const workspace = workspaces.find((w) => w.id === active);
    const decorations = useMemo(
        () => fileDecorations(workspace?.root || '', gitFiles, state.diagnostics, state.problems),
        [workspace?.root, gitFiles, state.diagnostics, state.problems]
    );
    const focusEditor = useCallback((): void => {
        setPanel(null);
        setLeader(false);
        setFocusTick((n) => n + 1);
        if (panel === 'features' && !active) {
            requestAnimationFrame(() =>
                document.querySelector<HTMLElement>('[data-features-trigger]')?.focus()
            );
        }
    }, [panel, active]);

    const run = useCallback(
        (promise: Promise<unknown>): void => {
            void promise.catch((e) => report(String(e)));
        },
        [report]
    );

    const panels = useBottomPanels({
        active,
        workspace,
        state,
        terminalShell: settings.terminalShell,
        setWorkspaces,
        focusEditor,
        dismissLeader: () => setLeader(false),
        closeOverlay: () => {
            setLeader(false);
            setPanel(null);
        },
        run
    });
    const { toggleTerminal, restartShell, closeReferences, openDebugger } = panels;

    const {
        creating,
        create,
        activate,
        openWorkspace,
        openFavorite,
        nextWorkspace,
        moveWorkspace,
        closeWorkspace
    } = useWorkspaceActions({
        workspaces,
        active,
        restoring,
        terminalShell: settings.terminalShell,
        setWorkspaces,
        setActive,
        focusEditor,
        requestEditorFocus: () => setFocusTick((value) => value + 1),
        dismissLeader: () => setLeader(false),
        showFolders: () => setPanel('folders'),
        closeOverlay: () => setPanel(null),
        report,
        run
    });

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

    const openFile = useCallback(
        (path: string): void => {
            run(window.nido.openFile(active, path).then(focusEditor));
        },
        [active, run, focusEditor]
    );

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
    const { commands, filtered } = buildItems(
        active,
        panel,
        workspaces,
        fileList,
        state,
        query,
        {
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
        },
        t
    );

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
        showDebugger: panels.showDebugger,
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
                    panel={panel}
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
                    <div
                        className={styles.editorContent}
                        inert={panel === 'features'}
                        aria-hidden={panel === 'features' || undefined}
                    >
                        {workspace ? (
                            <FileHeader
                                workspace={workspace}
                                state={state}
                                decorations={decorations}
                                focusEditor={focusEditor}
                                restartShell={restartShell}
                                run={run}
                            />
                        ) : !restoring ? (
                            <Welcome creating={creating} create={create} />
                        ) : null}
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
                                onReady={finishEditorLoading}
                                onError={(message) => {
                                    finishEditorLoading(w.id);
                                    report(message);
                                }}
                            >
                                {w.kind !== 'terminal' &&
                                    states[w.id]?.empty &&
                                    states[w.id]?.mode === 'n' && (
                                        <WorkspaceWelcome onOpen={() => showPanel('files')} />
                                    )}
                            </Editor>
                        ))}
                        {(restoring || (!!workspace && !initializedEditors.has(active))) && (
                            <WorkspaceLoading />
                        )}
                        {leader && <KeyboardGuide commands={commands} focusEditor={focusEditor} />}
                        {workspaces
                            .filter((w) => w.terminalId)
                            .map((w) => (
                                <TerminalPanel
                                    key={w.id}
                                    id={w.terminalId!}
                                    name={w.name}
                                    active={
                                        w.id === active &&
                                        panels.terminalVisible &&
                                        panels.bottomPanel === 'terminal'
                                    }
                                    blocked={!!panel || leader}
                                    focusTick={panels.terminalFocusTick}
                                    settings={settings}
                                    restartShell={restartShell}
                                    onError={report}
                                    onClose={panels.closeTerminal}
                                />
                            ))}
                    </div>
                    {/* {panel === 'features' && <FeaturesPage onClose={focusEditor} />} */}
                </main>
            </div>
            <WorkspacePanels
                active={active}
                workspace={workspace}
                state={state}
                panels={panels}
                animations={animations}
            />
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
                onToggleDebugger={panels.toggleDebugger}
                onToggleReferences={panels.toggleReferences}
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
                        aria-label={t('Dismiss error')}
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
