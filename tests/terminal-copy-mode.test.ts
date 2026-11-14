import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import { clipboardWriter } from '../src/main/clipboardWriter';
import type { NidoEvent, SessionState } from '../src/shared/types';

const shell = process.platform === 'win32' ? 'cmd.exe' : 'auto';

/** The copy mode the session last reported to the renderer. */
function reportedCopyMode(events: NidoEvent[], id: string): boolean | undefined {
	let copyMode: boolean | undefined;
	for (const event of events) {
		if ((event.type === 'state' || event.type === 'statePatch') && event.id === id) {
			const state = event.state as Partial<SessionState>;
			if ('copyMode' in state) {
				copyMode = state.copyMode;
			}
		}
	}
	return copyMode;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100 && !check(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(check(), message);
}

test(
	'terminal copy mode selects output with Vim keys, copies it and returns to the shell',
	{ timeout: 60000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-copy-mode-'));
		const events: NidoEvent[] = [];
		const copied: string[] = [];
		const write = clipboardWriter.write;
		clipboardWriter.write = async (text) => void copied.push(text);
		let owner: Session | undefined;
		try {
			owner = await Session.create(root, (event) => events.push(event));
			const terminal = await owner.openTerminal(shell);
			const id = terminal.workspace.id;
			await terminal.input('echo nido-copy-marker<CR>');
			const marker = async (): Promise<boolean> =>
				(
					(await terminal.client.request('nvim_exec_lua', [
						"return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')",
						[]
					])) as string
				).includes('nido-copy-marker');
			for (let attempt = 0; attempt < 100 && !(await marker()); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(await marker(), 'the shell printed the marker');

			// Ctrl+Shift+C: keys now move in the output instead of reaching the shell. Normal mode
			// in a terminal buffer is reported as nt.
			await terminal.enterCopyMode();
			assert.equal(await terminal.inputMode(), 'nt');
			await waitFor(() => reportedCopyMode(events, id) === true, 'copy mode is shown');
			await terminal.input('gg');
			await terminal.input('/nido-copy-marker<CR>');
			assert.equal(await terminal.inputMode(), 'nt', 'search keys did not reach the shell');

			// v and y select and copy; the yank returns to the shell.
			await terminal.input('v');
			await terminal.input('E');
			await terminal.input('y');
			await waitFor(() => copied.length === 1, 'the selection reached the clipboard');
			assert.equal(copied[0], 'nido-copy-marker');
			await waitFor(() => reportedCopyMode(events, id) === false, 'copy mode ends');
			assert.equal(await terminal.inputMode(), 't');

			// Neovim's own Ctrl+\ Ctrl+N enters copy mode too, and q leaves it.
			await terminal.input('<C-\\>');
			await terminal.input('<C-n>');
			assert.equal(await terminal.inputMode(), 'nt');
			assert.equal(reportedCopyMode(events, id), true);
			await terminal.input('q');
			assert.equal(await terminal.inputMode(), 't');
			assert.equal(reportedCopyMode(events, id), false);

			// Ctrl+\ followed by another key still reaches the shell as both keys.
			await terminal.input('<C-\\>');
			await terminal.input('x');
			assert.equal(await terminal.inputMode(), 't');
			assert.deepEqual(
				events.filter((event) => event.type === 'error'),
				[]
			);
		} finally {
			clipboardWriter.write = write;
			await owner?.stop();
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}
);
