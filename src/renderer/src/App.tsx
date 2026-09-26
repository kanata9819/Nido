import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type { FileEntry, SessionState, Workspace } from '../../shared/types';
import type { Panel, Item } from './types';
import Editor from './Editor';
import Sidebar from './Sidebar';
import { buildItems, filename } from './commands';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Panel as PanelComponent } from './components/Panel';
import styles from './assets/Nido.module.css';

const defaultState: SessionState = {
  buffers: [],
  current: 0,
  mode: 'n',
  line: 1,
  column: 1,
  filetype: ''
};

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
  );
}

export default function App(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setActive] = useState('');
  const [states, setStates] = useState<Record<string, SessionState>>({});
  const [panel, setPanel] = useState<Panel>(null);
  const [leader, setLeader] = useState(false);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(0);
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [fontSize, setFontSize] = useState(() => {
    const value = Number(localStorage.getItem('nido.fontSize'));
    return value >= 12 && value <= 24 ? value : 15;
  });
  const modal = useRef<HTMLDivElement>(null),
    mode = useRef<Record<string, string>>({});
  const active = workspaces.some((w) => w.id === selectedWorkspace) ? selectedWorkspace : workspaces[0]?.id || '';
  const state = states[active] || defaultState;
  const workspace = workspaces.find((w) => w.id === active);
  const current = state.buffers.find((b) => b.id === state.current);
  const report = useCallback(
    (message: string): void => setError(message.replace(/^Error: Error invoking remote method '[^']+': Error: /, '')),
    []
  );

  const focusEditor = (): void => {
    setPanel(null);
    setLeader(false);
    setFocusTick((n) => n + 1);
  };

  const run = (promise: Promise<unknown>): void => {
    void promise.catch((e) => report(String(e)));
  };

  const activate = (id: string): void => {
    setActive(id);
    focusEditor();
  };

  useEffect(
    () =>
      window.nido.onEvent((event) => {
        if (event.type === 'state') {
          setStates((old) => ({ ...old, [event.id]: event.state }));
        } else if (event.type === 'redraw') {
          for (const [name, ...calls] of event.events)
            if (name === 'mode_change') {
              mode.current[event.id] = String(calls.at(-1)?.[0]);
            }
        } else if (event.type === 'error') {
          report(event.message);
        } else if (event.type === 'exit') {
          setWorkspaces((old) => old.filter((w) => w.id !== event.id));
          setStates((old) => {
            const next = { ...old };
            delete next[event.id];
            return next;
          });
        }
      }),
    [report]
  );

  useEffect(() => {
    let cancelled = false;
    void window.nido
      .restoreWorkspaces()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setWorkspaces(result.workspaces);
        setActive(result.active);
        if (result.errors.length) {
          report(result.errors.join('\n'));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          report(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRestoring(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [report]);

  useEffect(() => {
    if (!restoring) {
      void window.nido
        .workspaceLayout(
          workspaces.map((w) => w.id),
          active
        )
        .catch((e) => report(String(e)));
    }
  }, [workspaces, active, restoring, report]);

  useEffect(() => {
    localStorage.setItem('nido.fontSize', String(fontSize));
  }, [fontSize]);

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
    if (creating || restoring) {
      return;
    }
    setCreating(true);
    setLeader(false);
    setPanel(null);

    try {
      const added = await window.nido.createWorkspace();
      if (added) {
        setWorkspaces((old) => [...old, added]);
        setActive(added.id);
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
      workspaces[(workspaces.findIndex((w) => w.id === active) + offset + workspaces.length) % workspaces.length].id
    );
  };

  const moveWorkspace = (offset: number): void => {
    setWorkspaces((old) => {
      const index = old.findIndex((w) => w.id === active),
        target = index + offset;
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
    setLeader(false);
    setPanel(null);
    setSidebar(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('aside:not([hidden]) [role="tree"]')?.focus());
  };

  const { commands, items, filtered } = buildItems(
    active,
    panel,
    workspaces,
    fileList,
    state,
    query,
    { showPanel, moveWorkspace, run, focusEditor, closeWorkspace, create, showExplorer, openFile, activate }
  );

  const keydown = useKeyboardShortcuts({
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
    state: { buffers: state.buffers, current: state.current },
    run,
    setLeader,
    activate
  });

  useEffect(() => {
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  });

  return (
    <div className={styles.app}>
      <header className={styles.titlebar}>
        <div className={styles.brand}>
          <Leaf size={22} />
          <span>Nido</span>
        </div>
        <div className={styles.workspaces} role="tablist" aria-label="Workspaces">
          {workspaces.map((w, i) => (
            <div key={w.id} className={`${styles.workspaceTab} ${active === w.id ? styles.activeWorkspace : ''}`}>
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
          <button aria-label="Workspaces" title="Workspaces (Space w)" onClick={() => showPanel('workspaces')}>
            <Square size={20} />
          </button>
          <div className={styles.railGap} />
          <button aria-label="Command palette" title="Commands (Ctrl+Shift+P)" onClick={() => showPanel('commands')}>
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
              currentFile={states[w.id]?.buffers.find((buffer) => buffer.id === states[w.id]?.current)?.name || ''}
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
                        run(window.nido.selectBuffer(active, buffer.id));
                        focusEditor();
                      }}
                    >
                      <FileCode2 size={15} />
                      <span>{filename(buffer.name)}</span>
                      {buffer.modified && <span className={styles.unsaved} aria-label="Unsaved" />}
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
              setError('');
              setFocusTick((n) => n + 1);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <PanelComponent
        panel={panel}
        filtered={filtered}
        items={items}
        selection={selection}
        query={query}
        loading={loading}
        modal={modal}
        focusEditor={focusEditor}
        fontSize={fontSize}
        setFontSize={setFontSize}
        sidebar={sidebar}
        setSidebar={setSidebar}
        setQuery={setQuery}
        setSelection={setSelection}
        report={report}
      />
    </div>
  );
}
