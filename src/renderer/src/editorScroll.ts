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
  private settleAt = 0;
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
        this.deferSettle();
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
    this.settleTimer = undefined;
    if (preserveHorizontal && this.horizontal.active) {
      this.deferSettle();
    }
    this.options.schedule();
  }

  private deferSettle(): void {
    this.settleAt = performance.now() + 160;
    this.settleTimer ??= setTimeout(this.settle, 160);
  }

  private settle = (): void => {
    this.settleTimer = undefined;
    const remaining = this.settleAt - performance.now();
    if (remaining > 0) {
      this.settleTimer = setTimeout(this.settle, remaining);
      return;
    }
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
      this.move(this.screenLines(lines), follow);
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
    const distance = this.screenLines(delta);
    const lines = this.options.grid.limitScroll(distance);
    motion.remaining = remaining;
    if (!remaining || lines !== distance) {
      this.wheelMotion = undefined;
    }
    if (lines) {
      this.move(lines, motion.follow);
    }
  }

  private screenLines(lines: number): number {
    const grid = this.options.grid;
    const height = grid.cellHeight;
    if (!grid.pixelScrollEnabled || !height || !lines || grid.rows < 2) {
      return lines;
    }
    grid.prepareLayout(grid.contentHeight, grid.cellWidth, height);
    const position = grid.scrollFraction + grid.scrollPreview;
    let low = -grid.historyRows.length;
    let high = grid.rows - 1 + grid.futureRows.length;
    const minimum = grid.rowTop(low);
    const maximum = grid.rowTop(high);
    const origin =
      position < low
        ? minimum + (position - low) * height
        : position > high
          ? maximum + (position - high) * height
          : grid.rowTop(position);
    const target = origin + lines * height;
    // shortcut: unseen rows use standard height until their geometry is cached.
    if (target < minimum) {
      return low + (target - minimum) / height - position;
    }
    if (target >= maximum) {
      return high + (target - maximum) / height - position;
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (grid.rowTop(middle) <= target) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const top = grid.rowTop(low);
    return low + (target - top) / (grid.rowTop(low + 1) - top) - position;
  }

  requestHorizontal(columns: number, follow: boolean, preview = true): void {
    this.deferSettle();
    // Keep both cached edges overlapping when a fast gesture reverses.
    const maxAhead = Math.max(
      1,
      Math.floor((this.options.grid.columns - this.options.grid.horizontalGutter - 1) / 2)
    );
    const ahead =
      !follow && preview && !this.animating && !this.queue.verticalPending
        ? Math.min(maxAhead, 32, Math.max(8, Math.ceil(Math.abs(columns) * 4)))
        : 1;
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
    this.deferSettle();
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
    this.settleTimer = undefined;
    this.options.grid.scrollPreview = 0;
    this.options.grid.scrolling = false;
  }
}
