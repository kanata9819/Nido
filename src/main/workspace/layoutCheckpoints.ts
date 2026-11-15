import type { BrowserWindow } from 'electron';
import { writeLayout, type SavedLayout } from './persistence';
import { WorkspaceCheckpoints } from './workspaceCheckpoints';
import type { WorkspaceRegistry } from './workspaceRegistry';
import type { AppState } from '../ipc/handlers';
import type { NidoEvent, SavedWorkspace } from '../../shared/types';
import { untitledRecoveryLimitMessage } from '../../shared/recovery';

/** How often the layout is saved in the background, in milliseconds. */
const checkpointInterval = 5000;

/**
 * Saves the open workspaces' layout while the app runs, so a crash loses little, and once
 * more at shutdown. Background saves start only once workspaces were restored or created.
 */
export class LayoutCheckpoints {
	private ready = false;
	// The next write replaces the backup too, so closed drafts do not come back from it.
	private replaceBackup = false;
	private readonly checkpoints: WorkspaceCheckpoints;

	constructor(
		private readonly window: BrowserWindow,
		private readonly state: AppState,
		private readonly registry: WorkspaceRegistry,
		private readonly layoutPath: string,
		send: (event: NidoEvent) => void
	) {
		this.checkpoints = new WorkspaceCheckpoints(
			() => this.collect(),
			(layout) => this.write(layout),
			(error) =>
				send({
					type: 'notification',
					id: state.active,
					title: 'Workspace recovery',
					message: String(error).includes(untitledRecoveryLimitMessage)
						? untitledRecoveryLimitMessage
						: String(error),
					severity: 'error'
				})
		);
		const timer = setInterval(() => void this.checkpoints.save(), checkpointInterval);
		timer.unref();
		window.once('closed', () => {
			clearInterval(timer);
			this.checkpoints.dispose();
		});
	}

	/** Allow background saves: there is a layout worth keeping now. */
	start(): void {
		this.ready = true;
	}

	/** Save now, also replacing the backup (after a workspace was closed on purpose). */
	saveReplacingBackup(): Promise<void> {
		this.replaceBackup = true;
		return this.checkpoints.save();
	}

	/** Write the layout one last time before quitting, after any background write. */
	async saveFinal(): Promise<void> {
		await this.checkpoints.idle();
		const ids = this.registry.orderedIds();
		const workspaces = await Promise.all(
			ids.map((id) => this.registry.snapshotOf(id, { includeUntitled: false }))
		);
		await writeLayout(this.layoutPath, this.layout(ids, this.state.active, workspaces), {
			replaceBackup: true
		});
	}

	private canCheckpoint(): boolean {
		const { state } = this;
		return this.ready && !state.prompting && !state.closing && !this.window.isDestroyed();
	}

	private layout(ids: string[], active: string, workspaces: SavedWorkspace[]): SavedLayout {
		const bounds = this.window.getNormalBounds();
		return {
			version: 1,
			window: {
				width: bounds.width,
				height: bounds.height,
				maximized: this.window.isMaximized()
			},
			workspaces,
			active: Math.max(0, ids.indexOf(active))
		};
	}

	/** The current layout, or undefined when it should not be saved right now. */
	private async collect(): Promise<SavedLayout | undefined> {
		if (!this.canCheckpoint()) {
			return;
		}
		const { registry, state } = this;
		const ids = registry.orderedIds();
		const active = state.active;
		const workspaces = await this.snapshots(ids);
		// The layout may have changed while the snapshots were taken; the next save sees it.
		if (
			!workspaces ||
			!this.canCheckpoint() ||
			active !== state.active ||
			JSON.stringify(ids) !== JSON.stringify(registry.orderedIds())
		) {
			return;
		}
		return this.layout(ids, active, workspaces);
	}

	/** Snapshots of `ids`, or undefined when a Neovim is busy or a workspace went away. */
	private async snapshots(ids: string[]): Promise<SavedWorkspace[] | undefined> {
		const { registry, state } = this;
		const running = ids.filter((id) => registry.sessions.has(id));
		const current = running.map((id) => registry.sessions.get(id)!);
		try {
			// Fast mode queries remain available while Vim waits for a prompt or a key.
			const modes = await Promise.all(
				current.map((s) => s.client.request('nvim_get_mode', []))
			);
			if (modes.some((mode: { blocking: boolean }) => mode.blocking)) {
				return;
			}
			return await Promise.all(
				ids.map((id) =>
					registry.snapshotOf(id, {
						restoreScroll: false,
						includeUntitled: state.historyEnabled !== false
					})
				)
			);
		} catch (error) {
			// A workspace closed or put to sleep meanwhile cancels its requests. The next
			// checkpoint sees the new layout, so this one is skipped instead of reported.
			if (current.some((s) => !s.running || registry.sessions.get(s.workspace.id) !== s)) {
				return;
			}
			throw error;
		}
	}

	private async write(layout: SavedLayout): Promise<void> {
		const replace = this.replaceBackup;
		await writeLayout(this.layoutPath, layout, { replaceBackup: replace });
		if (replace) {
			this.replaceBackup = false;
		}
	}
}
