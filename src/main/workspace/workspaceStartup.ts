import type { Session } from '../session/session';
import { readLayout, type SavedLayout } from './persistence';
import type { WorkspaceContext } from './workspaceContext';
import { sleepingWorkspace } from './workspaceRegistry';
import type { NidoEvent, SavedWorkspace, TerminalShell, Workspace } from '../../shared/types';

/** The workspaces the renderer shows after a restoration, and what failed to restore. */
export interface Restoration {
	workspaces: Workspace[];
	active: string;
	errors: string[];
}

/** A Neovim started for a saved workspace; `claim` releases the events it held meanwhile. */
interface PrestartedSession {
	created: Promise<Session>;
	claim: () => void;
}

/** The saved layout read at startup, with the Neovim processes started for it early. */
interface PrestartedLayout {
	saved: SavedLayout;
	starts: (PrestartedSession | undefined)[];
}

/**
 * Whether a saved workspace can start asleep: anything but the selected tab, unless it
 * runs a shell or carries unsaved untitled text that only a running Neovim holds.
 */
export function startsAsleep(saved: SavedWorkspace, index: number, active: number): boolean {
	return (
		index !== active && saved.kind !== 'terminal' && !saved.terminal && !saved.untitled?.length
	);
}

/** Hold events until release, then deliver them in order and pass later ones through. */
export function bufferedEmitter(send: (event: NidoEvent) => void): {
	emit: (event: NidoEvent) => void;
	release: () => void;
} {
	let held: NidoEvent[] | undefined = [];
	return {
		emit: (event) => (held ? held.push(event) : send(event)),
		release: () => {
			const events = held ?? [];
			held = undefined;
			events.forEach(send);
		}
	};
}

/**
 * Restores the saved workspaces at startup. Their Neovim processes start while the renderer
 * is still loading; their events wait until the renderer asks for the restoration.
 */
export class WorkspaceStartup {
	private prestart: Promise<PrestartedLayout> | undefined;

	constructor(
		private readonly context: WorkspaceContext,
		private readonly layoutPath: string
	) {
		this.prestart = this.startEarly();
		this.prestart.catch(() => {});
		context.window.once('closed', () => this.stopUnclaimed());
	}

	/**
	 * Restore once, sharing the work with later calls. A renderer can reconnect after tabs
	 * were created, closed or put to sleep, so each response describes the current tabs.
	 */
	async restore(shell: TerminalShell): Promise<Restoration> {
		const { state, registry } = this.context;
		state.restoration ??= this.restoreSaved(shell);
		const restored = await state.restoration;
		const ids = registry.orderedIds();
		return {
			workspaces: ids.map((id) => registry.describe(id)),
			active: ids.includes(state.active) ? state.active : ids[0] || '',
			errors: restored.errors
		};
	}

	private async startEarly(): Promise<PrestartedLayout> {
		const { context } = this;
		const saved = await readLayout(this.layoutPath);
		return {
			saved,
			starts: saved.workspaces.map((workspace, index) => {
				if (startsAsleep(workspace, index, saved.active)) {
					return undefined;
				}
				const events = bufferedEmitter(context.registry.sessionSend);
				const created = context.startSession(workspace.root, events.emit);
				// Restoration reports the failure; avoid an unhandled rejection before it claims this.
				created.catch(() => {});
				return { created, claim: events.release };
			})
		};
	}

	/** Stop processes the renderer never claimed, such as when it failed to load. */
	private stopUnclaimed(): void {
		const unclaimed = this.prestart;
		this.prestart = undefined;
		void unclaimed?.then(({ starts }) =>
			starts.forEach(
				(start) =>
					void start?.created.then(
						(s) => s.stop(),
						() => {}
					)
			)
		);
	}

	/** Take over the early start, or read the layout now if there was none. */
	private async takePrestart(): Promise<PrestartedLayout> {
		const early = this.prestart;
		this.prestart = undefined;
		return early ? await early : { saved: await readLayout(this.layoutPath), starts: [] };
	}

	private async restoreSaved(shell: TerminalShell): Promise<Restoration> {
		const { state, registry, layout } = this.context;
		const errors: string[] = [];
		try {
			const { saved, starts } = await this.takePrestart();
			registry.sleeping.clear();
			// Independent sessions can start together; insert results in saved tab order.
			const restored = await Promise.all(
				saved.workspaces.map((workspace, index) =>
					this.restoreOne(workspace, index, saved.active, starts[index], shell, errors)
				)
			);
			// A preference may change while independent sessions are starting.
			// Register first so subsequent updates also include these sessions.
			if (restored.some((id) => id && registry.sessions.has(id))) {
				const packs = await this.context.loadLanguagePacks();
				await Promise.all(
					restored.map((id) =>
						id ? registry.sessions.get(id)?.reloadLanguagePacks(packs) : undefined
					)
				);
			}
			state.order = restored.filter((id): id is string => !!id);
			layout.start();
		} catch (error) {
			errors.push(`Workspace restore failed: ${String(error)}`);
		}
		state.order = registry.orderedIds();
		// When the selected workspace could not start, select one that did.
		state.active ||=
			state.order.find((id) => registry.sessions.has(id)) || state.order[0] || '';
		return {
			workspaces: state.order.map((id) => registry.describe(id)),
			active: state.active,
			errors
		};
	}

	/** Restore one saved workspace; resolves its ID, or undefined when it failed. */
	private async restoreOne(
		workspace: SavedWorkspace,
		index: number,
		active: number,
		start: PrestartedSession | undefined,
		shell: TerminalShell,
		errors: string[]
	): Promise<string | undefined> {
		const { state, registry } = this.context;
		if (startsAsleep(workspace, index, active)) {
			const asleep = sleepingWorkspace(workspace);
			registry.sleeping.set(asleep.id, { workspace: asleep, saved: workspace });
			return asleep.id;
		}
		let s: Session | undefined;
		try {
			if (start) {
				start.claim();
				s = await start.created;
			} else {
				s = await this.context.startSession(workspace.root);
			}
			errors.push(...(await s.restore(workspace, shell)));
			if (index === active) {
				state.active = s.workspace.id;
			}
			registry.sessions.set(s.workspace.id, s);
			return s.workspace.id;
		} catch (error) {
			await s?.stop();
			errors.push(`${workspace.root}: ${String(error)}`);
			if (workspace.kind === 'terminal') {
				return undefined;
			}
			// Keep the tab asleep with its saved state, unsaved drafts included: a folder or WSL
			// distribution that is unavailable now may start later, and selecting the tab tries
			// again. Dropping it would remove it from the next saved layout and lose the drafts.
			const asleep = sleepingWorkspace(workspace);
			registry.sleeping.set(asleep.id, { workspace: asleep, saved: workspace });
			return asleep.id;
		}
	}
}
