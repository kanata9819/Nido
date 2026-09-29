import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Files, GitBranch, Keyboard, Search, Settings2, Square, X } from 'lucide-react';
import type { FileEntry, SessionState } from '../../shared/types';
import type { Panel } from './types';
import Editor from './Editor';
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
    const [error, setError] = useState('');
    const report = useCallback(
        (message: string): void =>
            setError(message.replace(/^Error: Error invoking remote method '[^']+': Error: /, '')),
        []
    );

    const { workspaces, setWorkspaces, active, setActive, states, mode, restoring } =
        useWorkspaceSessions(report);
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
        sidebar,
        setSidebar,
        animations,
        smoothCursor,
        smoothBlink,
        scrollFollowCursor,
        formatOnSave,
        clipboardSharing,
        relativeLineNumbers,
        editorConfig,
        fontFamily,
        fontSize,
        sidebarWidth,
        resizeSidebar
    } = settings;
    useEffect(() => {
        for (const workspace of workspaces) {
            for (const id of [workspace.id, workspace.terminalId]) {
                if (id) {
                    void window.nido
                        .setClipboardSharing(id, clipboardSharing)
                        .catch((error) => setError(String(error)));
                }
            }
        }
    }, [clipboardSharing, workspaces]);
    useEffect(() => {
        for (const workspace of workspaces) {
            if (workspace.kind !== 'terminal') {
                void window.nido
                    .setRelativeLineNumbers(workspace.id, relativeLineNumbers)
                    .catch((error) => setError(String(error)));
            }
        }
    }, [relativeLineNumbers, workspaces]);
    useEffect(() => {
        for (const workspace of workspaces) {
            if (workspace.kind !== 'terminal') {
                void window.nido
                    .setEditorConfig(workspace.id, editorConfig)
                    .catch((error) => setError(String(error)));
            }
        }
    }, [editorConfig, workspaces]);

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
            window.nido.openTerminal(owner).then((terminal) => {
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
            window.nido.restartTerminal(id).then(() => {
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
            const added = await window.nido.createWorkspace(path, kind);
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
        activate
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
                active={active}
                creating={creating}
                activate={activate}
                closeWorkspace={closeWorkspace}
                create={create}
                run={run}
            />
            <div className={styles.body}>
                <nav className={styles.rail} aria-label="Navigation">
                    <button
                        className={sidebar ? styles.railActive : ''}
                        aria-label="Explorer"
                        title="Explorer (Space e)"
                        onClick={showExplorer}
                    >
                        <Files size={22} />
                    </button>
                    <button
                        aria-label="Find file"
                        title="Find file (Space f)"
                        disabled={!active}
                        onClick={() => showPanel('files')}
                    >
                        <Search size={22} />
                    </button>
                    <button
                        aria-label="Workspaces"
                        title="Workspaces (Space w)"
                        onClick={() => showPanel('workspaces')}
                    >
                        <Square size={20} />
                    </button>
                    <button
                        aria-label="Source control"
                        title="Source control (Ctrl+Shift+G / Space g)"
                        disabled={!active}
                        onClick={() => showPanel('git')}
                    >
                        <GitBranch size={21} />
                    </button>
                    <div className={styles.railGap} />
                    <button
                        aria-label="Command palette"
                        title="Commands (Ctrl+Shift+P)"
                        onClick={() => showPanel('commands')}
                    >
                        <Keyboard size={21} />
                    </button>
                    <button
                        aria-label="Settings"
                        title="Settings (Space ,)"
                        onClick={() => showPanel('settings')}
                    >
                        <Settings2 size={21} />
                    </button>
                </nav>
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
                            id={w.id}
                            terminal={w.kind === 'terminal'}
                            active={w.id === active}
                            fontSize={fontSize}
                            animations={animations}
                            smoothCursor={smoothCursor}
                            smoothBlink={smoothBlink}
                            scrollFollowCursor={scrollFollowCursor}
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
                            <section
                                key={w.id}
                                className={styles.terminalPanel}
                                aria-label="Terminal"
                                hidden={
                                    w.id !== active ||
                                    !terminalVisible ||
                                    bottomPanel !== 'terminal'
                                }
                            >
                                <div className={styles.referencesToolbar}>
                                    <strong>Terminal · {w.name}</strong>
                                    <span>Ctrl+@ Toggle · Ctrl+K Editor</span>
                                    <button
                                        className={styles.restartShell}
                                        title="Restart shell (Ctrl+Shift+R)"
                                        onClick={() => restartShell(w.terminalId!)}
                                    >
                                        Restart shell <kbd>Ctrl Shift R</kbd>
                                    </button>
                                    <button
                                        aria-label="Hide terminal"
                                        onClick={() => {
                                            setTerminalVisible(false);
                                            focusEditor();
                                        }}
                                    >
                                        ×
                                    </button>
                                </div>
                                <Editor
                                    id={w.terminalId!}
                                    terminal
                                    active={
                                        w.id === active &&
                                        terminalVisible &&
                                        bottomPanel === 'terminal'
                                    }
                                    fontSize={fontSize}
                                    animations={false}
                                    smoothCursor={smoothCursor}
                                    smoothBlink={smoothBlink}
                                    blocked={!!panel || leader}
                                    focusTick={terminalFocusTick}
                                    fontFamily={fontFamily.trim() || defaultFontFamily}
                                    onError={report}
                                />
                            </section>
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
                onSearch={key => {run(window.nido.input(active, '<Esc>' + key)); focusEditor();}}
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
            {error && (
                <div className={styles.error} role="alert">
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
