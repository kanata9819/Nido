import type { Panel, Item } from './types';
import type { DebugAction, Indentation, SessionState, Workspace } from '../../shared/types';
import type { Translator } from '../../shared/i18n';

export interface CommandsCallbacks {
	save: () => void;
	showPanel: (value: Panel) => void;
	moveWorkspace: (offset: number) => void;
	run: (promise: Promise<unknown>) => void;
	focusEditor: () => void;
	captureFocus: () => () => boolean;
	closeWorkspace: (id: string) => void;
	create: () => Promise<void>;
	createTerminal: () => Promise<void>;
	showExplorer: () => void;
	openDebugger: () => void;
	openFile: (path: string) => void;
	activate: (id: string) => void;
	toggleFavorite: () => void;
	isFavorite: boolean;
}

/** Status bar label for an indentation, e.g. "Spaces: 4". */
export function indentationLabel(indentation: Indentation, t: Translator): string {
	return t(indentation.spaces ? 'Spaces: {size}' : 'Tab size: {size}', {
		size: indentation.size
	});
}

function indentationCommands(
	active: string,
	indentation: Indentation,
	run: (promise: Promise<unknown>) => void,
	focusEditor: () => void,
	t: Translator
): Item[] {
	// Every detail starts with "Indentation" so the status bar can filter to these commands.
	const detail = t('Indentation · Current: {current}', {
		current: indentationLabel(indentation, t)
	});
	const apply = (next: Indentation, rewrite = false): void => {
		run(window.nido.setIndentation(active, next, rewrite));
		focusEditor();
	};
	return [
		{
			key: '',
			title: 'Indent using spaces',
			detail,
			run: () => apply({ ...indentation, spaces: true })
		},
		{
			key: '',
			title: 'Indent using tabs',
			detail,
			run: () => apply({ ...indentation, spaces: false })
		},
		...[2, 4, 8].map((size) => ({
			key: '',
			title: t('Indent width {size}', { size }),
			detail,
			run: () => apply({ ...indentation, size })
		})),
		{
			key: '',
			title: 'Convert indentation to spaces',
			detail: t('Indentation · Rewrite leading whitespace in this file'),
			run: () => apply({ ...indentation, spaces: true }, true)
		},
		{
			key: '',
			title: 'Convert indentation to tabs',
			detail: t('Indentation · Rewrite leading whitespace in this file'),
			run: () => apply({ ...indentation, spaces: false }, true)
		}
	];
}

export function buildCommands(
	active: string,
	workspaces: Workspace[],
	state: SessionState,
	callbacks: CommandsCallbacks,
	t: Translator
): Item[] {
	const {
		save,
		showPanel,
		moveWorkspace,
		run,
		focusEditor,
		closeWorkspace,
		create,
		showExplorer
	} = callbacks;
	return [
		{
			key: '',
			title: 'Connect to WSL',
			detail: 'Choose a Linux distribution and open a folder',
			run: () => void create()
		},
		{
			key: '',
			title: 'Extensions',
			detail: 'Manage language packs and other extensions · Ctrl+Shift+X',
			run: () => showPanel('extensions')
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
		{
			key: '',
			title: 'New terminal session',
			detail: 'Start a terminal-only session',
			run: () => void callbacks.createTerminal()
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
					...(state.buffers.some(
						(buffer) => buffer.id === state.current && buffer.name
					) &&
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
								...[
									['Toggle line comments', 'Ctrl+/', '<C-/>'],
									['Undo', 'Ctrl+Z', '<C-z>'],
									['Redo', 'Ctrl+Shift+Z', '<C-S-z>']
								].map(([title, detail, keys]) => ({
									key: '',
									title,
									detail,
									run: () => {
										run(window.nido.input(active, keys));
										focusEditor();
									}
								})),
								{
									key: '',
									title: 'Reopen closed file',
									detail: 'Restore the last closed file and cursor · Ctrl+Shift+T',
									run: () => {
										run(window.nido.reopenBuffer(active));
										focusEditor();
									}
								},
								...([-1, 1] as const).flatMap((offset) => {
									const index = state.buffers.findIndex(
										(buffer) => buffer.id === state.current
									);
									const target = state.buffers[index + offset];
									return index >= 0 && target
										? [
												{
													key: '',
													title:
														offset < 0
															? 'Move file tab left'
															: 'Move file tab right',
													detail:
														offset < 0
															? 'Reorder file tabs · Ctrl+Shift+PageUp'
															: 'Reorder file tabs · Ctrl+Shift+PageDown',
													run: () => {
														run(
															window.nido.moveBuffer(
																active,
																state.current,
																target.id
															)
														);
														focusEditor();
													}
												}
											]
										: [];
								}),
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
					...(state.indentation &&
					workspaces.find((workspace) => workspace.id === active)?.kind !== 'terminal'
						? indentationCommands(active, state.indentation, run, focusEditor, t)
						: []),
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
									key: 'o',
									title: 'Go to symbol in file',
									detail: 'Find functions, classes and methods · Ctrl+Shift+O',
									run: () => showPanel('symbols')
								},
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
			key: '-',
			title: 'Minimize window',
			detail: 'Hide the window in the taskbar',
			run: () => {
				focusEditor();
				run(window.nido.windowAction('minimize'));
			}
		},
		{
			key: '+',
			title: 'Maximize or restore window',
			detail: 'Toggle between maximized and normal size',
			run: () => {
				focusEditor();
				run(window.nido.windowAction('maximize'));
			}
		},
		{
			key: 'q',
			title: 'Quit Nido',
			detail: 'Prompts for unsaved changes',
			run: () => {
				focusEditor();
				run(window.nido.windowAction('close'));
			}
		}
	].map((command) => ({
		...command,
		title: t(command.title),
		detail: t(command.detail)
	}));
}
