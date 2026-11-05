import type {
  DebugState,
  NidoEvent,
  Redraw,
  SessionState,
  ReferencePreview,
  DiagnosticDetails
} from '../shared/types';
import { applyNeovimUI, emptyNeovimUI, type NeovimUIPatch } from '../shared/neovimUI';

// 'redraw' events used by the renderer's Grid (src/renderer/src/grid.ts). For example,
// grid_line writes cells, grid_scroll moves a region and flush ends a frame. See :help ui.
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

// Own Neovim notifications and publish only complete redraw frames. Redraws are held until
// flush so the renderer never paints a partial frame. SessionState, such as the cursor
// position and open buffers, is published from here too.
export class SessionEvents {
  state: SessionState = { buffers: [], current: 0, mode: 'n', line: 1, column: 1, filetype: '' };
  private pendingRedraw: Redraw = [];
  private isBatchingScroll = false;
  private pendingState = false;
  private publishedState?: SessionState;
  private neovimUI = emptyNeovimUI();
  private publishedUI?: typeof this.neovimUI;
  private pendingUI = false;

  constructor(
    private workspaceId: string,
    private sendToRenderer: (event: NidoEvent) => void,
    private filePath?: (path: string) => string
  ) {}

  beginScrollBatch(): void {
    this.isBatchingScroll = true;
  }

  endScrollBatch(): void {
    this.isBatchingScroll = false;
    if (this.pendingRedraw.length) {
      // Grid rows and their fractional offset must become visible together.
      this.pendingRedraw.push(['flush', []]);
      this.publishPendingRedraw();
    }
    if (this.pendingState) {
      this.pendingState = false;
      this.publishState();
    }
  }

  private publishPendingRedraw(): void {
    const completedFrame = this.pendingRedraw;
    this.pendingRedraw = [];
    this.sendToRenderer({ type: 'redraw', id: this.workspaceId, events: completedFrame });
    if (this.pendingUI) {
      this.pendingUI = false;
      this.publishUI();
    }
  }

  replayUI(): void {
    this.publishedUI = this.neovimUI;
    this.sendToRenderer({ type: 'neovimUI', id: this.workspaceId, state: this.neovimUI });
  }

  private publishUI(): void {
    const previous = this.publishedUI;
    const current = this.neovimUI;
    if (!previous) {
      this.replayUI();
      return;
    }
    this.publishedUI = current;
    const patch: NeovimUIPatch = Object.fromEntries(
      Object.entries(current).filter(
        ([key, value]) => value !== previous[key as keyof typeof current]
      )
    );
    if (patch.completion && patch.completion.items === previous.completion?.items) {
      patch.completion = { selected: patch.completion.selected };
    }
    if (Object.keys(patch).length) {
      this.sendToRenderer({ type: 'neovimUIPatch', id: this.workspaceId, state: patch });
    }
  }

  get hasInputPrompt(): boolean {
    return (
      Object.keys(this.neovimUI.commands).length > 0 ||
      this.neovimUI.messages.some(
        (message) => message.kind === 'confirm' || message.kind === 'return_prompt'
      )
    );
  }

  private publishState(): void {
    if (this.isBatchingScroll) {
      this.pendingState = true;
      return;
    }
    const previous = this.publishedState;
    const current = this.state;
    this.publishedState = current;
    // Large collections change independently of the cursor and viewport. Send
    // a snapshot when they change, and only lightweight changes between them.
    if (
      !previous ||
      (['buffers', 'problems', 'diagnostics', 'references', 'symbols', 'debug'] as const).some(
        (key) => previous[key] !== current[key]
      )
    ) {
      this.sendToRenderer({ type: 'state', id: this.workspaceId, state: current });
      return;
    }
    const patch = Object.fromEntries(
      Object.entries(current).filter(
        ([key, value]) => value !== previous[key as keyof SessionState]
      )
    );
    if (Object.keys(patch).length) {
      this.sendToRenderer({ type: 'statePatch', id: this.workspaceId, state: patch });
    }
  }

