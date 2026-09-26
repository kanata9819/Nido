import { useCallback, useEffect, useRef, useState } from 'react'
import {
    ArrowRight,
    ChevronRight,
    Code2,
    Command,
    FileCode2,
    Files,
    FolderOpen,
    Keyboard,
    Leaf,
    Minus,
    Plus,
    Search,
    Settings2,
    Square,
    X
} from 'lucide-react'
import type { FileEntry, SessionState, Workspace } from '../../shared/types'
import Editor from './Editor'
import Sidebar from './Sidebar'
import styles from './assets/Nido.module.css'

type Panel = 'commands' | 'workspaces' | 'files' | 'buffers' | 'settings' | null
interface Item {
    key: string
    title: string
    detail: string
    run: () => void
}
const filename = (path: string): string => path.split(/[\\/]/).pop() || '[Untitled]'
const defaultState: SessionState = {
    buffers: [],
    current: 0,
    mode: 'n',
    line: 1,
    column: 1,
    filetype: ''
}

function WorkspaceWelcome({ onOpen }: { onOpen: () => void }): React.JSX.Element {
    return (
        <section className={`${styles.welcome} ${styles.workspaceWelcome}`} aria-label="Workspace welcome">
            <div className={styles.welcomeMark}>
                <Leaf size={43} strokeWidth={1.4} />
            </div>
            <h1>Nido</h1>
            <p>
                A place for your code.
                <br />
                Open a file to get started.
            </p>
            <button className={styles.primary} onClick={onOpen}>
                <FolderOpen size={18} /> Open a file <kbd>Ctrl P</kbd>
            </button>
            <div className={styles.welcomeKeys}>
                <span>
                    <kbd>Space</kbd> Commands
                </span>
                <span>
                    <kbd>i</kbd> Start writing
                </span>
            </div>
        </section>
    )
}

