import { app } from 'electron';
import { isAbsolute } from 'node:path';
import type { TerminalShell, Workspace } from '../../shared/types';
import { assertWindowOpen, type WorkspaceContext } from './workspaceContext';

/** Open a new workspace tab: an editor on `path`, or a shell (in the home folder by default). */
export async function createWorkspace(
	context: WorkspaceContext,
	root: string,
	kind: 'editor' | 'terminal',
	shell: TerminalShell
): Promise<Workspace> {
	if (!isAbsolute(root)) {
		throw new Error('Enter an absolute folder path.');
	}
	const { registry, layout } = context;
	const s = await context.startSession(root);
	try {
		if (kind === 'terminal') {
			await s.startTerminal(shell);
		}
		assertWindowOpen(context);
	} catch (error) {
		await s.stop();
		throw error;
	}
	registry.sessions.set(s.workspace.id, s);
	try {
		await s.reloadLanguagePacks(await context.loadLanguagePacks());
	} catch (error) {
		registry.sessions.delete(s.workspace.id);
		await s.stop();
		throw error;
	}
	layout.start();
	return s.workspace;
}

/** The folder a new workspace opens: a shell given no path starts in the home folder. */
export function workspaceRoot(
	kind: 'editor' | 'terminal',
	path: unknown,
	text: (value: unknown) => string
): string {
	return kind === 'terminal' && path === '' ? app.getPath('home') : text(path);
}
