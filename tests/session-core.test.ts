import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';
import { neovimBundle } from '../src/main/neovim/neovimBundle';
import { Grid } from '../src/renderer/src/grid/grid';
import { emptyNeovimUI, patchNeovimUI } from '../src/shared/neovimUI';

test('input mode queries observe preceding queued keys before following text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-input-mode-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		await session.attach(80, 24);
		const opening = session.input('i');
		const mode = session.inputMode();
		const text = session.input('Unsaved heading<Esc>');
		await opening;
		assert.equal(await mode, 'i');
		await text;
		assert.equal(await session.inputMode(), 'n');
		assert.equal(await session.client.request('nvim_get_current_line', []), 'Unsaved heading');
		await session.input('0d');
		assert.match(await session.inputMode(), /^no/);
		await session.input('w');
		assert.equal(await session.client.request('nvim_get_current_line', []), 'heading');
		await session.input('0r');
		assert.equal(await session.inputMode(), 'R');
		await session.input(' ');
		assert.equal(await session.client.request('nvim_get_current_line', []), ' eading');
	} finally {
		await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('relative line numbers follow the setting when switching previously opened files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-relative-files-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'first.txt'), 'first\n');
		await writeFile(join(root, 'second.txt'), 'second\n');
		await writeFile(join(root, 'new.txt'), 'new\n');
		session = await Session.create(root, () => {});
		await session.openFile('first.txt');
		await session.openFile('second.txt');
		await session.setRelativeLineNumbers(true);
		await session.openFile('first.txt');
		assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
		await session.openFile('second.txt');
		assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
		await session.openFile('new.txt');
		assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
		await session.setRelativeLineNumbers(false);
		await session.openFile('first.txt');
		assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 0);
		await session.openFile('second.txt');
		assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 0);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('word wrap follows the setting across cached buffers and new windows', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-word-wrap-'));
	let session: Session | undefined;
	try {
		for (const name of ['first.txt', 'second.txt', 'new.txt']) {
			await writeFile(join(root, name), `${'x'.repeat(400)}WRAP_END\n`);
		}
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.attach(80, 24);
		await session.openFile('first.txt');
		assert.equal(await lua('return vim.wo.wrap'), true);
		await session.openFile('second.txt');
		await session.setWordWrap(false);
		for (const name of ['first.txt', 'second.txt', 'new.txt']) {
			await session.openFile(name);
			assert.equal(await lua('return vim.wo.wrap'), false, name);
		}
		await lua("vim.cmd('split')");
		assert.equal(await lua('return vim.wo.wrap'), false);
		await session.setWordWrap(true);
		assert.deepEqual(
			await lua(`local result = {}
for _, win in ipairs(vim.api.nvim_list_wins()) do
  table.insert(result, vim.api.nvim_get_option_value('wrap', {win=win}))
end
return result`),
			[true, true]
		);
		await session.openFile('first.txt');
		assert.equal(await lua('return vim.wo.wrap'), true);
		assert.equal(await lua('return #vim.api.nvim_get_current_line()'), 408);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('normal Ctrl+C avoids the Neovim quit hint while command entry remains visible', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-quit-hint-'));
	const grid = new Grid();
	let ui = emptyNeovimUI();
	let session: Session | undefined;
	try {
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
			if (event.type === 'neovimUI') ui = event.state;
			if (event.type === 'neovimUIPatch') ui = patchNeovimUI(ui, event.state);
		});
		await session.attach(80, 24);
		await session.input('<C-c>');
		await new Promise((done) => setTimeout(done, 30));
		const text = (): string =>
			grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n');
		assert.doesNotMatch(text(), /Type.*:qa.*exit Nvim/);
		await session.input(':echo');
		await new Promise((done) => setTimeout(done, 30));
		assert.doesNotMatch(text(), /:echo/);
		assert.equal(ui.commands[1].firstCharacter, ':');
		assert.equal(ui.commands[1].content.map((chunk) => chunk[1]).join(''), 'echo');
		await session.input('<C-c>');
		await session.client.request('nvim_eval', ['1']);
		assert.equal(await session.client.request('nvim_eval', ['mode()']), 'n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test(
	'terminal sessions run PowerShell, preserve their shell and stop with their workspace',
	{ timeout: 30000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-terminal-'));
		let session: Session | undefined;
		try {
			session = await Session.create(root, () => {});
			const [terminal, same] = await Promise.all([
				session.openTerminal(),
				session.openTerminal()
			]);
			assert.equal(terminal, same);
			assert.equal(terminal.workspace.kind, 'terminal');
			await terminal.input(
				"$nidoValue = 'kept'; Set-Content -Path first.txt -Value $nidoValue<CR>"
			);
			const waitFor = async (name: string, expected: RegExp): Promise<string> => {
				for (let i = 0; i < 100; i++) {
					try {
						const content = await readFile(join(root, name), 'utf8');
						if (expected.test(content)) return content;
					} catch (error) {
						if (
							!['ENOENT', 'EBUSY', 'EACCES'].includes(
								(error as NodeJS.ErrnoException).code || ''
							)
						) {
							throw error;
						}
					}
					await new Promise((done) => setTimeout(done, 100));
				}
				throw new Error(`Terminal did not write the expected content to ${name}`);
			};
			assert.match(await waitFor('first.txt', /kept/), /kept/);
			await terminal.resize(100, 20);
			assert.equal(await session.openTerminal(), terminal);
			await terminal.input('Set-Content -Path second.txt -Value $nidoValue<CR>');
			assert.match(await waitFor('second.txt', /kept/), /kept/);
			assert.equal((await session.snapshot()).terminal, true);
			assert.equal((await terminal.snapshot()).kind, 'terminal');
			await assert.rejects(terminal.startTerminal('invalid'), /Invalid terminal shell/);
			await terminal.startTerminal('cmd.exe');
			await terminal.input('echo cmd-selected>cmd.txt<CR>');
			assert.match(await waitFor('cmd.txt', /cmd-selected/), /cmd-selected/);
			await session.stop();
			assert.notEqual(terminal.process.exitCode, null);
		} finally {
			await session?.stop();
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}
);

test('resize waits for UI reattachment instead of using a detached channel', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-ui-reattach-'));
	let session: Session | undefined;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		session = await Session.create(root, () => {});
		await session.attach(80, 25);
		const request = session.client.request.bind(session.client);
		let detached!: () => void;
		const detaching = new Promise<void>((resolve) => {
			detached = resolve;
		});
		session.client.request = async (method, args = []) => {
			const result = await request(method, args);
			if (method === 'nvim_ui_detach') {
				detached();
				await gate;
			}
			return result;
		};
		const attaching = session.attach(90, 26);
		await detaching;
		const resizing = session.resize(72, 22);
		setTimeout(release, 30);
		const results = await Promise.allSettled([attaching, resizing]);
		assert.ok(
			results.every((result) => result.status === 'fulfilled'),
			JSON.stringify(results)
		);
		const uis = (await request('nvim_list_uis', [])) as { width: number; height: number }[];
		assert.deepEqual([uis[0].width, uis[0].height], [72, 22]);
	} finally {
		release();
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Nido uses bundled Neovim and isolated config', async () => {
	const session = await Session.create(process.cwd(), () => {});
	try {
		await session.attach(80, 24);
		const result = await session.client.request('nvim_exec_lua', [
			`assert(vim.wait(5000, function() return vim.v.vim_did_enter == 1 end))
      assert(vim.env.NVIM_APPNAME == 'nido')
      local found = false
      for _, script in ipairs(vim.fn.getscriptinfo()) do
        if script.name:match('nido[/\\\\]init.lua$') then found = true end
      end
      assert(found, 'Nido init.lua must be sourced')
      local executable = ...
      -- The bundled executable for this platform, such as nvim-win64/bin/nvim.exe.
      assert(vim.fs.normalize(vim.v.progpath):sub(-#executable) == executable, vim.v.progpath)
      assert(package.loaded.lazy == nil and package.loaded.noice == nil)
      local paths = vim.opt.runtimepath:get()
      assert(#paths == 3)
      assert(vim.g.colors_name == 'azami')
      assert(vim.api.nvim_get_hl(0, {name='Normal'}).bg == 0x121212)
      assert(paths[1] == vim.env.VIMRUNTIME)
      assert(paths[2] == vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim')
      for _, language in ipairs({'markdown', 'markdown_inline', 'c', 'lua', 'query', 'vim', 'vimdoc'}) do
        assert(vim.treesitter.language.add(language), language .. ' parser must load')
      end
      local fence = string.rep(string.char(96), 3)
      local buf, win = vim.lsp.util.open_floating_preview({'# Documentation', '', '**hello**', '', fence .. 'rust', 'fn example() {}', fence}, 'markdown', {})
      assert(vim.treesitter.get_parser(buf):parse()[1])
      vim.api.nvim_win_close(win, true)
      return {vim.g.nido, vim.o.showtabline, vim.o.laststatus, vim.o.showmode}`,
			[neovimBundle().executable]
		]);
		assert.deepEqual(result, [true, 0, 0, false]);
	} finally {
		await session.stop();
	}
});

test('two real Neovim sessions edit, save, switch buffers and isolate state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-test-'));
	const sessions: Session[] = [];
	try {
		await mkdir(join(root, 'one'));
		await mkdir(join(root, 'two'));
		await writeFile(join(root, 'one', 'first.ts'), 'const original = 1;\n');
		await writeFile(join(root, 'one', 'second.ts'), 'const second = 2;\n');
		await writeFile(join(root, 'outside.txt'), 'outside');
		const grids = [new Grid(), new Grid()];
		for (const [i, name] of ['one', 'two'].entries()) {
			const session = await Session.create(join(root, name), (event) => {
				if (event.type === 'redraw') grids[i].apply(event.events);
			});
			sessions.push(session);
			await session.attach(80, 24);
		}
		const [first, second] = sessions;
		assert.notEqual(first.process.pid, second.process.pid);
		await first.openFile('first.ts');
		await first.input('gg0i// 日本語<CR><Esc>');
		await first.client.request('nvim_eval', ['1']);
		assert.equal(await first.modified(), true);
		assert.equal(await second.modified(), false);
		await assert.rejects(() => second.save(), /file name|filename/i);
		await first.save();
		assert.match(await readFile(join(root, 'one', 'first.ts'), 'utf8'), /日本語/);
		await first.openFile('second.ts');
		const current = (await first.client.request('nvim_exec_lua', [
			'return vim.api.nvim_get_current_buf()',
			[]
		])) as number;
		await first.input('A // changed<Esc>');
		await first.client.request('nvim_eval', ['1']);
		await assert.rejects(() => first.closeBuffer(current), /modified|changes/i);
		await first.saveAll();
		await first.closeBuffer(current);
		assert.equal(await first.modified(), false);
		await assert.rejects(() => first.path('../outside.txt'), /outside/);
		assert.deepEqual((await first.files('')).map((f) => f.name).sort(), [
			'first.ts',
			'second.ts'
		]);
		assert.deepEqual((await first.findFiles()).map((f) => f.name).sort(), [
			'first.ts',
			'second.ts'
		]);
		assert.ok(grids[0].cells.length);
		assert.ok(grids[0].cells.some((r) => r.some((c) => c.text !== ' ')));
		await first.resize(90, 30);
	} finally {
		await Promise.all(sessions.map((session) => session.stop()));
		await rm(root, { recursive: true, force: true });
	}
});
