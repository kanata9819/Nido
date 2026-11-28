import { clipboard, dialog, type BrowserWindow } from 'electron';
import type { Session } from '../session/session';
import { translate } from '../../shared/i18n';
import type { AppState } from './handlers';
import type { Handle } from './handle';
import {
	boolean,
	debugAction,
	indentation,
	integer,
	scrollDistance,
	shellChoice,
	text
} from './validation';

interface EditorHandlerDeps {
	window: BrowserWindow;
	state: AppState;
	handle: Handle;
	session: (id: unknown) => Session;
	/** Tell each Neovim whether it is the selected workspace in a focused window. */
	syncFocus: () => void;
}

/** IPC handlers for one workspace's editor: its grid, input, settings, tabs and navigation. */
export function registerEditorHandlers(deps: EditorHandlerDeps): void {
	registerGridHandlers(deps);
	registerInputHandlers(deps);
	registerSettingHandlers(deps);
	registerBufferHandlers(deps);
	registerNavigationHandlers(deps);
	registerToolHandlers(deps);
}

/** The editor's size, scrolling and terminals. */
function registerGridHandlers({ handle, session, syncFocus }: EditorHandlerDeps): void {
	handle('attach', async (id, columns, rows) => {
		await session(id).attach(integer(columns, 1000), integer(rows, 500));
		// A workspace that started or woke since the last focus change learns it now.
		syncFocus();
	});
	handle('resize', (id, columns, rows) =>
		session(id).resize(integer(columns, 1000), integer(rows, 500))
	);
	handle('prefetchScroll', (id, down, scrolling) =>
		session(id).prefetchScroll(down === true, scrolling === true)
	);
	handle('scroll', (id, lines, follow, pixel, columns = 0) => {
		scrollDistance(lines, pixel === true, columns);
		return session(id).scroll(
			lines as number,
			follow !== false,
			pixel === true,
			columns as number
		);
	});
	handle('jumpSticky', (id, window, buffer, line) =>
		session(id).jumpSticky(integer(window), integer(buffer), integer(line))
	);
	handle(
		'openTerminal',
		async (id, shell) => (await session(id).openTerminal(shellChoice(shell))).workspace
	);
	handle('restartTerminal', (id, shell) => {
		const s = session(id);
		if (s.workspace.kind !== 'terminal') {
			throw new Error('Not a terminal session.');
		}
		return s.startTerminal(shellChoice(shell));
	});
	handle('addTerminalShell', (id, shell) => session(id).addTerminalShell(shellChoice(shell)));
	handle('selectTerminalShell', (id, position) =>
		session(id).selectTerminalShell(integer(position, 100))
	);
	handle('closeTerminalShell', (id, position) =>
		session(id).closeTerminalShell(integer(position, 100))
	);
	handle('terminalCopyMode', (id) => session(id).enterCopyMode());
}

/** Keys, clicks, pastes and completion choices. */
function registerInputHandlers({ handle, session }: EditorHandlerDeps): void {
	handle('input', (id, keys, sticky) => {
		if (sticky === undefined) {
			return session(id).input(text(keys));
		}
		if (sticky === null || typeof sticky !== 'object') {
			throw new Error('Invalid Sticky Scroll coverage.');
		}
		const { window, buffer, rows } = sticky as Record<string, unknown>;
		return session(id).input(text(keys), {
			window: integer(window),
			buffer: integer(buffer),
			rows: integer(rows, 500)
		});
	});
	handle('inputMode', (id) => session(id).inputMode());
	handle('selectCompletion', (id, index) => {
		if (typeof index !== 'number') {
			throw new Error('Invalid completion index.');
		}
		return session(id).selectCompletion(integer(index + 1) - 1);
	});
	handle('click', (id, row, column) => {
		if (typeof row !== 'number' || typeof column !== 'number') {
			throw new Error('Invalid mouse position.');
		}
		return session(id).click(integer(row + 1, 500) - 1, integer(column + 1, 1000) - 1);
	});
	handle('paste', (id, value) => session(id).paste(text(value)));
	handle('pasteClipboard', (id) => session(id).paste(() => clipboard.readText()));
}

