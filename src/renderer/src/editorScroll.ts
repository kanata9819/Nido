import type { Grid } from './grid';
import { ScrollQueue, scrollOffset } from './scroll';
import { HorizontalScroll } from './horizontalScroll';

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
  private readonly horizontal = new HorizontalScroll();
  private prefetchNeeded = true;
  private down = false;
  private fetching = false;
  private disposed = false;
  private paused = false;
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

  get horizontalOffset(): number {
    return this.horizontal.offset;
  }

  get horizontalColumn(): number {
    return this.horizontal.native;
  }

  get horizontalActive(): boolean {
    return this.horizontal.active;
  }

  observeHorizontal(column: number): void {
    if (this.horizontal.acknowledge(column, 0)) {
      this.queue.cancelHorizontal();
    }
  }

  stopHorizontal(): void {
    this.horizontal.stop(this.queue.pendingColumns);
    this.queue.cancelHorizontal();
  }

  alignHorizontal(): boolean {
    if (
      !this.horizontal.active ||
      (Math.abs(this.horizontal.offset) <= 1 && Math.abs(this.queue.pendingColumns) <= 1)
    ) {
      return false;
    }
    if (!this.pending) {
      const columns = this.horizontal.settle();
      if (columns) {
        this.move(0, false, columns);
      }
    }
    return true;
  }

  discardHorizontalFrame(): void {
    this.horizontal.discardFrame();
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
    this.horizontal.reset();
    this.fetching = false;
    this.prefetchNeeded = true;
    this.stop();
  }

  pauseIfDisabled(): void {
    if (!this.options.enabled()) {
      this.paused = true;
      this.wheelMotion = undefined;
      this.queue.cancelQueued();
      this.horizontal.stop(this.queue.pendingColumns, true);
      this.options.grid.scrollPreview = 0;
    } else if (this.paused) {
      this.paused = false;
      if (this.horizontal.active) {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(this.settle, 160);
      }
    }
  }

  stop(preserveHorizontal = false): void {
    this.wheelMotion = undefined;
    this.queue.cancelQueued();
    this.horizontal.stop(this.queue.pendingColumns, preserveHorizontal);
    this.options.grid.scrollPreview = 0;
    this.options.grid.scrolling = false;
    clearTimeout(this.settleTimer);
    if (preserveHorizontal && this.horizontal.active) {
      this.settleTimer = setTimeout(this.settle, 160);
    }
    this.options.schedule();
  }

  private settle = (): void => {
    if (this.animating || this.pending || this.queue.hasQueued || this.fetching) {
      this.settleTimer = setTimeout(this.settle, 40);
      return;
    }
    const columns = this.options.enabled() ? this.horizontal.settle() : 0;
    if (columns) {
      this.move(0, false, columns);
      return;
    }
    this.options.grid.scrolling = false;
    this.options.schedule();
  };

  request(lines: number, follow: boolean, duration = 0, now = performance.now()): void {
    this.horizontal.invalidateLimit();
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

  requestHorizontal(columns: number, follow: boolean, preview = true): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(this.settle, 160);
    // Detached scrolling can retain a strip ahead without moving the editing cursor.
    const ahead = !follow && preview && !this.animating && !this.queue.verticalPending ? 8 : 1;
    const movement = this.horizontal.request(columns, ahead);
    if (movement) {
      this.move(0, follow, movement);
    } else {
      this.options.schedule();
    }
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
      if (lines && this.prefetchNeeded && !this.fetching && this.options.enabled()) {
        this.prefetch();
      }
    }
    schedule();
  }

  acknowledge(direct: boolean, column?: number): void {
    if (
      column !== undefined &&
      this.horizontal.acknowledge(column, direct ? this.queue.pendingColumns : 0)
    ) {
      this.queue.cancelHorizontal();
    }
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
          this.horizontal.stop();
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
