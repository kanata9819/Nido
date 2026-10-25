import type { Workspace } from '../shared/types';
import type { SessionClient } from './sessionClient';
import type { SessionEvents } from './sessionEvents';

/** Serialize input, saves and scrolling against the same editing anchor. */
export class SessionInteraction {
  private inputQueue: Promise<void> = Promise.resolve();
  private scrollDetached = false;
  private prefetchGeneration = 0;
  private prefetchCaches: unknown[] = [];
  private prefetchingStrip = false;

  constructor(
    private readonly client: SessionClient,
    private readonly events: SessionEvents,
    private readonly workspace: Workspace,
    private readonly isStopped: () => boolean
  ) {}

  private get stopped(): boolean {
    return this.isStopped();
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.inputQueue.then(operation);
    this.inputQueue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  input(keys: string): Promise<void> {
    // nvim_input can accept only part of a byte sequence when its input queue is full.
    const next = this.inputQueue.then(async () => {
      if (this.stopped) {
        throw new Error('Neovim session is closed.');
      }
      await this.restoreScroll();
      // Native completion bypasses insert mappings for Ctrl+N/P and inserts previews.
      if (
        !this.events.hasInputPrompt &&
        (keys === '<C-n>' || keys === '<C-p>') &&
        (await this.client.request('nvim_eval', ['pumvisible()']))
      ) {
        keys = keys === '<C-n>' ? '<Down>' : '<Up>';
      }
      if (this.workspace.kind === 'terminal' && !this.events.hasInputPrompt) {
        await this.client.request('nvim_command', ['startinsert']);
      }
      let remainingInput = Buffer.from(keys);
      while (remainingInput.length && !this.stopped) {
        const acceptedBytes = (await this.client.request('nvim_input', [
          remainingInput.toString()
        ])) as number;
        remainingInput = remainingInput.subarray(acceptedBytes);
        if (acceptedBytes === 0) {
          await new Promise((done) => setTimeout(done, 2));
        }
      }
    });
    this.inputQueue = next.catch(() => {});
    return next;
  }

  inputMode(): Promise<string> {
    // A deferred API request observes preceding input after Neovim has processed it.
    const next = this.inputQueue.then(async () => {
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
    this.inputQueue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  selectCompletion(index: number): Promise<void> {
    const next = this.inputQueue.then(async () => {
      await this.client.request('nvim_select_popupmenu_item', [index, false, false, {}]);
    });
    this.inputQueue = next.catch(() => {});
    return next;
  }

  click(row: number, column: number): Promise<void> {
    const next = this.inputQueue.then(async () => {
      this.events.beginScrollBatch();
      try {
        // Mouse coordinates refer to the visible viewport, not the pre-scroll editing anchor.
        await this.client.request('nvim_exec_lua', ["require('nido_scroll').restore(true)", []]);
        // Restore the keyboard cursor margin and pixel offset before the next input.
        this.scrollDetached = true;
        await this.client.request('nvim_input_mouse', ['left', 'press', '', 1, row, column]);
        await this.client.request('nvim_input_mouse', ['left', 'release', '', 1, row, column]);
        await this.client.request('nvim_eval', ['1']);
      } finally {
        this.events.endScrollBatch();
      }
    });
    this.inputQueue = next.catch(() => {});
    return next;
  }

  jumpSticky(window: number, buffer: number, line: number): Promise<void> {
    const next = this.inputQueue.then(async () => {
      this.events.beginScrollBatch();
      try {
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
    this.inputQueue = next.catch(() => {});
    return next;
  }

  paste(text: string | (() => Promise<string>)): Promise<void> {
    const next = this.inputQueue.then(async () => {
      if (this.stopped) {
        throw new Error('Neovim session is closed.');
      }
      // Reserve this position in the input queue before an asynchronous OS clipboard read.
      const content = typeof text === 'function' ? await text() : text;
      await this.restoreScroll();
      if (this.workspace.kind === 'terminal') {
        await this.client.request('nvim_command', ['startinsert']);
      }
      await this.client.request('nvim_paste', [content, true, -1]);
    });
    this.inputQueue = next.catch(() => {});
    return next;
  }

  async restoreScroll(): Promise<void> {
    if (!this.scrollDetached) {
      return;
    }
    await this.client.request('nvim_exec_lua', ["require('nido_scroll').restore()", []]);
    this.scrollDetached = false;
  }

  cancelPrefetch(): void {
    this.prefetchGeneration++;
    this.prefetchCaches = [];
  }

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

  async prefetchScroll(down = false): Promise<void> {
    const generation = this.prefetchGeneration;
    const side = down ? 1 : 0;
    let continuation: unknown;
    let first = true;
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
        if ((mode.mode !== 'n' && mode.mode !== 'i') || mode.blocking) {
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
  }

  async scroll(lines: number, follow = true, pixel = false): Promise<void> {
    if (!lines) {
      return;
    }
    const next = this.inputQueue.then(async () => {
      this.scrollDetached = true;
      this.events.beginScrollBatch();
      try {
        if (this.workspace.kind === 'terminal') {
          await this.client.request('nvim_command', ['stopinsert']);
        }
        const changed = await this.client.request('nvim_exec_lua', [
          "return require('nido_scroll').scroll(...)",
          [lines, follow, pixel]
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
    this.inputQueue = next.catch(() => {});
    return next;
  }

  write(command: 'write' | 'wall', format = false): Promise<void> {
    // Saving must follow committed input and precede any subsequently queued edits.
    const next = this.inputQueue.then(async () => {
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
    });
    this.inputQueue = next.then(
      () => {},
      () => {}
    );
    return next.then(({ writing }) => writing);
  }
}
