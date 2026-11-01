import type { Panel, Item } from './types';
import type { FileEntry, SessionState, Workspace } from '../../shared/types';
import { createTranslator, type Translator } from '../../shared/i18n';
import { buildCommands, type CommandsCallbacks } from './commandItems';

export function buildProblemItems(
  problems: SessionState['problems'],
  open: (index: number) => void,
  t: Translator
): Item[] {
  return (problems || [])
    .map((problem, index) => ({
      key: t(['Error', 'Warning', 'Info', 'Hint'][problem.severity - 1] || 'Info'),
      severity: problem.severity,
      title: problem.message,
      detail: `${problem.path}:${problem.line}:${problem.column}${problem.source ? ' · ' + problem.source : ''}`,
      run: () => open(index)
    }))
    .sort((a, b) => a.severity - b.severity || a.detail.localeCompare(b.detail));
}

export function filterItems(items: Item[], query: string): Item[] {
  const needle = query.toLowerCase();
  return items.filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(needle));
}

export function buildItems(
  active: string,
  panel: Panel,
  workspaces: Workspace[],
  fileList: FileEntry[],
  state: SessionState,
  query: string,
  callbacks: CommandsCallbacks,
  t: Translator = createTranslator('en'),
  preparedProblems?: { items: Item[]; filtered: Item[] }
): { commands: Item[]; items: Item[]; filtered: Item[] } {
  const { run, focusEditor, captureFocus, create, openFile, activate } = callbacks;

  const commands = buildCommands(active, workspaces, state, callbacks, t);

  let items: Item[];
  switch (panel) {
    case 'problems':
      items =
        preparedProblems?.items ||
        buildProblemItems(
          state.problems,
          (index) => {
            const canFocus = captureFocus();
            run(
              window.nido.openProblem(active, index + 1, state.diagnosticsVersion!).then(() => {
                if (canFocus()) {
                  focusEditor();
                }
              })
            );
          },
          t
        );
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

  const filtered =
    panel === 'problems' && preparedProblems
      ? preparedProblems.filtered
      : filterItems(items, query).slice(0, panel === 'problems' ? undefined : 100);

  return { commands, items, filtered };
}

export const filename = (path: string): string => path.split(/[\\/]/).pop() || '[Untitled]';
