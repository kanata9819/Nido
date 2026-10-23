import type { SavedLayout } from './persistence';

/** Coalesce background saves and let shutdown finish after any in-flight write. */
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

    idle(): Promise<void> {
        return this.pending ?? Promise.resolve();
    }

    dispose(): void {
        this.disposed = true;
    }
}
