import type { Panel, Item } from './types';
import type { DebugAction, FileEntry, SessionState, Workspace } from '../../shared/types';
import { createTranslator, type Translator } from '../../shared/i18n';

interface CommandsCallbacks {
    save: () => void;
    showPanel: (value: Panel) => void;
    moveWorkspace: (offset: number) => void;
    run: (promise: Promise<unknown>) => void;
    focusEditor: () => void;
    closeWorkspace: (id: string) => void;
    create: () => Promise<void>;
    showExplorer: () => void;
    openDebugger: () => void;
    openFile: (path: string) => void;
    activate: (id: string) => void;
    toggleFavorite: () => void;
    isFavorite: boolean;
}

export function buildItems(
    active: string,
    panel: Panel,
    workspaces: Workspace[],
    fileList: FileEntry[],
    state: SessionState,
    query: string,
    callbacks: CommandsCallbacks,
    t: Translator = createTranslator('en')
): { commands: Item[]; items: Item[]; filtered: Item[] } {
    const {
        save,
        showPanel,
        moveWorkspace,
        run,
        focusEditor,
        closeWorkspace,
        create,
        showExplorer,
        openFile,
        activate
    } = callbacks;

    const commands: Item[] = [
        {
            key: '',
            title: 'Features',
            detail: 'Explore languages and built-in features · Ctrl+Shift+X',
            run: () => showPanel('features')
        },
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
                  {
                      key: '',
                      title: callbacks.isFavorite
                          ? 'Remove workspace from favorites'
                          : 'Add workspace to favorites',
                      detail: 'Keep this project within easy reach',
                      run: () => {
                          callbacks.toggleFavorite();
                          focusEditor();
                      }
                  },
                  {
                      key: 'm',
                      title: 'Problems',
                      detail: 'Errors, warnings and hints · Ctrl+Shift+M',
                      run: () => showPanel('problems')
                  },
                  {
                      key: 'g',
                      title: 'Source control',
                      detail: 'Git changes, diff and commits · Ctrl+Shift+G',
                      run: () => showPanel('git')
                  },
                  ...(state.buffers.some((buffer) => buffer.id === state.current && buffer.name) &&
                  workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal'
                      ? [
                            {
                                key: 'h',
                                title: 'Time Machine',
                                detail: 'Recover earlier edits · Ctrl+Shift+H',
                                run: () => showPanel('history')
                            }
                        ]
                      : []),
                  ...(state.filetype === 'markdown'
                      ? [
                            {
                                key: 'v',
                                title: 'Markdown preview',
                                detail: 'Preview current edits · Ctrl+Shift+V',
                                run: () => showPanel('markdown')
                            }
                        ]
                      : []),
                  ...(workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal'
                      ? [
                            {
                                key: 'D',
                                title: 'Open debug panel',
                                detail: 'Focus debugger · Space then Shift+D',
                                run: callbacks.openDebugger
                            }
                        ]
                      : []),
                  ...(
                      [
                          ['Start / continue debugging', 'F5', 'start'],
                          ['Toggle breakpoint', 'F9', 'breakpoint'],
                          ['Step over', 'F10', 'over'],
                          ['Step into', 'F11', 'into'],
                          ['Step out', 'Shift+F11', 'out'],
                          ['Pause debugging', '', 'pause'],
                          ['Stop debugging', 'Shift+F5', 'stop']
                      ] as [string, string, DebugAction][]
                  ).map(([title, detail, action]) => ({
                      key: '',
                      title,
                      detail,
                      run: () => {
                          run(window.nido.debug(active, action));
                          focusEditor();
                      }
                  })),
                  ...(['LF', 'CRLF'] as const).map((format) => ({
                      key: '',
                      title: t('Convert line endings to {format}', { format }),
                      detail: 'Normalize the current file · Save to apply to disk',
                      run: () => {
                          run(window.nido.setLineEnding(active, format));
                          focusEditor();
                      }
                  })),
                  ...(state.filetype === 'rust'
                      ? [
                            ['Run Rust at cursor', 'gR'],
                            ['Debug Rust at cursor', 'gD']
                        ].map(([title, keys]) => ({
                            key: '',
                            title,
                            detail: t('Main, test or test module · {keys}', { keys }),
                            run: () => {
                                run(window.nido.input(active, `<Esc>${keys}`));
                                focusEditor();
                            }
                        }))
                      : []),
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
                                run(window.nido.input(active, `<Esc>${keys}`));
                                focusEditor();
                            }
                        }))
                      : []),
                  {
                      key: 'f',
                      title: 'Find file',
                      detail: 'Search project filenames · Ctrl+P',
                      run: () => showPanel('files')
                  },
                  ...(workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal'
                      ? [
                            {
                                key: '',
                                title: 'Search in files',
                                detail: 'Search project text · Ctrl+Shift+F',
                                run: () => showPanel('search')
                            }
                        ]
                      : []),
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
                          save();
                          focusEditor();
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
                          focusEditor();
                          closeWorkspace(active);
                      }
                  },
                  {
                      key: 'd',
                      title: 'Close file',
                      detail: 'Prompts for unsaved changes',
                      run: () => {
                          run(window.nido.closeBuffer(active, state.current));
                          focusEditor();
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
    ].map((command) => ({
        ...command,
        title: t(command.title),
        detail: t(command.detail)
    }));

    let items: Item[];
    switch (panel) {
        case 'problems':
            items = (state.problems || [])
                .map((problem, index) => ({
                    key: t(['Error', 'Warning', 'Info', 'Hint'][problem.severity - 1] || 'Info'),
                    severity: problem.severity,
                    title: problem.message,
                    detail: `${problem.path}:${problem.line}:${problem.column}${problem.source ? ' · ' + problem.source : ''}`,
                    run: () =>
                        run(
                            window.nido
                                .openProblem(active, index + 1, state.diagnosticsVersion!)
                                .then(focusEditor)
                        )
                }))
                .sort((a, b) => a.severity - b.severity || a.detail.localeCompare(b.detail));
            break;
        case 'workspaces':
            items = [
                ...workspaces.map((w, i) => ({
                    key: String(i + 1),
                    title: w.name,
                    detail: w.root,
                    run: () => activate(w.id)
                })),
                {
                    key: '+',
                    title: t('Open workspace'),
                    detail: t('Start another independent session'),
                    run: () => void create()
                }
            ];
            break;
        case 'files':
            items = fileList.map((f) => ({
                key: '',
                title: f.name,
                detail: f.path,
                run: () => openFile(f.path)
            }));
            break;
        case 'buffers':
            items = state.buffers.map((b) => ({
                key: b.modified ? '●' : '',
                title: b.name ? filename(b.name) : t('[Untitled]'),
                detail: b.name || t('Untitled buffer'),
                run: () => {
                    run(window.nido.selectBuffer(active, b.id));
                    focusEditor();
                }
            }));
            break;
        default:
            items = commands;
    }

    const filtered = items
        .filter((item) =>
            `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, panel === 'problems' ? undefined : 100);

    return { commands, items, filtered };
}

export const filename = (path: string): string => path.split(/[\\/]/).pop() || '[Untitled]';
