import type { Workspace } from '../shared/types';
import type { SessionClient } from './sessionClient';
import type { SessionEvents } from './sessionEvents';

/**
 * Everything the user does in the editor (keys, clicks, wheel scrolling, pastes, saves) goes
 * through one queue, so Neovim receives it in order.
 *
 * Wheel scrolling moves the viewport without moving the cursor ("detached" scrolling, see
 * nido_scroll.lua). The next key or command first restores the cursor's position so it
 * applies where the user was editing.
 */
export class SessionInteraction {
	private inputQueue: Promise<void> = Promise.resolve();
	// Whether the viewport was scrolled away from the cursor since the last restore.
	private scrollDetached = false;
	// Prefetching draws rows beyond the viewport ahead of scrolling. A new generation cancels the
	// running prefetch; `prefetchCaches` holds where each direction (up, down) can continue.
	private prefetchGeneration = 0;
	private prefetchDown?: boolean;
	private prefetchCaches: unknown[] = [];
	private prefetchingStrip = false;
	// Terminal copy mode, and a Ctrl+\ held to see whether Ctrl+N follows.
	private copyMode = false;
	private heldBackslash = false;

	constructor(
		private readonly client: SessionClient,
		private readonly events: SessionEvents,
		private readonly workspace: Workspace,
		private readonly isStopped: () => boolean
	) {}

	private get stopped(): boolean {
		return this.isStopped();
	}

