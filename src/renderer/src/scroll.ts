export function scrollOffset(distance: number, elapsed: number): number {
    const progress = Math.min(1, Math.max(0, elapsed / 120));
    return distance * (1 - progress) ** 3;
}

export function accumulateScroll(
    remainder: number,
    delta: number,
    mode: number,
    lineHeight: number,
    pageHeight: number
): { lines: number; remainder: number } {
    let unit = 1;
    if (mode === 1) {
        unit = lineHeight;
    } else if (mode === 2) {
        unit = pageHeight;
    }
    const pixels = delta * unit;
    if (!pixels || !Number.isFinite(pixels)) {
        return { lines: 0, remainder };
    }
    if (Math.sign(pixels) !== Math.sign(remainder)) {
        remainder = 0;
    }
    const total = remainder + pixels;
    const lines = Math.trunc(total / lineHeight);
    return { lines, remainder: total - lines * lineHeight };
}

interface ScrollCommand {
    lines: number;
    follow: boolean;
}

interface PendingScroll extends ScrollCommand {
    acknowledged: boolean;
    completed: boolean;
}

// Keep one command in flight while coalescing new wheel input for the next frame.
export class ScrollQueue {
    private queued = 0;
    private follow = true;
    private inFlight: PendingScroll | undefined;

    get hasQueued(): boolean {
        return this.queued !== 0;
    }

    get pending(): boolean {
        return this.inFlight !== undefined;
    }

    get preview(): number {
        // A redraw already includes the sent distance; only unsent input remains to preview.
        return this.queued + (this.inFlight?.acknowledged ? 0 : (this.inFlight?.lines ?? 0));
    }

    enqueue(lines: number, follow: boolean): void {
        this.queued += lines;
        this.follow = follow;
    }

    cancelQueued(): void {
        this.queued = 0;
    }

    start(): ScrollCommand | undefined {
        if (this.pending || !this.hasQueued) {
            return undefined;
        }
        const command = {
            lines: Math.max(-1000, Math.min(1000, this.queued)),
            follow: this.follow
        };
        this.queued -= command.lines;
        this.inFlight = { ...command, acknowledged: false, completed: false };
        return command;
    }

    acknowledge(): void {
        if (this.inFlight) {
            this.inFlight.acknowledged = true;
        }
    }

    complete(): void {
        if (this.inFlight) {
            this.inFlight.completed = true;
        }
    }

    fail(): void {
        this.cancelQueued();
        // Failed commands have no redraw to acknowledge.
        this.acknowledge();
    }

    finish(): boolean {
        // Invoke replies and redraw notifications can arrive in either order.
        if (!this.inFlight?.acknowledged || !this.inFlight.completed) {
            return false;
        }
        this.inFlight = undefined;
        return true;
    }
}
