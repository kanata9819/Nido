import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../session/session';
import type { AppState } from '../ipc/handlers';
import type { NidoEvent, SavedWorkspace, Workspace } from '../../shared/types';
import { parseWslPath } from '../../shared/wsl';

/** A workspace that keeps its tab and a snapshot, but no Neovim process. */
export interface SleepingWorkspace {
	workspace: Workspace;
	saved: SavedWorkspace;
}

/** The tab a saved workspace gets when it is restored asleep, under a fresh ID. */
export function sleepingWorkspace(saved: SavedWorkspace): Workspace {
	const remote = parseWslPath(saved.root);
	return {
		id: randomUUID(),
		root: saved.root,
		name: basename(saved.root) || saved.root,
		...(remote ? { wsl: remote.distribution } : {})
	};
}

/**
 * Every open workspace, running or asleep, in tab order. It also serializes the sleep, wake
 * and close of one workspace, and silences the events of a Neovim that exits to sleep.
 */
export class WorkspaceRegistry {
	readonly sleeping = new Map<string, SleepingWorkspace>();
	// A sleeping workspace's Neovim exits quietly; the renderer keeps its tab.
	private readonly muted = new Set<string>();
	// Sleep and wake of one workspace run one after another.
	private readonly transitions = new Map<string, Promise<unknown>>();

	constructor(
		readonly sessions: Map<string, Session>,
		private readonly state: AppState,
		private readonly send: (event: NidoEvent) => void,
		private readonly session: (id: unknown) => Session
	) {}

	/** Send a session event, unless it belongs to a workspace that is going to sleep. */
	readonly sessionSend = (event: NidoEvent): void => {
		const target = 'id' in event ? event.id : undefined;
		if (!target || !this.muted.has(target)) {
			this.send(event);
		}
	};

	/** Run `task` after any earlier sleep, wake or close of the same workspace. */
	exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
		const next = (this.transitions.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
		this.transitions.set(id, next);
		void next
			.finally(() => {
				if (this.transitions.get(id) === next) {
					this.transitions.delete(id);
				}
			})
			.catch(() => {});
		return next;
	}

	known(id: string): boolean {
		return this.sessions.has(id) || this.sleeping.has(id);
	}

	/** Workspace IDs in the renderer's tab order, then any it has not placed yet. */
	orderedIds(): string[] {
		const { order } = this.state;
		return [
			...order.filter((id) => this.known(id)),
			...[...this.sessions.keys(), ...this.sleeping.keys()].filter(
				(id) => !order.includes(id)
			)
		];
	}

	/** The workspace as the renderer shows it; a sleeping one is marked so. */
	describe(id: string): Workspace {
		return this.sessions.has(id)
			? this.session(id).workspace
			: { ...this.sleeping.get(id)!.workspace, sleeping: true };
	}

	/** What a workspace restores from: a running one is asked, a sleeping one has it already. */
	snapshotOf(
		id: string,
		options: { restoreScroll?: boolean; includeUntitled?: boolean }
	): Promise<SavedWorkspace> {
		const asleep = this.sleeping.get(id);
		return asleep ? Promise.resolve(asleep.saved) : this.session(id).snapshot(options);
	}

	/** Swap a running session for its snapshot. Its Neovim exits quietly afterward. */
	putToSleep(id: string, session: Session, saved: SavedWorkspace): void {
		this.muted.add(id);
		this.sessions.delete(id);
		this.sleeping.set(id, { workspace: { ...session.workspace }, saved });
	}

	/** A sleeping workspace runs again; its events reach the renderer. */
	awaken(id: string): void {
		this.sleeping.delete(id);
		this.muted.delete(id);
	}

	/** Forget a sleeping workspace. Returns whether it was asleep. */
	forgetSleeping(id: string): boolean {
		if (!this.sleeping.delete(id)) {
			return false;
		}
		this.muted.delete(id);
		return true;
	}

	/** Files that sleeping workspaces had open, which they reopen when they wake. */
	sleepingFiles(): string[] {
		return [...this.sleeping.values()].flatMap(({ saved }) => saved.files.map((f) => f.path));
	}
}