export default function App(): React.JSX.Element {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([])
    const [selectedWorkspace, setActive] = useState('')
    const [states, setStates] = useState<Record<string, SessionState>>({})
    const [panel, setPanel] = useState<Panel>(null)
    const [leader, setLeader] = useState(false)
    const [query, setQuery] = useState('')
    const [selection, setSelection] = useState(0)
    const [fileList, setFileList] = useState<FileEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [creating, setCreating] = useState(false)
    const [restoring, setRestoring] = useState(true)
    const [error, setError] = useState('')
    const [focusTick, setFocusTick] = useState(0)
    const [sidebar, setSidebar] = useState(true)
    const [fontSize, setFontSize] = useState(() => {
        const value = Number(localStorage.getItem('nido.fontSize'))
        return value >= 12 && value <= 24 ? value : 15
    })
    const modal = useRef<HTMLDivElement>(null),
        mode = useRef<Record<string, string>>({})
    const active = workspaces.some((w) => w.id === selectedWorkspace) ? selectedWorkspace : workspaces[0]?.id || ''
    const state = states[active] || defaultState
    const workspace = workspaces.find((w) => w.id === active)
    const current = state.buffers.find((b) => b.id === state.current)
    const report = useCallback(
        (message: string): void =>
            setError(message.replace(/^Error: Error invoking remote method '[^']+': Error: /, '')),
        []
    )

    const focusEditor = (): void => {
        setPanel(null)
        setLeader(false)
        setFocusTick((n) => n + 1)
    }

    const run = (promise: Promise<unknown>): void => {
        void promise.catch((e) => report(String(e)))
    }

    const activate = (id: string): void => {
        setActive(id)
        focusEditor()
    }

    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.type === 'state') setStates((old) => ({ ...old, [event.id]: event.state }))
                else if (event.type === 'redraw') {
                    for (const [name, ...calls] of event.events)
                        if (name === 'mode_change') mode.current[event.id] = String(calls.at(-1)?.[0])
                } else if (event.type === 'error') report(event.message)
                else if (event.type === 'exit') {
                    setWorkspaces((old) => old.filter((w) => w.id !== event.id))
                    setStates((old) => {
                        const next = { ...old }
                        delete next[event.id]
                        return next
                    })
                }
            }),
        [report]
    )

    useEffect(() => {
        let cancelled = false
        void window.nido
            .restoreWorkspaces()
            .then((result) => {
                if (cancelled) return
                setWorkspaces(result.workspaces)
                setActive(result.active)
                if (result.errors.length) report(result.errors.join('\n'))
            })
            .catch((e) => {
                if (!cancelled) report(String(e))
            })
            .finally(() => {
                if (!cancelled) setRestoring(false)
            })
        return () => {
            cancelled = true
        }
    }, [report])

    useEffect(() => {
        if (!restoring)
            void window.nido
                .workspaceLayout(
                    workspaces.map((w) => w.id),
                    active
                )
                .catch((e) => report(String(e)))
    }, [workspaces, active, restoring, report])

    useEffect(() => {
        localStorage.setItem('nido.fontSize', String(fontSize))
    }, [fontSize])

    useEffect(() => {
        if (panel !== 'files' || !active) return
        let cancelled = false
        window.nido
            .findFiles(active)
            .then((files) => {
                if (!cancelled) setFileList(files)
            })
            .catch((e) => {
                if (!cancelled) report(String(e))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [panel, active, report])

    const create = async (): Promise<void> => {
        if (creating || restoring) return
        setCreating(true)
        setLeader(false)
        setPanel(null)
        try {
            const added = await window.nido.createWorkspace()
            if (added) {
                setWorkspaces((old) => [...old, added])
                setActive(added.id)
            }
        } catch (e) {
            report(String(e))
        } finally {
            setCreating(false)
            setFocusTick((n) => n + 1)
        }
    }

    const nextWorkspace = (offset: number): void => {
        if (!workspaces.length) return
        activate(
            workspaces[(workspaces.findIndex((w) => w.id === active) + offset + workspaces.length) % workspaces.length]
                .id
        )
    }

    const moveWorkspace = (offset: number): void => {
        setWorkspaces((old) => {
            const index = old.findIndex((w) => w.id === active),
                target = index + offset
            if (target < 0 || target >= old.length) return old
            const next = [...old]
            ;[next[index], next[target]] = [next[target], next[index]]
            return next
        })
        focusEditor()
    }

    const openFile = (path: string): void => {
        run(window.nido.openFile(active, path).then(focusEditor))
    }

    const closeWorkspace = (id: string): void => {
        run(
            window.nido.closeWorkspace(id).then(() => {
                setFocusTick((n) => n + 1)
            })
        )
    }

    const showPanel = (value: Panel): void => {
        setLeader(false)
        setQuery('')
        setSelection(0)
        setPanel(value)
        if (value === 'files') {
            setLoading(true)
            setFileList([])
        }
    }

    const showExplorer = (): void => {
        setLeader(false)
        setPanel(null)
        setSidebar(true)
        requestAnimationFrame(() => document.querySelector<HTMLElement>('aside:not([hidden]) [role="tree"]')?.focus())
    }

    const commands: Item[] = [
        {
            key: 'w',
            title: 'Switch workspace',
            detail: 'Independent Neovim sessions',
            run: () => showPanel('workspaces')
        },
        {
            key: 'n',
            title: 'Open workspace',
            detail: 'Choose a project folder · Ctrl+Shift+N',
            run: () => void create()
        },
        ...(active
            ? [
                  ...(state.lsp
                      ? [
                            ['Go to definition', 'F12 / gd', '<F12>'],
                            ['Find references', 'Shift+F12 / gr', '<S-F12>'],
                            ['Go to implementation', 'gI', 'gI'],
                            ['Go to type definition', 'gy', 'gy'],
                            ['Show documentation', 'K', 'K'],
                            ['Rename symbol', 'F2', '<F2>'],
                            ['Code actions', 'gra', 'gra'],
                            ['Format file', 'g=', 'g='],
                            ['Show diagnostic', 'gl', 'gl'],
                            ['Next diagnostic', ']d', ']d']
                        ].map(([title, detail, keys]) => ({
                            key: '',
                            title,
                            detail,
                            run: () => {
                                run(window.nido.input(active, `<Esc>${keys}`))
                                focusEditor()
                            }
                        }))
                      : []),
                  {
                      key: 'f',
                      title: 'Find file',
                      detail: 'Search project filenames · Ctrl+P',
                      run: () => showPanel('files')
                  },
                  {
                      key: 'b',
                      title: 'Switch file',
                      detail: 'Open buffers in this workspace',
                      run: () => showPanel('buffers')
                  },
                  {
                      key: 'e',
                      title: 'Focus explorer',
                      detail: 'Navigate with j / k / h / l',
                      run: showExplorer
                  },
                  {
                      key: 's',
                      title: 'Save file',
                      detail: ':w · Ctrl+S',
                      run: () => {
                          run(window.nido.save(active))
                          focusEditor()
                      }
                  },
                  {
                      key: 'h',
                      title: 'Move workspace left',
                      detail: 'Reorder the workspace tabs',
                      run: () => moveWorkspace(-1)
                  },
                  {
                      key: 'l',
                      title: 'Move workspace right',
                      detail: 'Reorder the workspace tabs',
                      run: () => moveWorkspace(1)
                  },
                  {
                      key: 'x',
                      title: 'Close workspace',
                      detail: 'Prompts for unsaved changes',
                      run: () => {
                          focusEditor()
                          closeWorkspace(active)
                      }
                  },
                  {
                      key: 'd',
                      title: 'Close file',
                      detail: 'Prompts for unsaved changes',
                      run: () => {
                          run(window.nido.closeBuffer(active, state.current))
                          focusEditor()
                      }
                  }
              ]
            : []),
        {
            key: ',',
            title: 'Settings',
            detail: 'Editor font size and sidebar',
            run: () => showPanel('settings')
        },
        {
            key: 'q',
            title: 'Quit Nido',
            detail: 'Prompts for unsaved changes',
            run: () => run(window.nido.windowAction('close'))
        }
    ]
    const items: Item[] =
        panel === 'workspaces'
            ? [
                  ...workspaces.map((w, i) => ({
                      key: String(i + 1),
                      title: w.name,
                      detail: w.root,
                      run: () => activate(w.id)
                  })),
                  {
                      key: '+',
                      title: 'Open workspace',
                      detail: 'Start another independent session',
                      run: () => void create()
                  }
              ]
            : panel === 'files'
              ? fileList.map((f) => ({
                    key: '',
                    title: f.name,
                    detail: f.path,
                    run: () => openFile(f.path)
                }))
              : panel === 'buffers'
                ? state.buffers.map((b) => ({
                      key: b.modified ? '●' : '',
                      title: filename(b.name),
                      detail: b.name || 'Untitled buffer',
                      run: () => {
                          run(window.nido.selectBuffer(active, b.id))
                          focusEditor()
                      }
                  }))
                : commands
    const filtered = items
        .filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 100)

    useEffect(() => {
        const keydown = (event: KeyboardEvent): void => {
            if (event.isComposing || event.keyCode === 229) return
            const consume = (): void => {
                event.preventDefault()
                event.stopPropagation()
            }
            if (event.key === 'Escape') {
                if (error) {
                    consume()
                    setError('')
                    setFocusTick((n) => n + 1)
                    return
                }
                if (
                    panel ||
                    leader ||
                    (document.activeElement as HTMLElement)?.getAttribute('aria-label') !== 'Neovim input'
                ) {
                    consume()
                    focusEditor()
                    return
                }
            }
            if (panel) {
                if (event.key === 'Tab' && modal.current) {
                    const nodes = [...modal.current.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')]
                    const first = nodes[0],
                        last = nodes[nodes.length - 1]
                    if (event.shiftKey && document.activeElement === first) {
                        consume()
                        last?.focus()
                    } else if (!event.shiftKey && document.activeElement === last) {
                        consume()
                        first?.focus()
                    }
                }
                return
            }
            if (event.ctrlKey && event.key === 'Tab') {
                consume()
                nextWorkspace(event.shiftKey ? -1 : 1)
                return
            }
            if (
                active &&
                event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                !event.shiftKey &&
                ['h', 'l'].includes(event.key.toLowerCase())
            ) {
                consume()
                if (event.key.toLowerCase() === 'h') showExplorer()
                else focusEditor()
                return
            }
            if (event.altKey && /^[1-9]$/.test(event.key)) {
                consume()
                const w = workspaces[Number(event.key) - 1]
                if (w) activate(w.id)
                return
            }
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'n') {
                consume()
                void create()
                return
            }
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
                consume()
                showPanel('commands')
                return
            }
            if (
                event.ctrlKey &&
                event.key.toLowerCase() === 'p' &&
                active &&
                !mode.current[active]?.startsWith('insert')
            ) {
                consume()
                showPanel('files')
                return
            }
            if (event.ctrlKey && event.key.toLowerCase() === 's' && active) {
                consume()
                run(window.nido.save(active))
                return
            }
            if (leader) {
                consume()
                if (event.key === ' ') showPanel('commands')
                else commands.find((command) => command.key === event.key)?.run()
                return
            }
            if (
                event.shiftKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                ['H', 'L'].includes(event.key) &&
                document.activeElement?.getAttribute('aria-label') === 'Neovim input' &&
                (mode.current[active] || 'normal') === 'normal' &&
                state.buffers.length > 0
            ) {
                consume()
                const index = state.buffers.findIndex((buffer) => buffer.id === state.current)
                const offset = event.key === 'H' ? -1 : 1
                const next = state.buffers[(index + offset + state.buffers.length) % state.buffers.length]
                run(window.nido.selectBuffer(active, next.id))
                return
            }
            if (
                event.key === ' ' &&
                !event.ctrlKey &&
                !event.altKey &&
                document.activeElement?.getAttribute('aria-label') === 'Neovim input' &&
                (mode.current[active] || 'normal') === 'normal'
            ) {
                consume()
                setLeader(true)
            }
        }
        document.addEventListener('keydown', keydown, true)
        return () => document.removeEventListener('keydown', keydown, true)
    })

    return (
        <div className={styles.app}>
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
                <div className={styles.windowControls}>
                    <button aria-label="Minimize" onClick={() => run(window.nido.windowAction('minimize'))}>
                        <Minus size={15} />
                    </button>
                    <button aria-label="Maximize or restore" onClick={() => run(window.nido.windowAction('maximize'))}>
                        <Square size={12} />
                    </button>
                    <button aria-label="Close Nido" onClick={() => run(window.nido.windowAction('close'))}>
                        <X size={17} />
                    </button>
                </div>
            </header>
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
                    <div className={styles.railGap} />
                    <button
                        aria-label="Command palette"
                        title="Commands (Ctrl+Shift+P)"
                        onClick={() => showPanel('commands')}
                    >
                        <Keyboard size={21} />
                    </button>
                    <button aria-label="Settings" title="Settings (Space ,)" onClick={() => showPanel('settings')}>
                        <Settings2 size={21} />
                    </button>
                </nav>
                {sidebar &&
                    workspaces.map((w) => (
                        <Sidebar
                            key={w.id}
                            workspace={w}
                            active={w.id === active}
                            currentFile={
                                states[w.id]?.buffers.find((buffer) => buffer.id === states[w.id]?.current)?.name || ''
                            }
                            onOpen={openFile}
                            onError={report}
                        />
                    ))}
                <main className={styles.main}>
                    {workspace ? (
                        <>
                            <div className={styles.fileTabs} role="tablist" aria-label="Files">
                                {state.buffers.map((buffer) => (
                                    <div
                                        key={buffer.id}
                                        className={`${styles.fileTab} ${state.current === buffer.id ? styles.activeFile : ''}`}
                                    >
                                        <button
                                            role="tab"
                                            aria-selected={state.current === buffer.id}
                                            title={buffer.name}
                                            onClick={() => {
                                                run(window.nido.selectBuffer(active, buffer.id))
                                                focusEditor()
                                            }}
                                        >
                                            <FileCode2 size={15} />
                                            <span>{filename(buffer.name)}</span>
                                            {buffer.modified && (
                                                <span className={styles.unsaved} aria-label="Unsaved" />
                                            )}
                                        </button>
                                        <button
                                            className={styles.tabClose}
                                            aria-label={`Close file ${filename(buffer.name)}`}
                                            onClick={() => run(window.nido.closeBuffer(active, buffer.id))}
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <div className={styles.breadcrumb}>
                                <span>{workspace.name}</span>
                                <ChevronRight size={13} />
                                <span>
                                    {current?.name
                                        ? current.name
                                              .replace(workspace.root, '')
                                              .replace(/^[\\/]/, '')
                                              .replaceAll('\\', ' / ')
                                        : 'Untitled'}
                                </span>
                                <span className={styles.breadcrumbHint}>SPACE for commands</span>
                            </div>
                        </>
                    ) : (
                        <section className={styles.welcome}>
                            <div className={styles.welcomeMark}>
                                <Leaf size={43} strokeWidth={1.4} />
                            </div>
                            <p className={styles.eyebrow}>A PLACE FOR YOUR CODE</p>
                            <h1>Make yourself at home.</h1>
                            <p>
                                Your projects, together.
                                <br />
                                The Neovim you know. A little more room to think.
                            </p>
                            <button className={styles.primary} disabled={creating} onClick={() => void create()}>
                                <FolderOpen size={18} />
                                {creating ? 'Starting Neovim…' : 'Open a workspace'}
                                <ArrowRight size={17} />
                            </button>
                            <div className={styles.welcomeKeys}>
                                <span>
                                    <kbd>Ctrl Shift N</kbd> Open workspace
                                </span>
                                <span>
                                    <kbd>Ctrl Shift P</kbd> All commands
                                </span>
                            </div>
                            <div className={styles.welcomeNote}>
                                <span className={styles.liveDot} /> Every workspace runs its own Neovim session.
                            </div>
                        </section>
                    )}
                    {workspaces.map((w) => (
                        <Editor
                            key={w.id}
                            id={w.id}
                            active={w.id === active}
                            fontSize={fontSize}
                            blocked={!!panel || leader}
                            focusTick={focusTick}
                            onError={report}
                        >
                            {states[w.id]?.empty && states[w.id]?.mode === 'n' && (
                                <WorkspaceWelcome onOpen={() => showPanel('files')} />
                            )}
                        </Editor>
                    ))}
                    {leader && (
                        <div className={styles.leader} role="dialog" aria-label="Keyboard commands">
                            <div className={styles.leaderTitle}>
                                <kbd>SPACE</kbd>
                                <span>Where to?</span>
                                <button aria-label="Dismiss commands" onClick={focusEditor}>
                                    <X size={14} />
                                </button>
                            </div>
                            <div className={styles.leaderGrid}>
                                {commands
                                    .filter((c) => ['w', 'f', 'b', 'e', 'n', ',', 's', 'x'].includes(c.key))
                                    .map((c) => (
                                        <button key={c.key} onClick={c.run}>
                                            <kbd>{c.key}</kbd>
                                            {c.title}
                                        </button>
                                    ))}
                            </div>
                            <footer>
                                <span>Space again for all commands</span>
                                <span>Esc to dismiss</span>
                            </footer>
                        </div>
                    )}
                </main>
            </div>
            <footer className={styles.statusbar}>
                <span className={styles.mode}>
                    {state.mode.startsWith('i')
                        ? 'INSERT'
                        : state.mode.startsWith('v') || state.mode === 'V' || state.mode === '\u0016'
                          ? 'VISUAL'
                          : state.mode.startsWith('c')
                            ? 'COMMAND'
                            : 'NORMAL'}
                </span>
                <span className={styles.statusWorkspace}>{workspace?.name || 'Welcome to Nido'}</span>
                <span className={styles.statusDivider} />
                <span className={styles.sessionCount}>
                    {workspaces.length} {workspaces.length === 1 ? 'session' : 'sessions'}
                </span>
                <span className={styles.statusGap} />
                <span>{state.filetype || 'Plain text'}</span>
                {state.filetype === 'rust' && (
                    <span title="Rust language server connection">{state.lsp || 'Rust LSP: not connected'}</span>
                )}
                <span>UTF-8</span>
                <span>
                    Ln {state.line}, Col {state.column}
                </span>
                <Code2 size={15} />
            </footer>
            {error && (
                <div className={styles.error} role="alert">
                    <span>{error}</span>
                    <button
                        aria-label="Dismiss error"
                        onClick={() => {
                            setError('')
                            setFocusTick((n) => n + 1)
                        }}
                    >
                        <X size={16} />
                    </button>
                </div>
            )}
            {panel && (
                <div
                    className={styles.scrim}
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) focusEditor()
                    }}
                >
                    <div
                        className={styles.palette}
                        role="dialog"
                        aria-modal="true"
                        aria-label={panel === 'settings' ? 'Settings' : `${panel} palette`}
                        ref={modal}
                    >
                        <div className={styles.paletteHeading}>
                            <Command size={17} />
                            <span>
                                {panel === 'files'
                                    ? 'Find a file'
                                    : panel === 'workspaces'
                                      ? 'Your workspaces'
                                      : panel === 'buffers'
                                        ? 'Open files'
                                        : panel === 'settings'
                                          ? 'Settings'
                                          : 'All commands'}
                            </span>
                            <button aria-label="Close palette" onClick={focusEditor}>
                                <X size={17} />
                            </button>
                        </div>
                        {panel === 'settings' ? (
                            <div className={styles.settings}>
                                <label>
                                    Editor font size{' '}
                                    <input
                                        autoFocus
                                        type="range"
                                        min="12"
                                        max="24"
                                        value={fontSize}
                                        onChange={(e) => setFontSize(Number(e.target.value))}
                                    />
                                    <span>{fontSize}px</span>
                                </label>
                                <label>
                                    Show file explorer{' '}
                                    <input
                                        type="checkbox"
                                        checked={sidebar}
                                        onChange={(e) => setSidebar(e.target.checked)}
                                    />
                                </label>
                                <p>
                                    Vim editing · Space commands · Ctrl+Tab workspaces
                                    <br />
                                    Nido includes its own Neovim and editor settings. Personal Neovim config is not
                                    loaded.
                                </p>
                            </div>
                        ) : (
                            <>
                                <input
                                    autoFocus
                                    className={styles.paletteInput}
                                    aria-label="Filter items"
                                    placeholder={panel === 'files' ? 'Type a filename…' : 'Type to search…'}
                                    value={query}
                                    onChange={(event) => {
                                        setQuery(event.target.value)
                                        setSelection(0)
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
                                            event.preventDefault()
                                            setSelection((n) => Math.min(n + 1, filtered.length - 1))
                                        } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
                                            event.preventDefault()
                                            setSelection((n) => Math.max(0, n - 1))
                                        } else if (event.key === 'Enter') {
                                            event.preventDefault()
                                            filtered[Math.max(0, selection)]?.run()
                                        }
                                    }}
                                />
                                <div className={styles.paletteItems}>
                                    {filtered.map((item, i) => (
                                        <button
                                            key={`${item.title}-${i}`}
                                            className={i === selection ? styles.selectedItem : ''}
                                            ref={(node) => {
                                                if (node && i === selection) node.scrollIntoView({ block: 'nearest' })
                                            }}
                                            onClick={item.run}
                                        >
                                            <span className={styles.itemIcon}>
                                                {panel === 'workspaces' ? (
                                                    <FolderOpen size={18} />
                                                ) : panel === 'files' || panel === 'buffers' ? (
                                                    <FileCode2 size={18} />
                                                ) : (
                                                    <Command size={17} />
                                                )}
                                            </span>
                                            <span>
                                                <strong>{item.title}</strong>
                                                <small>{item.detail}</small>
                                            </span>
                                            {item.key && <kbd>{item.key}</kbd>}
                                        </button>
                                    ))}
                                    {!filtered.length && (
                                        <p className={styles.noResults}>
                                            {loading ? 'Looking through your project…' : 'No matching items.'}
                                        </p>
                                    )}
                                </div>
                                <div className={styles.paletteFooter}>
                                    <span>↑ ↓ or Ctrl+j / k to navigate</span>
                                    <span>Enter to select · Esc to return</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
