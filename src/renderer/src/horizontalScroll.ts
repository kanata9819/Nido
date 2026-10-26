/** Keep the native view ahead of the fractional position shown between two frames. */
export class HorizontalScroll {
  private column = 0;
  private previous = 0;
  private position?: number;
  private requested = 0;
  private limit?: number;

  get native(): number {
    return this.column;
  }

  get active(): boolean {
    return this.position !== undefined;
  }

  get offset(): number {
    return this.column - (this.position ?? this.column);
  }

  private covers(position: number): boolean {
    return (
      position >= Math.min(this.previous, this.column) &&
      position <= Math.max(this.previous, this.column)
    );
  }

  request(delta: number): number {
    if (!Number.isFinite(delta) || !delta) {
      return 0;
    }
    const position = Math.max(
      0,
      Math.min(this.limit ?? Infinity, (this.position ?? this.requested) + delta)
    );
    if (!Number.isFinite(position)) {
      return 0;
    }
    const rounded = Math.round(position);
    this.position = Math.abs(position - rounded) < 1e-9 ? rounded : position;
    const target = Number.isInteger(this.position)
      ? this.position
      : this.covers(this.position)
        ? this.column
        : this.position < this.column
          ? Math.floor(this.position)
          : Math.ceil(this.position);
    const movement = target - this.requested;
    this.requested = target;
    return movement;
  }

  acknowledge(column: number, expected: number): boolean {
    if (!Number.isSafeInteger(column) || column < 0) {
      return false;
    }
    const previous = this.column;
    if (column !== previous) {
      this.previous = previous;
    }
    this.column = column;
    if (!this.active) {
      this.previous = column;
      this.requested = column;
      return false;
    }
    if (column !== previous + expected) {
      this.position = column;
      this.requested = column;
      this.limit = expected > 0 && column < previous + expected ? column : undefined;
      return true;
    }
    if (this.position !== undefined && this.covers(this.position) && this.requested !== column) {
      this.requested = column;
      return true;
    }
    return false;
  }

  invalidateLimit(): void {
    this.limit = undefined;
  }

  discardFrame(): void {
    this.previous = this.column;
  }

  stop(pendingColumns = 0): void {
    this.position = undefined;
    this.previous = this.column;
    this.requested = Math.max(0, this.column + pendingColumns);
    this.invalidateLimit();
  }

  reset(): void {
    this.column = 0;
    this.stop();
  }
}
