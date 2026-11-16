// IPC handlers for opening, closing, restoring, sleeping and waking workspaces. The steps
// themselves live in ../workspace/; this file checks the renderer's arguments and wires them.
import { app } from 'electron';
import { join } from 'node:path';
import { Session } from '../session/session';
import { registerFavoriteHandlers } from './favoriteHandlers';
import { registerFolderBrowserHandlers } from './folderBrowserHandlers';
import type { TerminalShell } from '../../shared/types';
import type { HandlerDeps } from './handlers';
import type { LanguagePacks } from '../languagePacks/languagePacks';
import { LayoutCheckpoints } from '../workspace/layoutCheckpoints';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import type { WorkspaceContext } from '../workspace/workspaceContext';
import { WorkspaceStartup } from '../workspace/workspaceStartup';
import { sleepWorkspace, wakeWorkspace } from '../workspace/workspaceSleep';
import { closeWorkspace, prepareToQuit, quitOnWindowClose } from '../workspace/workspaceClosing';
import { createWorkspace, workspaceRoot } from '../workspace/workspaceCreation';

export function registerWorkspaceHandlers({
	window,
	sessions,
	state,
	neovimResources,
	languagePacks,
	send,
	handle,
	session,
	text,
	shellChoice,
	captureHistory
}: HandlerDeps & {
	languagePacks: Pick<LanguagePacks, 'load'>;
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	session: (id: unknown) => Session;
	text: (value: unknown) => string;
	shellChoice: (value?: unknown) => TerminalShell;
	captureHistory: (session: Session) => Promise<void>;
}): {
	prepareToQuit: () => Promise<boolean>;
	/** Files that sleeping workspaces had open, which they reopen when they wake. */
	sleepingFiles: () => string[];
	/** Tell each Neovim whether it is the selected workspace in a focused window. */
	syncFocus: () => void;
} {
	const layoutPath = join(app.getPath('userData'), 'workspaces.json');
	const registry = new WorkspaceRegistry(sessions, state, send, session);
	const context: WorkspaceContext = {
		window,
		state,
		registry,
		layout: new LayoutCheckpoints(window, state, registry, layoutPath, send),
		send,
		startSession: async (root, emit = registry.sessionSend, id) =>
			Session.create(root, emit, neovimResources, await languagePacks.load(), id),
		loadLanguagePacks: () => languagePacks.load(),
		captureHistory
	};
	const quit = (): Promise<boolean> => prepareToQuit(context);
	quitOnWindowClose(context, quit);
	const startup = new WorkspaceStartup(context, layoutPath);

	registerFavoriteHandlers({ handle, text });
	registerFolderBrowserHandlers({ handle, text });

	handle('restore', async (shell) => startup.restore(shellChoice(shell)));

	handle('layout', (ids, selected) => {
		if (
			!Array.isArray(ids) ||
			!ids.every((id) => typeof id === 'string' && registry.known(id)) ||
			new Set(ids).size !== ids.length ||
			typeof selected !== 'string' ||
			(selected !== '' && !ids.includes(selected))
		) {
			throw new Error('Invalid workspace layout.');
		}
		state.order = ids;
		state.active = selected;
		syncFocus();
	});

	handle('create', async (path, kind = 'editor', shell) => {
		const selectedShell = shellChoice(shell);
		if (kind !== 'editor' && kind !== 'terminal') {
			throw new Error('Invalid session type.');
		}
		return createWorkspace(context, workspaceRoot(kind, path, text), kind, selectedShell);
	});

	handle('sleep', (id, resolve) => {
		const key = text(id);
		return registry.exclusive(key, () => sleepWorkspace(context, key, resolve === true));
	});

	handle('wake', (id) => {
		const key = text(id);
		return registry.exclusive(key, () => wakeWorkspace(context, key, () => session(key)));
	});

	handle('close', (id) => {
		const key = text(id);
		return registry.exclusive(key, () => closeWorkspace(context, key, () => session(key)));
	});

	function syncFocus(): void {
		const focused = !window.isDestroyed() && window.isFocused();
		for (const [id, s] of sessions) {
			s.setFocus(focused && id === state.active);
		}
	}
	window.on('focus', syncFocus);
	window.on('blur', syncFocus);

	return { prepareToQuit: quit, syncFocus, sleepingFiles: () => registry.sleepingFiles() };
}