/** Per-workspace editor settings and the current file's format. */
function registerSettingHandlers({ handle, session }: EditorHandlerDeps): void {
	const toggles = {
		clipboardSharing: ['Invalid clipboard setting.', (s, on) => s.setClipboardSharing(on)],
		relativeLineNumbers: [
			'Invalid line number setting.',
			(s, on) => s.setRelativeLineNumbers(on)
		],
		editorConfig: ['Invalid EditorConfig setting.', (s, on) => s.setEditorConfig(on)],
		wordWrap: ['Invalid word wrap setting.', (s, on) => s.setWordWrap(on)],
		methodSeparators: [
			'Invalid method separator setting.',
			(s, on) => s.setMethodSeparators(on)
		]
	} satisfies Record<string, [string, (s: Session, enabled: boolean) => unknown]>;
	for (const [name, [message, apply]] of Object.entries(toggles)) {
		handle(name, (id, enabled) => apply(session(id), boolean(enabled, message)));
	}
	handle('setLineEnding', (id, format) => {
		if (format !== 'LF' && format !== 'CRLF') {
			throw new Error('Invalid line ending');
		}
		return session(id).setLineEnding(format);
	});
	handle('setIndentation', (id, value, rewrite) =>
		session(id).setIndentation(indentation(value), rewrite === true)
	);
}

/** File tabs: switching, reordering, reopening, closing and saving. */
function registerBufferHandlers({ window, state, handle, session }: EditorHandlerDeps): void {
	handle('selectBuffer', (id, buffer) => session(id).selectBuffer(integer(buffer)));
	handle('selectAdjacentBuffer', (id, offset) => {
		if (offset !== -1 && offset !== 1) {
			throw new Error('Invalid tab direction.');
		}
		return session(id).selectAdjacentBuffer(offset);
	});
	handle('moveBuffer', (id, buffer, target) =>
		session(id).moveBuffer(integer(buffer), integer(target))
	);
	handle('reopenBuffer', (id) => session(id).reopenBuffer());
	// Close a tab, asking first whether to discard its unsaved changes. Resolves false when the
	// user keeps the tab.
	handle('closeBuffer', async (id, value) => {
		const s = session(id);
		const buffer = integer(value);
		const modified = await s.bufferModified(buffer);
		if (modified && !(await confirmDiscard(window, state))) {
			return false;
		}
		await s.closeBuffer(buffer, modified);
		return true;
	});
	handle('save', (id, format) => session(id).save(format === true));
}

/** Ask whether to discard a file's unsaved changes. */
async function confirmDiscard(window: BrowserWindow, state: AppState): Promise<boolean> {
	const t = (message: string): string => translate(state.language ?? 'en', message);
	const { response } = await dialog.showMessageBox(window, {
		type: 'warning',
		message: t('Discard this file’s unsaved changes?'),
		buttons: [t('Cancel'), t('Discard')],
		defaultId: 0,
		cancelId: 0,
		noLink: true
	});
	return response === 1;
}

/** Symbols, references and problems, by their index in the list the renderer shows. */
function registerNavigationHandlers({ handle, session }: EditorHandlerDeps): void {
	handle('findSymbols', (id) => session(id).findSymbols());
	handle('openSymbol', (id, index, version) =>
		session(id).openSymbol(integer(index), integer(version))
	);
	handle('openReference', (id, index, version) =>
		session(id).openReference(integer(index), integer(version))
	);
	handle('openProblem', (id, index, version) =>
		session(id).openProblem(integer(index), integer(version))
	);
	handle('previewReference', (id, index, version) =>
		session(id).previewReference(integer(index), integer(version))
	);
}

/** Markdown preview, syntax-colored previews and Run and Debug. */
function registerToolHandlers({ handle, session }: EditorHandlerDeps): void {
	handle('markdownPreview', (id, token) =>
		session(id).markdownPreview(token === undefined ? '' : text(token))
	);
	handle('highlightSources', (id, path, before, after) =>
		session(id).highlightSources(text(path), text(before), text(after))
	);
	handle('debug', (id, value, target) => {
		const action = debugAction(value);
		return session(id).debug(
			action,
			action === 'launch' || action === 'variable' ? integer(target) : undefined
		);
	});
}
