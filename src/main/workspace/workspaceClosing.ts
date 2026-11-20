import { dialog } from 'electron';
import type { Session } from '../session/session';
import { createTranslator } from '../../shared/i18n';
import type { WorkspaceContext } from './workspaceContext';

/** Ask whether to save a workspace's unsaved files. Resolves false when the user cancels. */
async function confirmClose({ window, state }: WorkspaceContext, s: Session): Promise<boolean> {
	if (!(await s.modified())) {
		return true;
	}
	const t = createTranslator(state.language ?? 'en');
	const { response } = await dialog.showMessageBox(window, {
		type: 'warning',
		title: t('Unsaved changes'),
		message: t('Save changes in {name}?', { name: s.workspace.name }),
		detail: t(
			'Save all files before closing this workspace. Untitled buffers need a filename (:w path).'
		),
		buttons: [t('Save all'), t('Cancel'), t('Discard changes')],
		defaultId: 0,
		cancelId: 1,
		noLink: true
	});
	if (response === 1) {
		return false;
	}
	if (response === 0) {
		await s.saveAll();
	}
	return true;
}

/**
 * Ask before closing a sleeping workspace that still holds untitled drafts, such as one that
 * could not start at launch: its drafts exist only in its saved state. Resolves false when the
 * user keeps it.
 */
async function confirmDiscardDrafts(
	{ window, state, registry }: WorkspaceContext,
	id: string
): Promise<boolean> {
	const asleep = registry.sleeping.get(id);
	if (!asleep?.saved.untitled?.length) {
		return true;
	}
	const t = createTranslator(state.language ?? 'en');
	const { response } = await dialog.showMessageBox(window, {
		type: 'warning',
		title: t('Unsaved changes'),
		message: t('Discard unsaved drafts in {name}?', { name: asleep.workspace.name }),
		detail: t('Open this workspace again to save its untitled buffers.'),
		buttons: [t('Cancel'), t('Discard')],
		defaultId: 0,
		cancelId: 0,
		noLink: true
	});
	return response === 1;
}

/**
 * Close a workspace's tab, asking first about unsaved files. Resolves false when the user
 * keeps it. Run it through registry.exclusive: whether the workspace is asleep is only known
 * once an earlier sleep or wake finishes.
 */
export async function closeWorkspace(
	context: WorkspaceContext,
	id: string,
	running: () => Session
): Promise<boolean> {
	const { registry, send, layout } = context;
	if (registry.sleeping.has(id) && !(await confirmDiscardDrafts(context, id))) {
		return false;
	}
	if (registry.forgetSleeping(id)) {
		send({ type: 'exit', id });
		await layout.saveReplacingBackup();
		return true;
	}
	const s = running();
	if (!(await confirmClose(context, s))) {
		return false;
	}
	await context.captureHistory(s);
	await s.stop();
	// Neovim's exit already removed the session and told the renderer. Report it here
	// only for a process that never ran, so the renderer hears of the close once.
	if (registry.sessions.delete(s.workspace.id)) {
		send({ type: 'exit', id: s.workspace.id });
	}
	// Do not revive explicitly closed or discarded drafts from a stale checkpoint.
	await layout.saveReplacingBackup();
	return true;
}

/**
 * Save everything and stop every Neovim before the app quits. Ordinary close and update
 * restart share this sequence. Resolves false when the user cancels.
 */
export async function prepareToQuit(context: WorkspaceContext): Promise<boolean> {
	const { state, registry, layout } = context;
	if (state.closing) {
		return true;
	}
	if (state.prompting) {
		return false;
	}
	state.prompting = true;
	try {
		if (state.restoration) {
			await state.restoration;
		}
		const sessions = registry.sessions;
		for (const s of sessions.values()) {
			if (!(await confirmClose(context, s))) {
				return false;
			}
		}
		await Promise.all([...sessions.values()].map(context.captureHistory));
		// A background write must finish before the final shutdown snapshot replaces it.
		await layout.saveFinal();
		await Promise.all([...sessions.values()].map((s) => s.stop()));
		state.closing = true;
		return true;
	} finally {
		state.prompting = false;
	}
}

/** Run the quit sequence when the window is closed, closing it once it is done. */
export function quitOnWindowClose(context: WorkspaceContext, quit: () => Promise<boolean>): void {
	const { window, state } = context;
	window.on('close', (event) => {
		if (state.closing) {
			return;
		}
		event.preventDefault();
		void quit()
			.then((ready) => {
				if (ready) {
					window.close();
				}
			})
			.catch((error: unknown) =>
				dialog.showMessageBox(window, { type: 'error', message: String(error) })
			);
	});
}
