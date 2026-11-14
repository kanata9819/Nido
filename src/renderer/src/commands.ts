import type { Panel, Item } from './types';
import type { FileEntry, SessionState, Workspace } from '../../shared/types';
import { createTranslator, type Translator } from '../../shared/i18n';
import { buildCommands, type CommandsCallbacks } from './commandItems';

// Builds the items that each palette lists.

/** The Problems palette: diagnostics of all open files, errors first. */
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

/** Items whose title or detail contains `query`, ignoring case. */
export function filterItems(items: Item[], query: string): Item[] {
	// Windows paths use backslashes, but a query such as src/main is typed with slashes.
	const comparable = (text: string): string => text.toLowerCase().replaceAll('\\', '/');
	const needle = comparable(query);
	return items.filter((item) => comparable(`${item.title} ${item.detail}`).includes(needle));
}

/**
 * The commands, plus the items and filtered items of the open palette. The problems items can
 * be passed in when they were already built for the current diagnostics.
 */
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
							window.nido
								.openProblem(active, index + 1, state.diagnosticsVersion!)
								.then(() => {
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

/** The file name of a path. */
export const filename = (path: string): string => path.split(/[\\/]/).pop() || '[Untitled]';
