import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Session } from '../src/main/session/session';
import { Grid } from '../src/renderer/src/grid/grid';
import type { Redraw } from '../src/shared/types';
import { emptyNeovimUI, patchNeovimUI } from '../src/shared/neovimUI';

test('saving keeps the grid cursor still and viewport progress updates without Vim footer text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-save-cursor-'));
	let session: Session | undefined;
	const frames: Redraw[] = [];
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') frames.push(event.events);
		});
		await session.attach(80, 34);
		await session.openFile('lines.txt');
		await session.input('150Gzz');
		await session.client.request('nvim_eval', ['1']);
		const cursor = await session.client.request('nvim_eval', ['[winline()-1, wincol()-1]']);
		frames.length = 0;
		await session.save();
		await session.client.request('nvim_eval', ['1']);
		for (const frame of frames) {
			for (const [name, ...calls] of frame) {
				if (name === 'grid_cursor_goto') {
					for (const call of calls) assert.deepEqual(call.slice(1), cursor);
				}
			}
		}
		assert.equal(await session.client.request('nvim_eval', ['&ruler || &showcmd']), 0);
		assert.match(String(await session.client.request('nvim_eval', ['&shortmess'])), /F/);
		const middle = session.state.scrollPercent!;
		assert.ok(middle > 0 && middle < 100);
		await session.scroll(8, false, true);
		await new Promise((done) => setTimeout(done, 30));
		assert.ok(
			session.state.scrollPercent! > middle,
			'viewport progress follows scrolling while the edit anchor stays fixed'
		);
		await session.input('gg');
		await new Promise((done) => setTimeout(done, 30));
		assert.equal(session.state.scrollPercent, 0);
		await session.input('G');
		await new Promise((done) => setTimeout(done, 30));
		assert.equal(session.state.scrollPercent, 100);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('saving keeps the active file tab stable with multiple open buffers', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-save-tabs-'));
	let session: Session | undefined;
	const currents: number[] = [];
	try {
		await writeFile(join(root, 'other.rs'), 'fn other() {}\n');
		await writeFile(join(root, 'draft.rs'), 'fn main() {}\n');
		session = await Session.create(root, (event) => {
			if (
				(event.type === 'state' || event.type === 'statePatch') &&
				event.state.current !== undefined
			) {
				currents.push(event.state.current);
			}
		});
		await session.attach(80, 24);
		await session.openFile('other.rs');
		const other = (await session.client.request('nvim_eval', ['bufnr()'])) as number;
		await session.openFile('draft.rs');
		await session.inputMode();
		const current = session.state.current;
		currents.length = 0;
		for (let i = 0; i < 3; i++) {
			await session.input('A <Esc>');
			await session.save(false);
			await new Promise((done) => setTimeout(done, 100));
		}
		await session.client.request('nvim_exec_lua', [
			`local other = ...
vim.lsp.get_clients = function(opts)
  return opts and opts.method == 'textDocument/formatting' and {{}} or {}
end
vim.lsp.buf.format = function()
  vim.api.nvim_buf_call(other, function()
    vim.api.nvim_exec_autocmds('CursorMoved', {})
    vim.wait(60, function() return false end, 1)
  end)
end`,
			[other]
		]);
		await session.save(true);
		await new Promise((done) => setTimeout(done, 100));
		assert.ok(currents.length > 0);
		assert.ok(
			currents.every((buffer) => buffer === current),
			JSON.stringify(currents)
		);
		assert.equal(
			session.state.buffers.find((buffer) => buffer.id === current)?.modified,
			false
		);
		await session.client.request('nvim_exec_lua', ['vim.bo.readonly = true', []]);
		await assert.rejects(session.save(false), /readonly|E45/);
		await session.selectBuffer(other);
		await new Promise((done) => setTimeout(done, 100));
		assert.equal(session.state.current, other);
		assert.equal(
			currents.at(-1),
			other,
			'failed saves must not suppress subsequent tab changes'
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('save formats before writing only when enabled and a formatter is available', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-format-save-'));
	let session: Session | undefined;
	try {
		const path = join(root, 'sample.txt');
		await writeFile(path, 'original\n');
		session = await Session.create(root, () => {});
		await session.openFile('sample.txt');
		await session.client.request('nvim_exec_lua', [
			`local get_clients = vim.lsp.get_clients
vim.lsp.get_clients = function(opts)
  if opts and opts.bufnr == vim.api.nvim_get_current_buf() and opts.method == 'textDocument/formatting' then
    return { {} }
  end
  return get_clients(opts)
end
vim.lsp.buf.format = function(opts)
  assert(opts.bufnr == vim.api.nvim_get_current_buf() and opts.async == false and opts.timeout_ms == 3000)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {'formatted'})
end`,
			[]
		]);
		await session.save(false);
		assert.equal(await readFile(path, 'utf8'), 'original\n');
		await session.save(true);
		assert.equal(await readFile(path, 'utf8'), 'formatted\n');
		await session.client.request('nvim_exec_lua', [
			"vim.lsp.get_clients = function() return {} end; vim.api.nvim_buf_set_lines(0, 0, -1, false, {'no formatter'})",
			[]
		]);
		await session.save(true);
		assert.equal(await readFile(path, 'utf8'), 'no formatter\n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('save preserves the requested buffer when a formatter fails or changes the active buffer', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-format-recovery-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'draft.txt'), 'original\n');
		await writeFile(join(root, 'other.txt'), 'other file\n');
		session = await Session.create(root, () => {});
		await session.openFile('other.txt');
		const other = await session.client.request('nvim_get_current_buf', []);
		await session.openFile('draft.txt');
		await session.input('gg0Ckeep my draft<Esc>');
		await session.inputMode();
		await session.client.request('nvim_exec_lua', [
			`local other = ...
vim.lsp.get_clients = function(opts)
  return opts and opts.method == 'textDocument/formatting' and { {} } or {}
end
vim.lsp.buf.format = function() error('Formatter failed') end
vim.g.format_other = other`,
			[other]
		]);
		await assert.doesNotReject(session.save(true));
		assert.equal(await readFile(join(root, 'draft.txt'), 'utf8'), 'keep my draft\n');
		await session.input('gg0Csave the right file<Esc>');
		await session.inputMode();
		await session.client.request('nvim_exec_lua', [
			'vim.lsp.buf.format = function() vim.api.nvim_set_current_buf(vim.g.format_other) end',
			[]
		]);
		await session.save(true);
		assert.equal(await readFile(join(root, 'draft.txt'), 'utf8'), 'save the right file\n');
		assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other file\n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('EditorConfig reads CRLF files cleanly when the project requests LF', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-editorconfig-eol-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, '.editorconfig'), 'root = true\n[*]\nend_of_line = lf\n');
		const original = 'first\r\nsecond\r\n';
		await writeFile(join(root, 'dos.txt'), original);
		session = await Session.create(root, () => {});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.setEditorConfig(true);
		await session.openFile('dos.txt');
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'first',
			'second'
		]);
		assert.equal(await lua('return vim.bo.fileformat'), 'unix');
		assert.equal(await lua("return require('nido_eol').detect()"), 'LF');
		assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), original);
		await lua('vim.cmd.edit({bang=true})');
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'first',
			'second'
		]);
		await session.save();
		assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), 'first\nsecond\n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('EditorConfig keeps newly detected encoding and line endings after reloading a file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-editorconfig-reload-'));
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, '.editorconfig'),
			'root = true\n[*]\nindent_style = space\nindent_size = 2\n'
		);
		const path = join(root, 'sample.txt');
		await writeFile(path, 'before\n');
		session = await Session.create(root, () => {});
		await session.setEditorConfig(true);
		await session.openFile('sample.txt');
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		const replacements = [
			Buffer.from('\uFEFFafter\r\n'),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('unicode\r\n', 'utf16le')])
		];
		for (const [index, replacement] of replacements.entries()) {
			await writeFile(path, replacement);
			await lua('vim.cmd.edit({bang=true})');
			assert.deepEqual(
				await lua(
					'return {vim.bo.fileformat, vim.bo.fileencoding, vim.bo.bomb, vim.bo.shiftwidth}'
				),
				['dos', index === 0 ? 'utf-8' : 'utf-16le', true, 2]
			);
			await session.save();
			assert.deepEqual(await readFile(path), replacement);
		}
		await session.setEditorConfig(false);
		assert.deepEqual(
			await lua('return {vim.bo.fileformat, vim.bo.fileencoding, vim.bo.bomb}'),
			['dos', 'utf-16le', true]
		);
		await session.save();
		assert.deepEqual(await readFile(path), replacements[1]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('indentation is published and converts only leading whitespace', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-indentation-'));
	let session: Session | undefined;
	try {
		const original = 'fn main() {\n\tlet a = "\t";\n\t\tb();\n  \tc();\n}\n';
		await writeFile(join(root, 'main.rs'), original);
		session = await Session.create(root, () => {});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.openFile('main.rs');
		await lua('vim.bo.expandtab = false; vim.bo.tabstop = 4; vim.bo.shiftwidth = 0');
		assert.deepEqual(await lua("return require('nido_indentation').detect()"), {
			spaces: false,
			size: 4
		});

		await session.setIndentation({ spaces: true, size: 2 });
		assert.equal(await lua('return vim.bo.expandtab'), true);
		assert.equal(await lua('return vim.fn.shiftwidth()'), 2);
		assert.equal(await session.modified(), false, 'Changing settings leaves the text alone');
		const expected = { spaces: true, size: 2 };
		const signal = AbortSignal.timeout(5000);
		try {
			// The state notification is scheduled after the RPC response.
			while (!isDeepStrictEqual(session.state.indentation, expected)) {
				await once(session.client, 'notification', { signal });
			}
		} catch (error) {
			if (!signal.aborted) throw error;
			assert.deepEqual(session.state.indentation, expected, 'Indentation was not published');
		}

		// Tabs expand at the previous tab width; the tab inside the string stays.
		await session.setIndentation({ spaces: true, size: 4 }, true);
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'fn main() {',
			'    let a = "\t";',
			'        b();',
			'    c();',
			'}'
		]);
		await session.setIndentation({ spaces: false, size: 4 }, true);
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'fn main() {',
			'\tlet a = "\t";',
			'\t\tb();',
			'\tc();',
			'}'
		]);
		assert.equal(await lua('return vim.bo.tabstop'), 4);
		await assert.rejects(session.setIndentation({ spaces: true, size: 0 }));
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('converting indentation preserves the cursor on the same text and inside indentation', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-indent-cursor-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'sample.txt'), '\t猫 value\n');
		session = await Session.create(root, () => {});
		await session.openFile('sample.txt');
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		const column = (): Promise<unknown> => lua('return vim.api.nvim_win_get_cursor(0)[2]');
		await lua('vim.bo.tabstop=4; vim.api.nvim_win_set_cursor(0,{1,5})');
		await session.setIndentation({ spaces: true, size: 4 }, true);
		assert.equal(await column(), 8, 'The cursor should still be on the v in value.');
		await session.setIndentation({ spaces: false, size: 4 }, true);
		assert.equal(await column(), 5);

		await lua('vim.api.nvim_win_set_cursor(0,{1,0})');
		await session.setIndentation({ spaces: true, size: 4 }, true);
		assert.equal(await column(), 0, 'The start of the indentation should stay in place.');
		await lua('vim.api.nvim_win_set_cursor(0,{1,2})');
		await session.setIndentation({ spaces: false, size: 4 }, true);
		assert.equal(await column(), 0, 'The cursor should land on the tab covering its column.');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('converting indentation preserves the displayed width of variable-width tabs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-variable-indent-'));
	const path = join(root, 'sample.txt');
	let session: Session | undefined;
	try {
		await writeFile(path, '\tfirst\n\t\tsecond\n');
		session = await Session.create(root, () => {});
		await session.openFile('sample.txt');
		await session.client.request('nvim_exec_lua', [
			"vim.bo.tabstop = 8; vim.bo.vartabstop = '2,6'",
			[]
		]);
		await session.setIndentation({ spaces: true, size: 2 }, true);
		await session.save();
		assert.equal(await readFile(path, 'utf8'), '  first\n        second\n');

		await session.setIndentation({ spaces: false, size: 4 }, true);
		assert.equal(await session.client.request('nvim_eval', ['&l:vartabstop']), '');
		await session.save();
		assert.equal(await readFile(path, 'utf8'), '  first\n\t\tsecond\n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('EditorConfig toggles existing buffers, indentation guides and save rules', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-editorconfig-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, '.editorconfig'),
			'root = true\n[*]\nindent_style = space\nindent_size = 4\ntrim_trailing_whitespace = true\n[other.txt]\nindent_size = 8\n'
		);
		await writeFile(join(root, 'indent.txt'), 'root\n    child  \n        nested\n');
		await writeFile(join(root, 'other.txt'), '        other\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.openFile('indent.txt');
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		const baseline = await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}');
		await session.setEditorConfig(true);
		await session.client.request('nvim_eval', ['1']);
		assert.deepEqual(
			await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}'),
			[4, 4, true]
		);
		assert.equal(grid.cells[1].filter((cell) => cell.text === '│').length, 1);
		assert.equal(grid.cells[2].filter((cell) => cell.text === '│').length, 2);
		assert.equal(await lua('return vim.bo.modified'), false);
		await session.save();
		assert.equal(
			await readFile(join(root, 'indent.txt'), 'utf8'),
			'root\n    child\n        nested\n'
		);
		await session.openFile('other.txt');
		assert.equal(await lua('return vim.bo.shiftwidth'), 8);
		await session.setEditorConfig(false);
		await session.openFile('indent.txt');
		assert.deepEqual(
			await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}'),
			baseline
		);
		await lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, {'    child  '})");
		await session.save();
		assert.match(await readFile(join(root, 'indent.txt'), 'utf8'), /child {2}\n/);
		await session.setEditorConfig(true);
		await session.setEditorConfig(true);
		assert.equal(
			await lua(
				"return #vim.api.nvim_get_autocmds({group='nvim.editorconfig', event='BufWritePre', buffer=0})"
			),
			1
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('line endings normalize only in memory until saved, preserve content and support undo', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-eol-'));
	let session: Session | undefined;
	try {
		const original = 'one\r\ntwo\ninside\rcarriage\r\nlast';
		await writeFile(join(root, 'mixed.txt'), original);
		await writeFile(join(root, 'dos.txt'), 'one\r\ntwo\r\n');
		const notices: string[] = [];
		session = await Session.create(root, (event) => {
			if (event.type === 'error') notices.push(event.message);
		});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.openFile('mixed.txt');
		await lua('return 1');
		assert.equal(session.state.lineEnding, 'Mixed');
		assert.ok(notices.some((message) => message.includes('Mixed line endings')));
		await session.client.request('nvim_win_set_cursor', [0, [2, 1]]);
		await lua(`vim.g.eol_test_ns = vim.api.nvim_create_namespace('eol-test')
vim.g.eol_test_mark = vim.api.nvim_buf_set_extmark(0, vim.g.eol_test_ns, 2, 2, {})`);
		const mark = (): Promise<unknown> =>
			lua(
				'return vim.api.nvim_buf_get_extmark_by_id(0, vim.g.eol_test_ns, vim.g.eol_test_mark, {})'
			);
		await session.setLineEnding('LF');
		await lua('return 1');
		assert.equal(session.state.lineEnding, 'LF');
		assert.equal(await session.bufferModified(session.state.current), true);
		assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [2, 1]);
		assert.deepEqual(await mark(), [2, 2]);
		assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), original);
		await lua('vim.cmd.undo()');
		assert.equal(await lua("return require('nido_eol').detect()"), 'Mixed');
		assert.deepEqual(await mark(), [2, 2]);
		await session.setLineEnding('LF');
		await session.save();
		assert.equal(
			await readFile(join(root, 'mixed.txt'), 'utf8'),
			'one\ntwo\ninside\rcarriage\nlast'
		);
		await session.setLineEnding('CRLF');
		await session.save();
		assert.equal(
			await readFile(join(root, 'mixed.txt'), 'utf8'),
			'one\r\ntwo\r\ninside\rcarriage\r\nlast'
		);
		await session.openFile('dos.txt');
		await lua('return 1');
		assert.equal(session.state.lineEnding, 'CRLF');
		await session.setLineEnding('LF');
		assert.equal(await session.bufferModified(session.state.current), true);
		await session.save();
		assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), 'one\ntwo\n');
		await assert.rejects(session.setLineEnding('invalid' as 'LF'));
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("the current file's encoding is published, with its byte order mark", async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-encoding-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'plain.txt'), 'caf\u00e9\n');
		await writeFile(join(root, 'bom.txt'), '\ufeffhello\n');
		// é in Latin-1 is not valid UTF-8, so Neovim falls back to latin1.
		await writeFile(join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		session = await Session.create(root, () => {});
		const settle = (): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', ['return 1', []]);
		for (const [file, encoding] of [
			['plain.txt', 'utf-8'],
			['bom.txt', 'utf-8+bom'],
			['latin.txt', 'latin1']
		]) {
			await session.openFile(file);
			await settle();
			assert.equal(session.state.fileEncoding, encoding, file);
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('save and save all wait for pending committed input', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-save-input-order-'));
	try {
		for (const command of ['save', 'saveAll'] as const) {
			const file = join(root, 'file.txt');
			await writeFile(file, 'original\n');
			const session = await Session.create(root, () => {});
			let release!: () => void;
			let started!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const inputStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			try {
				await session.openFile('file.txt');
				const request = session.client.request.bind(session.client);
				session.client.request = async (name, args = []) => {
					if (name === 'nvim_input' && args[0] === 'i') {
						started();
						await gate;
					}
					return request(name, args);
				};
				const opening = session.input('i');
				await inputStarted;
				const text = session.input('日本語入力<Esc>');
				const saving = session[command]();
				// Let an incorrectly unqueued write reach Neovim before releasing input.
				await new Promise<void>((resolve) => setImmediate(resolve));
				await request('nvim_eval', ['1']);
				release();
				await Promise.all([opening, text, saving]);
				assert.equal(await readFile(file, 'utf8'), '日本語入力original\n', command);
			} finally {
				release();
				await session.stop();
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test(
	'saving while a Vim command waits for a key keeps subsequent input available',
	{ timeout: 10000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-save-pending-command-'));
		let session: Session | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await writeFile(join(root, 'file.txt'), 'original\n');
			session = await Session.create(root, () => {});
			await session.openFile('file.txt');
			await session.input('0r');
			assert.equal(await session.inputMode(), 'R');
			await Promise.race([
				Promise.all([session.save(), session.input('X<Esc>')]),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error('Saving blocked subsequent input.')),
						2000
					);
				})
			]);
			assert.equal(await session.client.request('nvim_get_current_line', []), 'Xriginal');
		} finally {
			clearTimeout(timer);
			await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
			await session?.stop();
			await rm(root, { recursive: true, force: true });
		}
	}
);

for (const command of ['save', 'saveAll'] as const) {
	for (const reply of ['n<CR>', '<Esc>', 'y<CR>']) {
		test(
			`${command} accepts ${reply} while an external file change awaits confirmation`,
			{ timeout: 10000 },
			async () => {
				const root = await mkdtemp(join(tmpdir(), 'nido-save-confirmation-'));
				const path = join(root, 'file.txt');
				let ui = emptyNeovimUI();
				let session: Session | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let release!: () => void;
				const ready = new Promise<void>((resolve) => {
					release = resolve;
				});
				try {
					await writeFile(path, 'original\n');
					session = await Session.create(root, (event) => {
						if (event.type === 'neovimUI') ui = event.state;
						if (event.type === 'neovimUIPatch') ui = patchNeovimUI(ui, event.state);
					});
					await session.openFile('file.txt');
					await session.input('gg0Cmy draft<Esc>');
					assert.equal(
						await session.client.request('nvim_get_current_line', []),
						'my draft'
					);
					await writeFile(path, 'external\n');
					const changed = new Date(Date.now() + 2000);
					await utimes(path, changed, changed);
					const request = session.client.request.bind(session.client);
					session.client.request = async (name, args = []) => {
						// Make the first fast mode probe precede the write's confirmation prompt.
						if (name === 'nvim_exec_lua') await ready;
						const result = await request(name, args);
						if (name === 'nvim_get_mode') release();
						return result;
					};
					const saving = session[command]().then(() => '', String);
					const hasPrompt = (): boolean =>
						Object.values(ui.commands).some((line) =>
							(line.prompt + line.content.map((chunk) => chunk[1]).join('')).includes(
								'Do you really want to write to it'
							)
						);
					for (let attempt = 0; attempt < 200 && !hasPrompt(); attempt++) {
						await new Promise((done) => setTimeout(done, 10));
					}
					assert.ok(hasPrompt(), JSON.stringify(ui));
					const promptMode = await session.client.request('nvim_get_mode', []);
					const [, error] = await Promise.race([
						Promise.all([
							session.inputMode().then((mode) => {
								assert.equal(mode, 'r?');
								return session!.input(reply);
							}),
							saving
						]),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error(
											`Confirmation reply was blocked by the save: ${JSON.stringify({ promptMode, commands: ui.commands })}`
										)
									),
								2000
							);
						})
					]);
					// The reply is typed input, and the prompt closes on the next completed redraw:
					// a single request can return first, so wait for it as for the prompt opening.
					for (let attempt = 0; attempt < 200 && hasPrompt(); attempt++) {
						await new Promise((done) => setTimeout(done, 10));
					}
					assert.ok(!hasPrompt(), 'answering or cancelling closes the prompt');
					const accepted = reply === 'y<CR>';
					if (accepted) assert.equal(error, '');
					assert.equal(
						await readFile(path, 'utf8'),
						accepted ? 'my draft\n' : 'external\n'
					);
					assert.equal(
						await session.client.request('nvim_get_current_line', []),
						'my draft'
					);
					assert.equal(
						await session.client.request('nvim_get_option_value', [
							'modified',
							{ buf: 0 }
						]),
						!accepted
					);
					await session.input('A!<Esc>');
					assert.equal(
						await session.client.request('nvim_get_current_line', []),
						'my draft!'
					);
				} finally {
					release();
					clearTimeout(timer);
					await session?.client.request('nvim_input', ['<Esc><C-c>']).catch(() => {});
					await session?.stop();
					await rm(root, {
						recursive: true,
						force: true,
						maxRetries: 5,
						retryDelay: 100
					});
				}
			}
		);
	}
}
