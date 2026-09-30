import type {
    DebugState,
    NidoEvent,
    Redraw,
    SessionState,
    ReferencePreview
} from '../shared/types';

const rendererGridEvents = new Set([
    'popupmenu_show',
    'popupmenu_select',
    'popupmenu_hide',
    'grid_resize',
    'grid_clear',
    'grid_line',
    'grid_scroll',
    'grid_cursor_goto',
    'hl_attr_define',
    'default_colors_set',
    'mode_change',
    'busy_start',
    'busy_stop',
    'flush'
]);

// Own Neovim notifications and publish only complete redraw frames.
export class SessionEvents {
    state: SessionState = { buffers: [], current: 0, mode: 'n', line: 1, column: 1, filetype: '' };
    private pendingRedraw: Redraw = [];
    private isBatchingScroll = false;

    constructor(
        private workspaceId: string,
        private sendToRenderer: (event: NidoEvent) => void
    ) {}

    beginScrollBatch(): void {
        this.isBatchingScroll = true;
    }

    endScrollBatch(): void {
        this.isBatchingScroll = false;
        if (this.pendingRedraw.length === 0) return;
        // Grid rows and their fractional offset must become visible together.
        this.pendingRedraw.push(['flush', []]);
        this.publishPendingRedraw();
    }

    private publishPendingRedraw(): void {
        const completedFrame = this.pendingRedraw;
        this.pendingRedraw = [];
        this.sendToRenderer({ type: 'redraw', id: this.workspaceId, events: completedFrame });
    }

    private publishState(): void {
        this.sendToRenderer({ type: 'state', id: this.workspaceId, state: this.state });
    }

    receiveNotification(method: string, args: unknown[]): void {
        switch (method) {
            case 'nido:hover': {
                if (typeof args[0] === 'string' && typeof args[1] === 'string') {
                    this.sendToRenderer({
                        type: 'hover',
                        id: this.workspaceId,
                        markdown: args[0],
                        filetype: args[1],
                        codeBlocks: Array.isArray(args[2])
                            ? (args[2] as ReferencePreview['lines'][])
                            : []
                    });
                }
                break;
            }
            case 'nido:scroll': {
                this.pendingRedraw.push(['nido_scroll', args[0] as unknown[]]);
                break;
            }
            case 'nido:edit': {
                this.pendingRedraw.push(['nido_edit', []]);
                break;
            }
            case 'nido:pixel_scroll': {
                if (this.isBatchingScroll) {
                    this.pendingRedraw.push(['nido_pixel_scroll', args]);
                    break;
                }
                this.sendToRenderer({
                    type: 'redraw',
                    id: this.workspaceId,
                    events: [
                        ['nido_pixel_scroll', args],
                        ['flush', []]
                    ]
                });
                break;
            }
            case 'nido:message': {
                this.sendToRenderer({
                    type: 'error',
                    id: this.workspaceId,
                    message: String(args[0])
                });
                break;
            }
            case 'redraw': {
                // Other events can contain Neovim Window handles, which cannot cross Electron IPC.
                for (const event of args as Redraw) {
                    if (!rendererGridEvents.has(event[0])) {
                        continue;
                    }
                    this.pendingRedraw.push(event);
                    // A repaint can span several RPC notifications. Never expose a partial frame.
                    if (event[0] === 'flush' && !this.isBatchingScroll) {
                        this.publishPendingRedraw();
                    }
                }
                break;
            }
            case 'nido:state': {
                this.state = {
                    ...(args[0] as SessionState),
                    debug: this.state.debug,
                    references: this.state.references
                };
                // Lua encodes an empty table as a map rather than an array.
                if (!Array.isArray(this.state.buffers)) {
                    this.state.buffers = [];
                }
                if (!Array.isArray(this.state.problems)) {
                    this.state.problems = [];
                }
                this.publishState();
                break;
            }
            case 'nido:references': {
                const references = args[0] as NonNullable<SessionState['references']>;
                if (!Array.isArray(references.items)) {
                    references.items = [];
                }
                this.state = { ...this.state, references };
                this.publishState();
                break;
            }
            case 'nido:debug': {
                const debug = args[0] as DebugState;
                if (!Array.isArray(debug.variables)) {
                    debug.variables = [];
                }
                if (!Array.isArray(debug.targets)) {
                    debug.targets = [];
                }
                this.state = { ...this.state, debug };
                this.publishState();
                break;
            }
        }
    }
}
