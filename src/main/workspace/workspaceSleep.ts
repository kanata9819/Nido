import type { Session } from '../session/session';
import { resolvableSleepBlockers, type SleepBlocker, type Workspace } from '../../shared/types';
import { assertWindowOpen, type WorkspaceContext } from './workspaceContext';
import { bufferedEmitter } from './workspaceStartup';

/** Blockers that sleeping on request can clear: a terminal is closed, files are saved. */
export function resolvableBlocker(blocker: SleepBlocker): boolean {
	return resolvableSleepBlockers.includes(blocker);
}

/** Whether `id` must keep running regardless of its own state: it is selected, or the app quits. */
function mustStayAwake({ state }: WorkspaceContext, id: string): boolean {
	return id === state.active || state.prompting || state.closing;
}

/** Close the terminal and save files when those are all that keep `s` awake. */
async function clearBlockers(s: Session, blockers: SleepBlocker[]): Promise<SleepBlocker[]> {
	if (!blockers.length || !blockers.every(resolvableBlocker)) {
		return blockers;
	}
	if (blockers.includes('terminal')) {
		await s.closeTerminal();
	}
	if (blockers.includes('modified')) {
		await s.saveAll();
	}
	return s.sleepBlockers();
}

/**
 * Stop a background workspace's Neovim, keeping its tab and a snapshot to wake from.
 * Resolves true when it slept, or what keeps it running. With `resolve` (the user agreed),
 * a running terminal is closed and unsaved files are saved first.
 */
export async function sleepWorkspace(
	context: WorkspaceContext,
	id: string,
	resolve: boolean
): Promise<boolean | SleepBlocker[]> {
	const { registry } = context;
	const s = registry.sessions.get(id);
	if (!s || mustStayAwake(context, id)) {
		return false;
	}
	let blockers = await s.sleepBlockers();
	if (resolve) {
		blockers = await clearBlockers(s, blockers);
	}
	if (blockers.length) {
		return blockers;
	}
	const saved = await s.snapshot({ includeUntitled: true });
	await context.captureHistory(s);
	// Snapshot and history capture yield to editor activity. A new edit, prompt,
	// debugger or shell must keep the workspace running instead of being discarded.
	const lateBlockers = await s.sleepBlockers();
	if (lateBlockers.length) {
		return lateBlockers;
	}
	// Check again after the last await: the workspace may have been selected meanwhile.
	if (mustStayAwake(context, id) || registry.sessions.get(id) !== s) {
		return false;
	}
	registry.putToSleep(id, s, saved);
	await s.stop();
	return true;
}

/** Start a sleeping workspace's Neovim again under the same ID and restore its snapshot. */
export async function wakeWorkspace(
	context: WorkspaceContext,
	id: string,
	running: () => Session
): Promise<{ workspace: Workspace; errors: string[] }> {
	const { registry } = context;
	const asleep = registry.sleeping.get(id);
	if (!asleep) {
		return { workspace: running().workspace, errors: [] };
	}
	assertWindowOpen(context);
	// Hold startup events until the workspace is registered; a failed start stays quiet.
	const events = bufferedEmitter(registry.sessionSend);
	const s = await context.startSession(asleep.workspace.root, events.emit, id);
	let errors: string[];
	try {
		errors = await s.restore(asleep.saved);
		assertWindowOpen(context);
		// Preferences can change while restore runs. Register before loading them
		// again so subsequent pack updates also reach this session.
		registry.sessions.set(id, s);
		await s.reloadLanguagePacks(await context.loadLanguagePacks());
		assertWindowOpen(context);
	} catch (error) {
		if (registry.sessions.get(id) === s) {
			registry.sessions.delete(id);
		}
		await s.stop();
		throw error;
	}
	registry.awaken(id);
	events.release();
	return { workspace: s.workspace, errors };
}
