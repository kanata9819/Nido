import type { NidoEvent, Workspace } from '../../shared/types';
import type { SessionClient } from './sessionClient';
import type { SessionEvents } from './sessionEvents';

/**
 * Attaches Nido as Neovim's UI and keeps its size and focus up to date. Attach and resize
 * requests run in their own queue, in order.
 */
export class SessionUI {
	private attached = false;
	/** Whether Neovim should consider this UI focused; told to Neovim once attached. */
	private focused = false;
	private reportedFocus?: boolean;
	private uiQueue: Promise<void> = Promise.resolve();
	// Only the latest of several queued resizes is sent.
	private resizeGeneration = 0;

	constructor(
		private readonly client: SessionClient,
		private readonly events: SessionEvents,
		private readonly workspace: Workspace,
		private readonly emit: (event: NidoEvent) => void
	) {}

	/** Attach the UI at the given grid size, or reattach for a renderer that reloaded. */
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
				this.reportedFocus = undefined;
				this.reportFocus();
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

	/**
	 * Tell Neovim whether its workspace is the one in front, in a focused window. Neovim
	 * runs FocusGained and FocusLost from this, and checks on FocusGained whether open
	 * files changed on disk: without it, a file edited in another program kept its old
	 * text when the user came back.
	 */
	setFocus(focused: boolean): void {
		this.focused = focused;
		this.reportFocus();
	}

	/** Send the focus state to Neovim when it changed since it was last reported. */
	private reportFocus(): void {
		if (!this.attached || this.reportedFocus === this.focused) {
			return;
		}
		const focused = this.focused;
		this.reportedFocus = focused;
		// Not queued: while a command waits for its key, Neovim answers this after that key,
		// and attaching or resizing must not wait for it.
		this.client.request('nvim_ui_set_focus', [focused]).catch(() => {
			if (this.reportedFocus === focused) {
				this.reportedFocus = undefined;
			}
		});
	}

	/** Resize the grid. */
	async resize(columns: number, rows: number): Promise<void> {
		const generation = ++this.resizeGeneration;
		const next = this.uiQueue.then(async () => {
			if (this.attached && generation === this.resizeGeneration) {
				// Keep each window's first line in place (see before_resize in
				// resources/nido/lua/nido_scroll.lua). One atomic call, so no key runs between.
				const [, failure] = (await this.client.request('nvim_call_atomic', [
					[
						['nvim_exec_lua', [resizeScript('before_resize'), []]],
						['nvim_ui_try_resize', [columns, rows]],
						['nvim_exec_lua', [resizeScript('after_resize'), []]]
					]
				])) as [unknown[], [number, number, string] | null];
				if (failure) {
					// The calls after a failed one did not run; release the held frame.
					await this.client.request('nvim_exec_lua', [resizeScript('after_resize'), []]);
					throw new Error(failure[2]);
				}
			}
		});
		this.uiQueue = next.catch(() => {});
		return next;
	}
}

/** Call a resize hook of nido_scroll, when Neovim has loaded Nido's init.lua. */
function resizeScript(name: 'before_resize' | 'after_resize'): string {
	return `local ok, scroll = pcall(require, 'nido_scroll') if ok then scroll.${name}() end`;
}
