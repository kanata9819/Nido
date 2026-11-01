import type { NidoEvent, Workspace } from '../shared/types';
import type { SessionClient } from './sessionClient';
import type { SessionEvents } from './sessionEvents';

export class SessionUI {
  private attached = false;
  private uiQueue: Promise<void> = Promise.resolve();
  private resizeGeneration = 0;

  constructor(
    private readonly client: SessionClient,
    private readonly events: SessionEvents,
    private readonly workspace: Workspace,
    private readonly emit: (event: NidoEvent) => void
  ) {}

  async attach(columns: number, rows: number): Promise<void> {
    const next = this.uiQueue.then(async () => {
      if (this.attached) {
        // A new renderer missed startup highlight definitions. Reattach the UI
        // so Neovim resends all colors and grid state, not just changed cells.
        await this.client.request('nvim_ui_detach', []);
        this.attached = false;
      }
      try {
        await this.client.request('nvim_ui_attach', [
          columns,
          rows,
          {
            rgb: true,
            ext_linegrid: true,
            ext_popupmenu: true,
            ext_hlstate: true,
            ext_messages: true,
            ext_cmdline: true
          }
        ]);
        // Preserve the viewport's bottom inset and pixel-scroll overscan. All
        // command text and messages are external even with cmdheight=1.
        await this.client.request('nvim_set_option_value', ['cmdheight', 1, {}]);
        this.attached = true;
        this.events.replayUI();
        this.emit({ type: 'state', id: this.workspace.id, state: this.events.state });
      } catch (error) {
        this.attached = false;
        throw error;
      }
    });
    this.uiQueue = next.catch(() => {});
    return next;
  }

  async resize(columns: number, rows: number): Promise<void> {
    const generation = ++this.resizeGeneration;
    const next = this.uiQueue.then(async () => {
      if (this.attached && generation === this.resizeGeneration) {
        await this.client.request('nvim_ui_try_resize', [columns, rows]);
      }
    });
    this.uiQueue = next.catch(() => {});
    return next;
  }
}
