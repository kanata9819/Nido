import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';

test('clipboard sharing switches Vim yank, delete and paste between private and system registers', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-clipboard-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		// Exercise the real Vim provider contract without replacing the user's OS clipboard.
		await lua(`
      vim.g.test_clipboard = {{'outside'}, 'V'}
      local copy = function(lines, kind) vim.g.test_clipboard = {lines, kind} end
      local paste = function() return vim.g.test_clipboard end
      vim.g.clipboard = {name='test', copy={['+']=copy, ['*']=copy}, paste={['+']=paste, ['*']=paste}, cache_enabled=0}
      vim.api.nvim_buf_set_lines(0, 0, -1, false, {'first', 'second'})
    `);
		await session.setClipboardSharing(false);
		await lua('vim.cmd("normal! ggyy")');
		assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['outside']);
		await session.setClipboardSharing(true);
		await lua('vim.cmd("normal! ggyy")');
		assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['first', '']);
		await lua('vim.cmd("normal! jdd")');
		assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['second', '']);
		await lua(`vim.g.test_clipboard = {{'pasted'}, 'V'}; vim.cmd('normal! p')`);
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'first',
			'pasted'
		]);
		await session.setClipboardSharing(false);
		await lua(
			`vim.cmd('normal! ggyy'); vim.g.test_clipboard = {{'outside again'}, 'V'}; vim.cmd('normal! p')`
		);
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
			'first',
			'first',
			'pasted'
		]);
		assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['outside again']);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Tab, Shift Tab and Backspace respect indentation and preserve selected lines', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-indent-keys-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	try {
		for (const [width, spaces] of [
			[2, true],
			[4, true],
			[4, false]
		] as const) {
			await session.input('<Esc>');
			await lua(`vim.bo.shiftwidth=${width}; vim.bo.tabstop=${width}; vim.bo.expandtab=${spaces}
vim.api.nvim_buf_set_lines(0,0,-1,false,{''}); vim.api.nvim_win_set_cursor(0,{1,0})`);
			const indent = spaces ? ' '.repeat(width) : '\t';
			await session.input('i<Tab><Tab><BS>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), indent);
			await session.input('<Tab><S-Tab>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), indent);
			await session.input('日本語<BS>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), indent + '日本');
		}
		await session.input('<Esc>');
		await lua(`vim.bo.shiftwidth=4; vim.bo.tabstop=4; vim.bo.expandtab=true
vim.fn.setreg('"', 'keep clipboard')
vim.api.nvim_buf_set_lines(0,0,-1,false,{'one','    日本語','last'})`);
		await session.input('ggVj<Tab>');
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0,0,-1,false)'), [
			'    one',
			'        日本語',
			'last'
		]);
		assert.equal(await lua('return vim.fn.mode()'), 'V');
		await session.input('<S-Tab>');
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0,0,-1,false)'), [
			'one',
			'    日本語',
			'last'
		]);
		assert.equal(await lua('return vim.fn.mode()'), 'V');
		assert.equal(await lua("return vim.fn.getreg('\"')"), 'keep clipboard');
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Home moves to the first non-blank character, then to the start of the line', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-smart-home-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	const cursor = async (): Promise<unknown> => await lua('return vim.api.nvim_win_get_cursor(0)');
	try {
		await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, {'    foo'})
vim.api.nvim_win_set_cursor(0, {1, 6})`);
		await session.input('<Home>');
		assert.deepEqual(await cursor(), [1, 4]);
		await session.input('<Home>');
		assert.deepEqual(await cursor(), [1, 0]);
		await session.input('<Home>');
		assert.deepEqual(await cursor(), [1, 4]);
		await session.input('Abar<Home>x');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '    xfoobar');
		await session.input('<Home><Home>y');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'y    xfoobar');
		// Each Home starts a new undo step, as the built-in key does.
		await session.input('<Esc>u');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '    xfoobar');
		await session.input('u');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '    foobar');
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Alt Up and Alt Down move the current or selected lines in every mode', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-move-lines-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	const lines = async (): Promise<unknown> =>
		await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)');
	try {
		await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, {'one', 'two', 'three', 'four'})
vim.api.nvim_win_set_cursor(0, {1, 1})`);
		await session.input('<M-Down>');
		assert.deepEqual(await lines(), ['two', 'one', 'three', 'four']);
		assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [2, 1]);
		await session.input('<M-Up><M-Up>');
		assert.deepEqual(await lines(), ['one', 'two', 'three', 'four']);
		await session.input('a<M-Down>X');
		assert.deepEqual(await lines(), ['two', 'onXe', 'three', 'four']);
		assert.equal(await lua('return vim.fn.mode()'), 'i');
		await session.input('<Esc>Vj<M-Down>');
		assert.deepEqual(await lines(), ['two', 'four', 'onXe', 'three']);
		assert.equal(await lua('return vim.fn.mode()'), 'V');
		// The selection follows the moved lines.
		await session.input('d');
		assert.deepEqual(await lines(), ['two', 'four']);
		await session.input('u');
		assert.deepEqual(await lines(), ['two', 'four', 'onXe', 'three']);
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Alt Shift Up and Alt Shift Down copy the current or selected lines', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-copy-lines-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	const lines = async (): Promise<unknown> =>
		await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)');
	try {
		await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, {'one', 'two', 'three'})