	/** Run `operation` after everything queued earlier; a failure does not block later ones. */
	enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.inputQueue.then(operation);
		this.inputQueue = next.then(
			() => {},
			() => {}
		);
		return next;
	}

	/**
	 * Whether Neovim waits for the next key of a command, such as after r, g, z or Ctrl+W,
	 * or at a hit-enter prompt. Requests other than the fast API wait for that key, and
	 * the input queue holds every key behind them: the editor would stop responding.
	 */
	private async awaitingKey(): Promise<boolean> {
		const mode = (await this.client.request('nvim_get_mode', [])) as {
			mode: string;
			blocking: boolean;
		};
		return mode.blocking || mode.mode.startsWith('r');
	}

	/** Run a command from the UI (save, switch tab, ...). Refuses while a Neovim command waits for a key. */
	command<T>(operation: () => Promise<T>): Promise<T> {
		// Observe preceding keys before probing for commands that still need a reply.
		const ready = this.inputMode();
		return this.enqueue(async () => {
			await ready;
			if (await this.awaitingKey()) {
				throw new Error('Finish the current Neovim command before doing this.');
			}
			return operation();
		});
	}

	/** Send keys in Neovim's key notation. */
	input(keys: string): Promise<void> {
		// nvim_input can accept only part of a byte sequence when its input queue is full.
		return this.enqueue(async () => {
			if (this.stopped) {
				throw new Error('Neovim session is closed.');
			}
			await this.restoreScroll();
			const terminal = this.workspace.kind === 'terminal';
			if (terminal) {
				// Neovim's own Ctrl+\ Ctrl+N also enters copy mode. Hold Ctrl+\ until the
				// next key shows whether it starts that sequence.
				if (this.heldBackslash) {
					this.heldBackslash = false;
					if (keys === '<C-n>') {
						await this.startCopyMode();
						return;
					}
					keys = '<C-\\>' + keys;
				} else if (keys === '<C-\\>' && !this.copyMode) {
					this.heldBackslash = true;
					return;
				}
				if (this.copyMode && (keys === 'q' || keys === '<Esc>')) {
					await this.leaveCopyMode();
					return;
				}
			}
			// Native completion bypasses insert mappings for Ctrl+N/P and inserts previews.
			if (
				!this.events.hasInputPrompt &&
				(keys === '<C-n>' || keys === '<C-p>') &&
				// A pending command, such as r or Ctrl+V, takes Ctrl+N itself.
				!(await this.awaitingKey()) &&
				(await this.client.request('nvim_eval', ['pumvisible()']))
			) {
				keys = keys === '<C-n>' ? '<Down>' : '<Up>';
			}
			// Keys go to the shell, except in copy mode, where they move and select.
			if (terminal && !this.copyMode && !this.events.hasInputPrompt) {
				await this.client.request('nvim_command', ['startinsert']);
			}
			let remainingInput = Buffer.from(keys);
			// Neovim takes input byte by byte and can stop inside a UTF-8 character. Decoding
			// the rest would turn its continuation bytes into U+FFFD, so later attempts send
			// the bytes themselves; msgpack binary is accepted as a String.
			let payload: string | Buffer = keys;
			while (remainingInput.length && !this.stopped) {
				const acceptedBytes = (await this.client.request('nvim_input', [
					payload
				])) as number;
				remainingInput = remainingInput.subarray(acceptedBytes);
				payload = remainingInput;
				if (acceptedBytes === 0) {
					await new Promise((done) => setTimeout(done, 2));
				}
			}
			// i, a or a yank (which returns to the shell) leave copy mode from Neovim's side.
			if (terminal && this.copyMode) {
				const mode = (await this.client.request('nvim_eval', ['mode(1)'])) as string;
				if (mode.startsWith('t')) {
					this.setCopyMode(false);
				}
			}
		});
	}

	/** Whether the terminal is in copy mode: keys move and select instead of reaching the shell. */
	get inCopyMode(): boolean {
		return this.copyMode;
	}

	/** Enter copy mode in a terminal: leave terminal input for Normal mode in its buffer. */
	enterCopyMode(): Promise<void> {
		return this.enqueue(async () => {
			this.heldBackslash = false;
			await this.startCopyMode();
		});
	}

	/** Leave terminal input for Normal mode, so Vim motions, v and y work on the output. */
	private async startCopyMode(): Promise<void> {
		if (this.stopped || this.workspace.kind !== 'terminal' || this.copyMode) {
			return;
		}
		await this.client.request('nvim_command', ['stopinsert']);
		// Leaving terminal mode completes when Neovim next processes input.
		await this.client.request('nvim_eval', ['1']);
		this.setCopyMode(true);
	}

	/** Return from copy mode to the shell. */
	private async leaveCopyMode(): Promise<void> {
		await this.client.request('nvim_command', ['startinsert']);
		this.setCopyMode(false);
	}

	/** Forget copy mode, for example when the shell restarts in a new terminal buffer. */
	forgetCopyMode(): void {
		this.heldBackslash = false;
		this.setCopyMode(false);
	}

	private setCopyMode(enabled: boolean): void {
		if (this.copyMode !== enabled) {
			this.copyMode = enabled;
			this.events.updateState({ copyMode: enabled });
		}
	}

	/** Neovim's mode after every queued key has been processed, or 'pending' while it waits for a key. */
	inputMode(): Promise<string> {
		// A deferred API request observes preceding input after Neovim has processed it.
		return this.enqueue(async () => {
			if (this.stopped) {
				throw new Error('Neovim session is closed.');
			}
			let completed = false;
			let result = '';
			let failure: unknown;
			const deferred = this.client.request('nvim_eval', ['mode(1)']).then(
				(value) => {
					result = value as string;
					completed = true;
				},
				(error) => {
					failure = error;
					completed = true;
				}
			);
			while (!completed) {
				// A deferred request cannot finish while r/f/getchar waits for its next key.
				// The fast API stays available; let that key through instead of deadlocking.
				const mode = (await this.client.request('nvim_get_mode', [])) as {
					mode: string;
					blocking: boolean;
				};
				// Reply prompts (r/rm/r?) can report blocking=false.
				if (mode.blocking || mode.mode.startsWith('r')) {
					return mode.mode === 'n' ? 'pending' : mode.mode;
				}
				if (!completed) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
			await deferred;
			if (failure) {
				throw failure;
			}
			return result;
		});
	}

	/** Select an item of the completion menu. */
	selectCompletion(index: number): Promise<void> {
		return this.enqueue(async () => {
			// Ctrl+R or Ctrl+V can wait for a key while the completion menu is open.
			if (await this.awaitingKey()) {
				return;
			}
			await this.client.request('nvim_select_popupmenu_item', [index, false, false, {}]);
		});
	}

	/** A left click at a grid cell of the visible viewport. */
	click(row: number, column: number): Promise<void> {
		return this.enqueue(async () => {
			this.events.beginScrollBatch();
			try {
				// A click would complete a pending command: g then a click is g<LeftMouse>.
				if (await this.awaitingKey()) {
					return;
				}
				// Mouse coordinates refer to the visible viewport, not the pre-scroll editing anchor.
				await this.client.request('nvim_exec_lua', [
					"require('nido_scroll').restore(true)",
					[]
				]);
				// Restore the keyboard cursor margin and pixel offset before the next input.
				this.scrollDetached = true;
				await this.client.request('nvim_input_mouse', [
					'left',
					'press',
					'',
					1,
					row,
					column
				]);
				await this.client.request('nvim_input_mouse', [
					'left',
					'release',
					'',
					1,
					row,
					column
				]);
				await this.client.request('nvim_eval', ['1']);
			} finally {
				this.events.endScrollBatch();
			}
		});
	}

	/** Jump to a scope header that sticky scroll shows. */
	jumpSticky(window: number, buffer: number, line: number): Promise<void> {
		return this.enqueue(async () => {
			this.events.beginScrollBatch();
			try {
				if (await this.awaitingKey()) {
					return;
				}
				const moved = await this.client.request('nvim_exec_lua', [
					"return require('nido_sticky').jump(...)",
					[window, buffer, line]
				]);
				if (moved) {
					this.scrollDetached = false;
				}
				await this.client.request('nvim_eval', ['1']);
			} finally {
				this.events.endScrollBatch();
			}
		});
	}

	/** Paste text, or text read from the clipboard once it is this paste's turn. */
	paste(text: string | (() => Promise<string>)): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) {
				throw new Error('Neovim session is closed.');
			}
			// Reserve this position in the input queue before an asynchronous OS clipboard read.
			const content = typeof text === 'function' ? await text() : text;
			// The pasted text would complete the command instead: after g, "x" would run gx.
			if (await this.awaitingKey()) {
				throw new Error('Finish the current Neovim command before pasting.');
			}
			await this.restoreScroll();
			if (this.workspace.kind === 'terminal') {
				// Pasting goes to the shell, so it ends copy mode.
				await this.client.request('nvim_command', ['startinsert']);
				this.setCopyMode(false);
			}
			await this.client.request('nvim_paste', [content, true, -1]);
		});
	}

	/** Return a scrolled-away viewport to the cursor, so the next action applies there. */
	async restoreScroll(): Promise<void> {
		if (!this.scrollDetached) {
			return;
		}
		await this.client.request('nvim_exec_lua', ["require('nido_scroll').restore()", []]);
		this.scrollDetached = false;
	}

	/** Stop prefetching and forget where it would continue, for example after switching files. */
	cancelPrefetch(): void {
		this.prefetchGeneration++;
		this.prefetchDown = undefined;
		this.prefetchCaches = [];
	}

	/**
	 * Called for every grid_scroll redraw event. Scrolling that the prefetch did not cause makes
	 * its continuation hints invalid.
	 */
	observeScroll(args: unknown[]): void {
		if (this.prefetchingStrip) {
			return;
		}
		const [, top, bottom, left, , rows, columns] = args as number[];
		if (top !== 0 || left !== 0 || columns !== 0 || Math.abs(rows) >= bottom - top) {
			this.prefetchCaches = [];
		} else if (rows) {
			// The growing side may trim its far edge at the renderer's cache limit.
			// The consumed side stays a valid, conservative continuation hint.
			this.prefetchCaches[rows < 0 ? 1 : 0] = undefined;
		}
	}

	/** Draw rows below (`down`) or above the viewport in strips, until Neovim has no more. */
	async prefetchScroll(down = false): Promise<void> {
		const generation = ++this.prefetchGeneration;
		this.prefetchDown = down;
		const side = down ? 1 : 0;
		let continuation: unknown;
		let first = true;
		try {
			do {
				// Each strip restores Neovim's viewport. Let queued input and IPC run
				// before reserving the queue for more speculative rows.
				await new Promise((resolve) => setTimeout(resolve, 0));
				continuation = await this.enqueue(async () => {
					if (this.stopped || generation !== this.prefetchGeneration) {
						return;
					}
					// This fast RPC remains available while Neovim waits for the rest of a command.
					const mode = (await this.client.request('nvim_get_mode', [])) as {
						mode: string;
						blocking: boolean;
					};
					if (
						generation !== this.prefetchGeneration ||
						(mode.mode !== 'n' && mode.mode !== 'i') ||
						mode.blocking
					) {
						return;
					}
					if (first) {
						// Flush preceding keyboard movement before trusting a cached extent.
						// nvim_get_mode is fast and can precede its viewport notification.
						if (this.prefetchCaches[side]) {
							await this.client.request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
						}
						continuation = this.prefetchCaches[side];
						first = false;
						if (generation !== this.prefetchGeneration) {
							return;
						}
					}
					this.prefetchingStrip = true;
					this.events.beginScrollBatch();
					try {
						const next = await this.client.request('nvim_exec_lua', [
							"return require('nido_scroll').prefetch(...)",
							continuation ? [down, continuation] : [down]
						]);
						await this.client.request('nvim_eval', ['1']);
						if (next && generation === this.prefetchGeneration) {
							this.prefetchCaches[side] = next;
						}
						return next;
					} finally {
						this.events.endScrollBatch();
						this.prefetchingStrip = false;
					}
				});
			} while (continuation && generation === this.prefetchGeneration);
		} finally {
			if (generation === this.prefetchGeneration) {
				this.prefetchDown = undefined;
			}
		}
	}

	/**
	 * Scroll the viewport by `lines` (fractional with `pixel`) and `columns`. `follow` lets the
	 * cursor follow the viewport.
	 */
	async scroll(lines: number, follow = true, pixel = false, columns = 0): Promise<void> {
		if (!lines && !columns) {
			return;
		}
		if (columns) {
			this.cancelPrefetch();
		}
		const down = lines > 0;
		if (lines && this.prefetchDown !== undefined && this.prefetchDown !== down) {
			// Finish the current strip, then refill in the gesture's new direction.
			this.prefetchGeneration++;
			this.prefetchDown = undefined;
		}
		return this.enqueue(async () => {
			// Batch from the start: a redraw that arrives while Neovim answers must not be
			// published alone, ahead of the grid it belongs with.
			this.events.beginScrollBatch();
			try {
				// Ignore the wheel while a command waits for its key.
				if (await this.awaitingKey()) {
					return;
				}
				this.scrollDetached = true;
				if (this.workspace.kind === 'terminal') {
					await this.client.request('nvim_command', ['stopinsert']);
				}
				const changed = await this.client.request('nvim_exec_lua', [
					"return require('nido_scroll').scroll(...)",
					[lines, follow, pixel, columns]
				]);
				// Neovim emits cursor/WinScrolled updates when the Lua request returns to its event loop.
				// Pure fractional offsets have no editor updates to wait for.
				if (changed) {
					await this.client.request('nvim_eval', ['1']);
				}
			} finally {
				// Publish the grid, fractional offset and anchored cursor as one frame, even for sub-line deltas.
				this.events.endScrollBatch();
			}
		});
	}

	/**
	 * Save the current buffer (`write`) or all buffers (`wall`), formatting first with `format`.
	 * Resolves when the save finished. The queue is released early if Neovim asks a question
	 * (such as whether to overwrite), so the user's answer can reach it.
	 */
	write(command: 'write' | 'wall', format = false): Promise<void> {
		// Saving must follow committed input and precede any subsequently queued edits.
		return this.enqueue(async () => {
			if (this.stopped) {
				throw new Error('Neovim session is closed.');
			}
			await this.restoreScroll();
			let completed = false;
			const writing = this.client
				.request('nvim_exec_lua', [
					`local command, format = ...
local buffer = vim.api.nvim_get_current_buf()
local formatting_failed = false
local saving = vim.g.nido_saving
vim.g.nido_saving = true
local ok, err = pcall(function()
  if format and #vim.lsp.get_clients({bufnr=buffer, method='textDocument/formatting'}) > 0 then
    -- Formatting is optional: its failure must not discard a requested save.
    formatting_failed = not pcall(vim.lsp.buf.format, {bufnr=buffer, async=false, timeout_ms=3000})
  end
  if command == 'write' then
    -- An LSP wait can run callbacks that switch buffers. Keep the original target.
    vim.api.nvim_buf_call(buffer, function()
      vim.cmd({cmd=command, mods={silent=true}})
    end)
  else
    vim.cmd({cmd=command, mods={silent=true}})
  end
end)
vim.g.nido_saving = saving
vim.api.nvim_exec_autocmds('User', {pattern='NidoSaved'})
if ok and formatting_failed then
  vim.notify('Formatting failed. Your edits were saved without formatting.', vim.log.levels.WARN, {title='Format on save'})
end
return ok and "" or tostring(err)`,
					[command, format]
				])
				.then((error) => {
					if (error) {
						throw new Error(error as string);
					}
				})
				.finally(() => {
					completed = true;
				});
			// A confirmation can appear after the first fast probe; keep checking so
			// its reply can bypass the pending write without reordering ordinary edits.
			void writing.catch(() => {});
			while (!completed) {
				const mode = (await this.client.request('nvim_get_mode', [])) as {
					mode: string;
					blocking: boolean;
				};
				if (mode.blocking || mode.mode.startsWith('r')) {
					break;
				}
				if (!completed) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			return { writing };
		}).then(({ writing }) => writing);
	}
}
