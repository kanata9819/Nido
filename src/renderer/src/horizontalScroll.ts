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

  request(delta: number, ahead = 1): number {
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
    const distance = (this.position - this.column) / ahead;
    const target =
      ahead === 1 && Number.isInteger(this.position)
        ? this.position
        : this.covers(this.position)
          ? this.column
          : Math.max(
              0,
              this.column + (distance < 0 ? Math.floor(distance) : Math.ceil(distance)) * ahead
            );
    const movement = target - this.requested;
    this.requested = target;
    return movement;
  }

  settle(): number {
    if (
      this.position === undefined ||
      this.column === Math.floor(this.position) ||
      this.column === Math.ceil(this.position)
    ) {
      return 0;
    }
    const target =
      this.column > this.position ? Math.floor(this.position) : Math.ceil(this.position);
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
      const limited = expected > 0 && column >= previous && column < previous + expected;
      this.position = limited ? Math.min(this.position!, column) : column;
      this.requested = column;
      this.limit = limited ? column : undefined;
      if (!limited) {
        this.previous = column;
      }
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

  stop(pendingColumns = 0, preservePosition = false): void {
    if (!preservePosition) {
      this.position = undefined;
      this.previous = this.column;
      this.invalidateLimit();
    }
    this.requested = Math.max(0, this.column + pendingColumns);
  }

  reset(): void {
    this.column = 0;
    this.stop();
  }
}
