import type { Grid } from './grid';

interface Position {
    row: number;
    column: number;
}

/** Own cursor interpolation, blink timing and their focus listeners. */
export class EditorCursor {
    private position?: Position;
    private motion?: { from: Position; to: Position; start: number };
    private fade?: { from: number; to: number; start: number };
    private timer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly grid: Grid,
        private readonly host: HTMLElement,
        private readonly input: HTMLTextAreaElement,
        private readonly reducedMotion: MediaQueryList,
        private readonly smoothBlink: boolean,
        private readonly schedule: () => void
    ) {}

    get animating(): boolean {
        return !!(this.motion || this.fade);
    }

    resetPosition(): void {
        this.position = undefined;
        this.motion = undefined;
    }

    update(now: number, smooth: boolean, interrupted: boolean, focused: boolean): Position {
        const target = this.grid.scrollCursor ?? this.grid.cursor;
        if (this.fade) {
            const progress = this.canBlink() ? Math.min(1, (now - this.fade.start) / 180) : 1;
            const eased = progress * progress * (3 - 2 * progress);
            this.grid.cursorOpacity = this.canBlink()
                ? this.fade.from + (this.fade.to - this.fade.from) * eased
                : 1;
            if (progress === 1) {
                this.fade = undefined;
            }
        }
        if (
            !this.position ||
            !smooth ||
            interrupted ||
            this.reducedMotion.matches ||
            !focused ||
            !document.hasFocus()
        ) {
            this.position = { ...target };
            this.motion = undefined;
        } else {
            const previousTarget = this.motion?.to ?? this.position;
            if (target.row !== previousTarget.row || target.column !== previousTarget.column) {
                this.motion = { from: { ...this.position }, to: { ...target }, start: now };
            }
            if (this.motion) {
                const progress = Math.min(1, (now - this.motion.start) / 100);
                const eased = 1 - (1 - progress) ** 3;
                this.position = {
                    row: this.motion.from.row + (this.motion.to.row - this.motion.from.row) * eased,
                    column:
                        this.motion.from.column +
                        (this.motion.to.column - this.motion.from.column) * eased
                };
                if (progress === 1) {
                    this.motion = undefined;
                }
            }
        }
        return this.position;
    }

    private canBlink(): boolean {
        return (
            document.hasFocus() &&
            !document.hidden &&
            !this.host.hidden &&
            document.activeElement === this.input &&
            !this.reducedMotion.matches
        );
    }

    private blink = (): void => {
        if (!this.canBlink()) {
            return;
        }
        if (this.smoothBlink) {
            this.fade = {
                from: this.grid.cursorOpacity,
                to: this.grid.cursorOpacity > 0.5 ? 0 : 1,
                start: performance.now()
            };
        } else {
            this.grid.cursorVisible = !this.grid.cursorVisible;
        }
        this.schedule();
        this.timer = setTimeout(this.blink, 550);
    };

    resetBlink = (): void => {
        clearTimeout(this.timer);
        this.grid.cursorVisible = true;
        this.grid.cursorOpacity = 1;
        this.fade = undefined;
        this.schedule();
        if (this.canBlink()) {
            this.timer = setTimeout(this.blink, 550);
        }
    };

    listen(): void {
        for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
            this.input.addEventListener(event, this.resetBlink);
        }
        window.addEventListener('focus', this.resetBlink);
        window.addEventListener('blur', this.resetBlink);
        document.addEventListener('visibilitychange', this.resetBlink);
        this.reducedMotion.addEventListener('change', this.resetBlink);
    }

    dispose(): void {
        clearTimeout(this.timer);
        for (const event of ['focus', 'blur', 'keydown', 'input', 'compositionstart']) {
            this.input.removeEventListener(event, this.resetBlink);
        }
        window.removeEventListener('focus', this.resetBlink);
        window.removeEventListener('blur', this.resetBlink);
        document.removeEventListener('visibilitychange', this.resetBlink);
        this.reducedMotion.removeEventListener('change', this.resetBlink);
    }
}
