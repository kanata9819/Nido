import type { Panel, Item } from './types';
import type { FileEntry, SessionState, Workspace } from '../../shared/types';

interface CommandsCallbacks {
  showPanel: (value: Panel) => void;
  moveWorkspace: (offset: number) => void;
  run: (promise: Promise<unknown>) => void;
  focusEditor: () => void;
  closeWorkspace: (id: string) => void;
  create: () => Promise<void>;
  showExplorer: () => void;
  openFile: (path: string) => void;
  activate: (id: string) => void;
}

export function buildItems(
  active: string,
  panel: Panel,
  workspaces: Workspace[],
  fileList: FileEntry[],
  state: SessionState,
  query: string,
  callbacks: CommandsCallbacks
): { commands: Item[]; items: Item[]; filtered: Item[] } {
  const { showPanel, moveWorkspace, run, focusEditor, closeWorkspace, create, showExplorer, openFile, activate } =
    callbacks;

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
              run(window.nido.save(active));
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
  ];

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
                run(window.nido.selectBuffer(active, b.id));
                focusEditor();
              }
            }))
          : commands;

  const filtered = items
    .filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 100);

  return { commands, items, filtered };
}

export const filename = (path: string): string => path.split(/[\\/]/).pop() || '[Untitled]';
