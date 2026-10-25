import type { Grid } from './grid';
import { ScrollQueue, scrollOffset } from './scroll';

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
  private down = false;
  private fetching = false;
  private disposed = false;
  private generation = 0;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private wheelMotion?: {
    distance: number;
    remaining: number;
    start: number;
    follow: boolean;
    duration: number;
  };

  constructor(private readonly options: Options) {}

  get pending(): boolean {
    return this.queue.pending;
  }

  get prefetchPending(): boolean {
    return this.fetching;
  }

  get animating(): boolean {
    return this.wheelMotion !== undefined;
  }

  get needsPrefetch(): boolean {
    return (
      this.prefetchNeeded &&
      // An exhausted preview must send native movement immediately, even below one line.
      ((this.queue.preview < 0 && this.options.grid.canPreviewUpwardScroll) ||
        (this.queue.preview > 0 && this.options.grid.canPreviewDownwardScroll))
    );
  }

  get canPrefetch(): boolean {
    return this.needsPrefetch && !this.fetching && !this.pending && this.options.enabled();
  }

  invalidatePrefetch(): void {
    this.prefetchNeeded = true;
  }

  reset(): void {
    this.generation++;
    this.queue.reset();
    this.fetching = false;
    this.prefetchNeeded = true;
    this.stop();
  }

  pauseIfDisabled(): void {
    if (!this.options.enabled()) {
      this.wheelMotion = undefined;
      this.queue.cancelQueued();
      this.options.grid.scrollPreview = 0;
    }
  }

  stop(): void {
    this.wheelMotion = undefined;
    this.queue.cancelQueued();
    this.options.grid.scrollPreview = 0;
    this.options.grid.scrolling = false;
    clearTimeout(this.settleTimer);
    this.options.schedule();
  }

  private settle = (): void => {
    if (this.animating || this.pending || this.queue.hasQueued || this.fetching) {
      this.settleTimer = setTimeout(this.settle, 40);
      return;
    }
    this.options.grid.scrolling = false;
    this.options.schedule();
  };

  request(lines: number, follow: boolean, duration = 0, now = performance.now()): void {
    // Retarget from the current position, preserving unconsumed distance through wheel bursts.
    if (duration) {
      const motion = this.wheelMotion;
      const offset = motion
        ? scrollOffset(motion.distance, now - motion.start, motion.duration)
        : 0;
      // Keep the gesture's speed near file edges. Clamp each rendered step,
      // rather than easing over the shorter distance left to the boundary.
      const distance = offset + lines;
      const remaining = (motion?.remaining ?? 0) + lines;
      // Native requests are dispatched by paints, even if several inputs arrive per frame.
      this.wheelMotion = this.options.grid.limitScroll(remaining)
        ? { distance, remaining, start: now, follow, duration }
        : undefined;
      this.options.schedule();
    } else {
      this.advance(now, false);
      this.move(lines, follow);
    }
  }

  advance(now: number, animate: boolean): void {
    const motion = this.wheelMotion;
    if (!motion) {
      return;
    }
    const offset = animate ? scrollOffset(motion.distance, now - motion.start, motion.duration) : 0;
    const remaining = Math.abs(offset) < 0.001 ? 0 : offset;
    const delta = motion.remaining - remaining;
    const lines = this.options.grid.limitScroll(delta);
    motion.remaining = remaining;
    if (!remaining || lines !== delta) {
      this.wheelMotion = undefined;
    }
    if (lines) {
      this.move(lines, motion.follow);
    }
  }

  requestHorizontal(columns: number, follow: boolean): void {
    this.move(0, follow, columns);
  }

  private move(lines: number, follow: boolean, columns = 0): void {
    const { grid, schedule } = this.options;
    grid.scrolling = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(this.settle, 160);
    this.queue.enqueue(lines, follow, columns);
    if (lines) {
      this.down = lines > 0;
    }
    grid.scrollPreview = this.queue.preview;
    if (columns || (!this.fetching && (lines < 0 ? grid.needsUpperRows : grid.needsLowerRows))) {
      this.prefetchNeeded = true;
    }
    // Start native movement during input; paints stay coalesced on animation frames.
    if (columns || !this.needsPrefetch) {
      this.flush();
      // A cold fast gesture still needs a cache; send native movement first.
      if (this.prefetchNeeded && !this.fetching && this.options.enabled()) {
        this.prefetch();
      }
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
    const generation = this.generation;
    const request = command.columns
      ? window.nido.scroll(id, command.lines, command.follow, true, command.columns)
      : window.nido.scroll(id, command.lines, command.follow, true);
    onCompletion(
      request
        .catch((error) => {
          if (this.disposed || generation !== this.generation) {
            return;
          }
          this.queue.fail();
          this.wheelMotion = undefined;
          grid.scrollPreview = 0;
          onError(error);
          schedule();
        })
        .finally(() => {
          if (this.disposed || generation !== this.generation) {
            return;
          }
          this.queue.complete();
          this.finish();
        })
    );
  }

  prefetch(): void {
    const down = this.down;
    const generation = this.generation;
    this.prefetchNeeded = false;
    this.fetching = true;
    this.options.onCompletion(
      window.nido
        .prefetchScroll(this.options.id, down)
        .catch((error) => {
          if (!this.disposed && generation === this.generation) {
            this.options.onError(error);
          }
        })
        .finally(() => {
          if (this.disposed || generation !== this.generation) {
            return;
          }
          this.fetching = false;
          // Warm the final direction even if input stopped during the previous refill.
          if (
            down !== this.down &&
            this.options.enabled() &&
            (this.down ? this.options.grid.needsLowerRows : this.options.grid.needsUpperRows)
          ) {
            this.prefetch();
          }
          if (this.queue.hasQueued) {
            this.options.schedule();
          }
        })
    );
  }

  dispose(): void {
    this.disposed = true;
    this.wheelMotion = undefined;
    clearTimeout(this.settleTimer);
    this.options.grid.scrollPreview = 0;
    this.options.grid.scrolling = false;
  }
}