vim.api.nvim_win_set_cursor(0, {1, 1})`);
		await session.input('<M-S-Down>');
		assert.deepEqual(await lines(), ['one', 'one', 'two', 'three']);
		assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [2, 1]);
		await session.input('u<M-S-Up>');
		assert.deepEqual(await lines(), ['one', 'one', 'two', 'three']);
		assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [1, 1]);
		await session.input('u');
		// The selection stays on the copy in the direction of the key.
		await session.input('jVj<M-S-Down>');
		assert.deepEqual(await lines(), ['one', 'two', 'three', 'two', 'three']);
		assert.equal(await lua('return vim.fn.mode()'), 'V');
		await session.input('<Esc>');
		assert.deepEqual(await lua('return {vim.fn.line("\'<"), vim.fn.line("\'>")}'), [4, 5]);
		await session.input('4G0ia<M-S-Up>X');
		assert.equal(await lua('return vim.fn.mode()'), 'i');
		assert.deepEqual(await lines(), ['one', 'two', 'three', 'aXtwo', 'atwo', 'three']);
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Ctrl Enter and Ctrl Shift Enter open a line without splitting the current one', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-insert-line-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	try {
		for (const [keys, expected] of [
			['<C-CR>', ['  abc', '  x', 'end']],
			['<C-S-CR>', ['  x', '  abc', 'end']]
		] as const) {
			await session.input('<Esc>');
			await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, {'  abc', 'end'})
vim.api.nvim_win_set_cursor(0, {1, 3})`);
			await session.input(`i${keys}x`);
			assert.deepEqual(
				await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'),
				expected
			);
			assert.equal(await lua('return vim.fn.mode()'), 'i');
		}
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Ctrl Backspace and Ctrl Delete remove words in insert mode', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-word-delete-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	try {
		for (const [line, column, keys, expected] of [
			['foo bar', 7, '<C-BS>', ['foo ', '  b']],
			['foo bar', 0, '<C-Del>', [' bar', '  b']],
			['foo bar', 3, '<C-Del>', ['foo', '  b']],
			['foo.bar', 1, '<C-Del>', ['f.bar', '  b']],
			['x 日本語 y', 1, '<C-Del>', ['x y', '  b']],
			['e\u0301+x', 0, '<C-Del>', ['+x', '  b']],
			// At the end of a line, Ctrl+Delete joins the next one.
			['a', 1, '<C-Del>', ['a  b']]
		] as const) {
			await session.input('<Esc>');
			await lua(`vim.fn.setreg('"', 'keep')
vim.api.nvim_buf_set_lines(0, 0, -1, false, {'${line}', '  b'})
vim.api.nvim_win_set_cursor(0, {1, ${column}})`);
			await session.input(`${column === line.length ? 'A' : 'i'}${keys}`);
			assert.deepEqual(
				await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'),
				expected,
				`${line} ${keys}`
			);
			assert.equal(await lua("return vim.fn.getreg('\"')"), 'keep');
		}
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Ctrl slash toggles language comments on the current line and selected lines', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-comment-keys-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	try {
		for (const [filetype, prefix] of [
			['typescript', '//'],
			['python', '#'],
			['lua', '--']
		]) {
			await session.input('<Esc>');
			await lua(`vim.bo.filetype='${filetype}'
vim.api.nvim_buf_set_lines(0,0,-1,false,{'  first()','  second()','last()'})
vim.api.nvim_win_set_cursor(0,{1,2})`);
			await session.input('<C-/>');
			assert.equal(
				await lua('return vim.api.nvim_get_current_line()'),
				`  ${prefix} first()`,
				filetype
			);
			await session.input('<C-/>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), '  first()');
			await session.input('I<C-/>');
			assert.equal(
				await lua('return vim.api.nvim_get_current_line()'),
				`  ${prefix} first()`
			);
			assert.equal(await lua('return vim.fn.mode()'), 'i');
			// The cursor stays on the same text as the marker is added and removed.
			await session.input('<C-/>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), '  first()');
			await session.input('<Esc>0f(i<C-/>X');
			assert.equal(
				await lua('return vim.api.nvim_get_current_line()'),
				`  ${prefix} firstX()`
			);
			await session.input('<BS><C-/>Y');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), '  firstY()');
			await session.input('<BS>');
			await session.input('<Esc>ggVj<C-/>');
			assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0,0,-1,false)'), [
				`  ${prefix} first()`,
				`  ${prefix} second()`,
				'last()'
			]);
			await session.input('ggVj<C-/>');
			assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0,0,-1,false)'), [
				'  first()',
				'  second()',
				'last()'
			]);
		}
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Ctrl G opens the command line to jump to a line, without a range from its count', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-goto-line-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'a', 'b', 'c', 'd', 'e'})");
		for (const count of ['', '2']) {
			await session.input(`gg${count}<C-g>`);
			assert.deepEqual(
				await lua('return {vim.fn.mode(), vim.fn.getcmdtype(), vim.fn.getcmdline()}'),
				['c', ':', '']
			);
			await session.input('4<CR>');
			assert.deepEqual(await lua('return {vim.fn.mode(), vim.fn.line(".")}'), ['n', 4]);
		}
		// The command palette leaves Insert mode first, where Ctrl+G is a prefix key.
		await session.input('ggi<C-\\><C-n><C-g>');
		assert.deepEqual(
			await lua('return {vim.fn.mode(), vim.fn.getcmdtype(), vim.fn.getcmdline()}'),
			['c', ':', '']
		);
		await session.input('5<CR>');
		assert.deepEqual(await lua('return {vim.fn.mode(), vim.fn.line(".")}'), ['n', 5]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('pasting, deleting and undoing many lines does not report the line count', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-report-'));
	let session: Session | undefined;
	try {
		// Messages reach the UI as Neovim UI state; keep everything that is shown.
		const shown: string[] = [];
		session = await Session.create(root, (event) => {
			if (event.type === 'neovimUI' || event.type === 'neovimUIPatch') {
				shown.push(JSON.stringify(event.state));
			}
		});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'1', '2', '3', '4', '5', '6'})");
		await session.input('ggyGGp');
		await session.input('gg6dd');
		await session.input('u');
		await lua('return 1');
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(await lua('return vim.api.nvim_buf_line_count(0)'), 12);
		assert.doesNotMatch(shown.join('\n'), /more lines|fewer lines|lines yanked/);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Ctrl Z and Ctrl Shift Z undo and redo in normal, insert and visual modes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-undo-key-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.input('ihello<Esc>');
		await lua('return 1');
		await session.input('dd');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
		await session.input('<C-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
		await session.input('<C-S-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
		await session.input('<C-z>');
		await session.input('A world');
		await lua('return 1');
		await session.input('<C-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
		assert.equal(await lua('return vim.fn.mode()'), 'i');
		await session.input('<C-S-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello world');
		assert.equal(await lua('return vim.fn.mode()'), 'i');
		await session.input('<C-z>');
		await session.input('<Esc>dd');
		await lua('return 1');
		await session.input('V<C-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
		assert.equal(await lua('return vim.fn.mode()'), 'n');
		await session.input('V<C-S-z>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
		assert.equal(await lua('return vim.fn.mode()'), 'n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('typing brackets and quotes inserts pairs, skips closers and deletes empty pairs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-auto-brackets-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		const reset = async (): Promise<void> => {
			await session!.input('<Esc>');
			await lua(
				"vim.api.nvim_buf_set_lines(0, 0, -1, false, {''}); vim.api.nvim_win_set_cursor(0, {1, 0})"
			);
			await session!.input('i');
		};
		for (const [left, right] of [
			['(', ')'],
			['[', ']'],
			['{', '}'],
			['"', '"']
		]) {
			await reset();
			await session.input(left);
			assert.deepEqual(
				await lua('return {vim.api.nvim_get_current_line(), vim.fn.col(".")}'),
				[left + right, 2]
			);
			await session.input(right);
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), left + right);
			assert.equal(await lua('return vim.fn.col(".")'), 3);
			await reset();
			await session.input(left + '<BS>');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
		}
		await reset();
		await session.input('([{value}])');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '([{value}])');
		await reset();
		await lua("vim.bo.syntax = 'typescript'");
		await session.input('"test";');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '"test";');
		await reset();
		await session.input('"a\\"');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '"a\\""');
		await session.input('<BS>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '"a\\"');
		await reset();
		await session.input('"a\\\\";');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '"a\\\\";');
		await reset();
		await session.paste('([{"');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '([{"');
		await reset();
		await lua("vim.bo.syntax = 'typescript'");
		await session.input('// ');
		await lua('return vim.api.nvim_get_current_line()');
		await session.input('("');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '// ("');
		await session.input('<Left>"');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '// (""');
		await session.input('<BS>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), '// ("');
		// A quote right after a word character does not pair, as in VS Code.
		await reset();
		await session.input('say"');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'say"');
		// Single quotes and backticks pair where they are string delimiters.
		await reset();
		await lua("vim.bo.filetype = 'typescript'");
		for (const quote of ["'", '`']) {
			await reset();
			await session.input(`a = ${quote}`);
			assert.equal(
				await lua('return vim.api.nvim_get_current_line()'),
				`a = ${quote}${quote}`
			);
			await session.input(`x${quote};`);
			assert.equal(
				await lua('return vim.api.nvim_get_current_line()'),
				`a = ${quote}x${quote};`
			);
			await reset();
			await session.input(`${quote}<BS>`);
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
		}
		await reset();
		await session.input("it's");
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), "it's");
		// Elsewhere they are apostrophes or Rust lifetimes.
		await reset();
		await lua("vim.bo.filetype = 'rust'");
		await session.input("fn f<LT>'a");
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), "fn f<'a");
		await lua("vim.bo.filetype = ''");
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Enter inside brackets opens an indented body and aligns the closing bracket', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-brace-enter-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		for (const [filetype, line, column, expandtab, expected] of [
			['rust', 'fn main() {}', 11, true, ['fn main() {', '    ', '}']],
			['typescript', '  if (true) {  }', 14, true, ['  if (true) {', '    ', '  }']],
			['', '{}', 1, true, ['{', '  ', '}']],
			['', '\t{}', 2, false, ['\t{', '\t\t', '\t}']],
			['typescript', '  call()', 7, true, ['  call(', '    ', '  )']],
			['rust', 'let a = [];', 9, true, ['let a = [', '    ', '];']]
		] as const) {
			await session.input('<Esc>');
			await session.client.request('nvim_exec_lua', [
				`local ft, line, col, spaces = ...
vim.bo.filetype = ft
vim.bo.expandtab = spaces
vim.bo.shiftwidth = ft == 'rust' and 4 or 2
vim.bo.tabstop = 2
vim.api.nvim_buf_set_lines(0, 0, -1, false, {line})
vim.api.nvim_win_set_cursor(0, {1, col})`,
				[filetype, line, column, expandtab]
			]);
			await session.input('i<CR>');
			assert.deepEqual(
				await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'),
				expected
			);
			assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [
				2,
				expected[1].length
			]);
			await session.input('body');
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), expected[1] + 'body');
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('pasting preserves the order of preceding and following keyboard input', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-paste-order-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'file.txt'), 'ab\n');
		session = await Session.create(root, () => {});
		await session.openFile('file.txt');
		await Promise.all([session.input('i'), session.paste('X'), session.input('Y<Esc>')]);
		const lines = await session.client.request('nvim_buf_get_lines', [0, 0, -1, false]);
		assert.deepEqual(lines, ['XYab']);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('clipboard reads serialize paste, following typing and saves and recover after failure', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-clipboard-input-order-'));
	const file = join(root, 'file.txt');
	let session: Session | undefined;
	let release!: (text: string) => void;
	const contents = new Promise<string>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	try {
		await writeFile(file, 'original\n');
		session = await Session.create(root, () => {});
		await session.openFile('file.txt');
		const inserting = session.input('i');
		const pasted = session.paste(() => {
			entered();
			return contents;
		});
		await reading;
		const following = session.input('XYZ<Esc>');
		const saving = session.save();
		release('日本語<clip>');
		await Promise.all([inserting, pasted, following, saving]);
		assert.equal(await readFile(file, 'utf8'), '日本語<clip>XYZoriginal\n');
		await assert.rejects(
			session.paste(async () => {
				throw new Error('Clipboard unavailable');
			}),
			/Clipboard unavailable/
		);
		await session.input('A!<Esc>');
		await session.save();
		assert.equal(await readFile(file, 'utf8'), '日本語<clip>XYZoriginal!\n');
	} finally {
		release('');
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});