  /**
   * Route one notification from Neovim. Redraw events and the nido:* notifications sent by
   * resources/nido/session.lua either join the pending frame, go to the renderer at once, or
   * update the session state.
   */
  receiveNotification(method: string, args: unknown[]): void {
    switch (method) {
      case 'nido:sticky_scroll': {
        this.pendingRedraw.push(['nido_sticky_scroll', args]);
        break;
      }
      case 'nido:bracket_guides': {
        if (args[1] === true && !this.isBatchingScroll) {
          this.sendToRenderer({
            type: 'redraw',
            id: this.workspaceId,
            events: [
              ['nido_bracket_guides', [args[0]]],
              ['flush', []]
            ]
          });
          break;
        }
        this.pendingRedraw.push(['nido_bracket_guides', args]);
        break;
      }
      case 'nido:hover': {
        if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          this.sendToRenderer({
            type: 'hover',
            id: this.workspaceId,
            markdown: args[0],
            filetype: args[1],
            codeBlocks: Array.isArray(args[2]) ? (args[2] as ReferencePreview['lines'][]) : []
          });
        }
        break;
      }
      case 'nido:diagnostics': {
        this.sendToRenderer({
          type: 'diagnostics',
          id: this.workspaceId,
          focus: args[1] === true,
          items: Array.isArray(args[0]) ? this.hostPaths(args[0] as DiagnosticDetails[]) : []
        });
        break;
      }
      case 'nido:scroll': {
        this.pendingRedraw.push(['nido_scroll', args[0] as unknown[]]);
        break;
      }
      case 'nido:scroll_cache': {
        this.pendingRedraw.push(['nido_scroll_cache', args]);
        break;
      }
      case 'nido:edit': {
        this.pendingRedraw.push(['nido_edit', []]);
        break;
      }
      case 'nido:buffer': {
        this.pendingRedraw.push(['nido_buffer', args]);
        break;
      }
      case 'nido:completion_refresh': {
        this.sendToRenderer({
          type: 'redraw',
          id: this.workspaceId,
          events: [
            ['nido_completion_refresh', args],
            ['flush', []]
          ]
        });
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
        this.receiveMessage(args);
        break;
      }
      case 'redraw': {
        this.receiveRedraw(args as Redraw);
        break;
      }
      case 'nido:state': {
        this.receiveState(args[0] as Partial<SessionState>);
        break;
      }
      case 'nido:references': {
        const references = args[0] as NonNullable<SessionState['references']>;
        if (!Array.isArray(references.items)) {
          references.items = [];
        }
        references.items = this.hostPaths(references.items);
        this.state = { ...this.state, references };
        this.publishState();
        break;
      }
      case 'nido:symbols': {
        const symbols = args[0] as NonNullable<SessionState['symbols']>;
        if (!Array.isArray(symbols.items)) {
          symbols.items = [];
        }
        this.state = { ...this.state, symbols };
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

  /** Convert WSL paths in items to Windows host paths. */
  private hostPaths<T extends { path: string }>(items: T[]): T[] {
    const filePath = this.filePath;
    return filePath ? items.map((item) => ({ ...item, path: filePath(item.path) })) : items;
  }

  /** vim.notify messages become notifications; anything without a log level is an error. */
  private receiveMessage(args: unknown[]): void {
    const level = args[1];
    if (typeof level !== 'number') {
      this.sendToRenderer({ type: 'error', id: this.workspaceId, message: String(args[0]) });
      return;
    }
    // Neovim log levels: TRACE=0, DEBUG=1, INFO=2, WARN=3, ERROR=4.
    if (level < 2) {
      return;
    }
    this.sendToRenderer({
      type: 'notification',
      id: this.workspaceId,
      message: String(args[0]),
      title: typeof args[2] === 'string' ? args[2] : 'Nido',
      severity: level >= 4 ? 'error' : level === 3 ? 'warning' : 'info'
    });
  }

  /**
   * Command line, message and popup menu events update the native Nido UI. Grid events wait in
   * the pending frame, which is published at flush.
   */
  private receiveRedraw(events: Redraw): void {
    // Other events can contain Neovim Window handles, which cannot cross Electron IPC.
    for (const event of events) {
      if (/^(cmdline_|msg_|popupmenu_)/.test(event[0])) {
        for (const args of event.slice(1) as unknown[][]) {
          const next = applyNeovimUI(this.neovimUI, event[0], args);
          if (next !== this.neovimUI) {
            this.neovimUI = next;
            this.pendingUI = true;
          }
        }
      }
      if (!rendererGridEvents.has(event[0])) {
        continue;
      }
      this.pendingRedraw.push(event);
      // A repaint can span several RPC notifications. Never expose a partial frame.
      if (event[0] === 'flush' && !this.isBatchingScroll) {
        this.publishPendingRedraw();
      }
    }
  }

  /** Merge a partial state update from session.lua and publish it. */
  private receiveState(partial: Partial<SessionState>): void {
    const update = { ...partial };
    const filePath = this.filePath;
    if (filePath && Array.isArray(update.buffers)) {
      update.buffers = update.buffers.map((buffer) => ({
        ...buffer,
        name: filePath(buffer.name)
      }));
    }
    if (Array.isArray(update.problems)) {
      update.problems = this.hostPaths(update.problems);
    }
    if (filePath && update.diagnostics) {
      update.diagnostics = Object.fromEntries(
        Object.entries(update.diagnostics).map(([path, severity]) => [filePath(path), severity])
      );
    }
    this.state = {
      ...this.state,
      ...update,
      debug: this.state.debug,
      references: this.state.references,
      symbols: this.state.symbols
    };
    // MessagePack nil explicitly clears optional values in partial updates.
    if (this.state.scrollCursor === null) {
      this.state.scrollCursor = undefined;
    }
    if (this.state.lineEnding === null) {
      this.state.lineEnding = undefined;
    }
    // Lua encodes an empty table as a map rather than an array.
    if (!Array.isArray(this.state.buffers)) {
      this.state.buffers = [];
    }
    if (!Array.isArray(this.state.problems)) {
      this.state.problems = [];
    }
    this.publishState();
  }
}
