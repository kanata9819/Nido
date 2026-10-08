import type { Grid } from './grid';
import { ScrollQueue } from './scroll';

interface Options {
    id: string;
    grid: Grid;
    enabled: () => boolean;
    schedule: () => void;
    onError: (error: unknown) => void;
    onCompletion: (promise: Promise<void>) => void;
}

/** Own wheel requests, native redraw acknowledgements and history prefetch. */
export class EditorScroll {
    private readonly queue = new ScrollQueue();
    private prefetchNeeded = true;
    private fetching = false;
    private disposed = false;
    private settleTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly options: Options) {}

    get pending(): boolean {
        return this.queue.pending;
    }

    get prefetchPending(): boolean {
        return this.fetching;
    }

    get needsPrefetch(): boolean {
        return (
            this.prefetchNeeded &&
            this.queue.preview < 0 &&
            (this.options.grid.canPreviewUpwardScroll || this.queue.preview > -1)
        );
    }

    get canPrefetch(): boolean {
        return this.needsPrefetch && !this.fetching && !this.pending && this.options.enabled();
    }

    invalidatePrefetch(): void {
        this.prefetchNeeded = true;
    }

    pauseIfDisabled(): void {
        if (!this.options.enabled()) {
            this.queue.cancelQueued();
            this.options.grid.scrollPreview = 0;
        }
    }

    stop(): void {
        this.queue.cancelQueued();
        this.options.grid.scrollPreview = 0;
        this.options.grid.scrolling = false;
        clearTimeout(this.settleTimer);
        this.options.schedule();
    }

    private settle = (): void => {
        if (this.pending || this.queue.hasQueued || this.fetching) {
            this.settleTimer = setTimeout(this.settle, 40);
            return;
        }
        this.options.grid.scrolling = false;
        this.options.schedule();
    };

    request(lines: number, follow: boolean): void {
        const { grid, schedule } = this.options;
        grid.scrolling = true;
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(this.settle, 160);
        this.queue.enqueue(lines, follow);
        grid.scrollPreview = this.queue.preview;
        if (lines < 0 && !this.fetching && grid.needsUpperRows) {
            this.prefetchNeeded = true;
        }
        // Start native movement during input; paints stay coalesced on animation frames.
        if (!this.needsPrefetch) {
            this.flush();
        }
        schedule();
    }

    acknowledge(direct: boolean): void {
        if (direct && this.pending) {
            this.queue.acknowledge();
            this.options.grid.scrollPreview = this.queue.preview;
        } else if (!direct && !this.pending) {
            this.queue.cancelQueued();
            this.options.grid.scrollPreview = 0;
        }
    }

    finish(): void {
        if (!this.queue.finish()) {
            return;
        }
        if (this.queue.hasQueued) {
            // Dispatch after both the reply and redraw, without adding a frame of latency.
            if (!this.needsPrefetch) {
                this.flush();
            }
            this.options.schedule();
        }
    }

    flush(): void {
        if (!this.options.enabled()) {
            return;
        }
        const command = this.queue.start();
        if (!command) {
            return;
        }
        const { id, grid, onError, onCompletion, schedule } = this.options;
        onCompletion(
            window.nido
                .scroll(id, command.lines, command.follow, true)
                .catch((error) => {
                    if (this.disposed) {
                        return;
                    }
                    this.queue.fail();
                    grid.scrollPreview = 0;
                    onError(error);
                    schedule();
                })
                .finally(() => {
                    if (this.disposed) {
                        return;
                    }
                    this.queue.complete();
                    this.finish();
                })
        );
    }

    prefetch(): void {
        this.prefetchNeeded = false;
        this.fetching = true;
        this.options.onCompletion(
            window.nido
                .prefetchScroll(this.options.id)
                .catch((error) => {
                    if (!this.disposed) {
                        this.options.onError(error);
                    }
                })
                .finally(() => {
                    if (this.disposed) {
                        return;
                    }
                    this.fetching = false;
                    if (this.queue.hasQueued) {
                        this.options.schedule();
                    }
                })
        );
    }

    dispose(): void {
        this.disposed = true;
        clearTimeout(this.settleTimer);
        this.options.grid.scrollPreview = 0;
        this.options.grid.scrolling = false;
    }
}
