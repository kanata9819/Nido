import type { SavedLayout } from './persistence';

/**
 * Saves the workspace layout (open workspaces, files and cursors) in the background so it can
 * be restored on the next launch, even after a crash. Coalesces saves and lets shutdown finish
 * after any in-flight write.
 */
export class WorkspaceCheckpoints {
	private pending?: Promise<void>;
	private queued = false;
	private saved?: string;
	private disposed = false;
	private reportedError = false;

	constructor(
		private readonly snapshot: () => Promise<SavedLayout | undefined>,
		private readonly write: (layout: SavedLayout) => Promise<void>,
		private readonly onError: (error: unknown) => void
	) {}

	/**
	 * Save a fresh snapshot. A save requested while another is running is queued, and all such
	 * requests share one follow-up save. Unchanged layouts are not written again.
	 */
	save(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (this.pending) {
			this.queued = true;
			return this.pending;
		}
		this.pending = (async () => {
			const layout = await this.snapshot();
			if (!layout || this.disposed) {
				return;
			}
			const serialized = JSON.stringify(layout);
			if (serialized === this.saved) {
				return;
			}
			await this.write(layout);
			this.saved = serialized;
			this.reportedError = false;
		})()
			.catch((error: unknown) => {
				if (!this.reportedError && !this.disposed) {
					this.onError(error);
				}
				this.reportedError = true;
			})
			.finally(() => {
				this.pending = undefined;
				if (this.queued && !this.disposed) {
					// Save requests received during I/O share one fresh snapshot. Returning
					// the follow-up also keeps idle() and the original callers waiting for it.
					this.queued = false;
					return this.save();
				}
				return undefined;
			});
		return this.pending;
	}

	/** Resolves once no save is running, so shutdown can wait for the last write. */
	idle(): Promise<void> {
		return this.pending ?? Promise.resolve();
	}

	/** Stop saving; later save() calls do nothing. */
	dispose(): void {
		this.disposed = true;
	}
}
