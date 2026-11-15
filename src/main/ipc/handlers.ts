// Registers the IPC handlers (`nido:<name>`) that the renderer calls.
// For example, window.nido.input() in the renderer makes preload send 'nido:input',
// which handle('input') in editorHandlers.ts receives. Each area has its own file:
// appHandlers.ts, editorHandlers.ts, fileHandlers.ts, gitHandlers.ts, workspaceHandlers.ts
// and so on. Arguments are checked with validation.ts.
import { app, shell, type BrowserWindow } from 'electron';
import type { Session } from '../session/session';
import { registerAppHandlers } from './appHandlers';
import { registerEditorHandlers } from './editorHandlers';
import { registerFileHandlers } from './fileHandlers';
import { registerGitHandlers } from './gitHandlers';
import { registerWorkspaceHandlers } from './workspaceHandlers';
import { registerHistoryHandlers } from './historyHandlers';
import { registerLanguagePackHandlers } from './languagePackHandlers';
import { trustedHandle } from './handle';
import { integer, sessionFinder, shellChoice, text } from './validation';
import type { NidoEvent, Workspace } from '../../shared/types';
import type { Updates } from '../platform/updater';
import type { Language } from '../../shared/i18n';
import { LanguagePacks } from '../languagePacks/languagePacks';

/** Application-wide state, created in index.ts and shared by every handler. */
export interface AppState {
	language?: Language;
	order: string[];
	active: string;
	restoration: Promise<{ workspaces: Workspace[]; active: string; errors: string[] }> | undefined;
	prompting: boolean;
	closing: boolean;
	historyEnabled?: boolean;
}

/** Dependencies for registering handlers, also passed to each register*Handlers. */
export interface HandlerDeps {
	window: BrowserWindow;
	sessions: Map<string, Session>;
	state: AppState;
	neovimResources: string;
	send: (event: NidoEvent) => void;
}

/** Register every IPC handler. Returns the sequence that saves everything before quitting. */
export function registerHandlers(deps: HandlerDeps & { updates: Updates }): () => Promise<boolean> {
	const { window, sessions, state, neovimResources, send, updates } = deps;
	const handle = trustedHandle(window);
	const session = sessionFinder(sessions);
	const base = { window, sessions, state, neovimResources, send, handle };

	registerAppHandlers({ window, state, handle, updates });
	const languagePacks = new LanguagePacks(neovimResources, app.getPath('userData'));
	registerLanguagePackHandlers({ ...base, languagePacks });
	const captureHistory = registerHistoryHandlers({ ...base, session, text });
	const { prepareToQuit, sleepingFiles, syncFocus } = registerWorkspaceHandlers({
		...base,
		languagePacks,
		session,
		text,
		shellChoice,
		captureHistory
	});
	registerEditorHandlers({ window, state, handle, session, syncFocus });
	registerFileHandlers({
		handle,
		session,
		text,
		integer,
		sessions,
		sleepingFiles,
		send,
		trash: (file) => shell.trashItem(file)
	});
	registerGitHandlers({ handle, session, text, sessions, send });
	return prepareToQuit;
}
