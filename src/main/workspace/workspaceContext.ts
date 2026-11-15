import type { BrowserWindow } from 'electron';
import type { Session } from '../session/session';
import type { AppState } from '../ipc/handlers';
import type { NidoEvent } from '../../shared/types';
import type { LanguagePackConfiguration } from '../../shared/languagePacks';
import type { LayoutCheckpoints } from './layoutCheckpoints';
import type { WorkspaceRegistry } from './workspaceRegistry';

/** What the workspace lifecycle steps (restore, create, sleep, wake, close, quit) share. */
export interface WorkspaceContext {
	window: BrowserWindow;
	state: AppState;
	registry: WorkspaceRegistry;
	layout: LayoutCheckpoints;
	send: (event: NidoEvent) => void;
	/** Start a Neovim for `root` with the current language packs, optionally under `id`. */
	startSession: (
		root: string,
		emit?: (event: NidoEvent) => void,
		id?: string
	) => Promise<Session>;
	/** The current language pack settings; they may change while a session starts. */
	loadLanguagePacks: () => Promise<LanguagePackConfiguration>;
	/** Record the session's files in the edit history. */
	captureHistory: (session: Session) => Promise<void>;
}

/** Whether the app is quitting, so no workspace should start now. */
export function windowClosing({ state, window }: WorkspaceContext): boolean {
	return state.prompting || state.closing || window.isDestroyed();
}

export function assertWindowOpen(context: WorkspaceContext): void {
	if (windowClosing(context)) {
		throw new Error('The window is closing.');
	}
}
