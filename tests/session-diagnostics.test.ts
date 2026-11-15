import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Session } from '../src/main/session/session';
import { Grid } from '../src/renderer/src/grid/grid';
import { fileDecorations, gitFileKey } from '../src/renderer/src/explorer/fileDecorations';
import type { NidoEvent, SessionState } from '../src/shared/types';

test('F2 and NidoRename report unsupported files without modifying their text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-rename-unavailable-'));
	const messages: string[] = [];
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'notes.txt'), 'original\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'notification') messages.push(event.message);
		});
		await session.attach(80, 24);
		await session.openFile('notes.txt');
		for (const keys of ['<F2>', 'i<F2><Esc>', ':NidoRename<CR>']) {
			await session.input(keys);
			assert.equal(await session.inputMode(), 'n');
		}
		assert.equal(
			messages.filter((text) => /No language server supports renaming/.test(text)).length,
			3
		);
		assert.equal(await session.modified(), false);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('empty definition and reference results become native notices without grid messages', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-notices-'));
	let session: Session | undefined;
	const notices: Extract<NidoEvent, { type: 'notification' }>[] = [];
	try {
		session = await Session.create(root, (event) => {
			if (event.type === 'notification') notices.push(event);
		});
		await session.client.request('nvim_exec_lua', [
			`local original = vim.lsp.get_clients
local client = {offset_encoding = 'utf-16', request = function(_, _, _, callback)
  callback(nil, nil)
  return true
end}
vim.lsp.get_clients = function() return {client} end
local ok, err = pcall(function()
  vim.lsp.buf.definition()
  require('nido_references').find()
end)
vim.lsp.get_clients = original
assert(ok, err)
vim.notify('Server unavailable', vim.log.levels.WARN, {title = 'Language server'})
vim.notify('Debug detail', vim.log.levels.DEBUG)
assert(vim.api.nvim_get_mode().mode ~= 'r')`,
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		assert.ok(
			notices.some(
				(notice) => notice.message === 'No locations found' && notice.severity === 'info'
			)
		);
		assert.ok(
			notices.some(
				(notice) => notice.title === 'References' && /No references/.test(notice.message)
			)
		);
		assert.ok(
			notices.some(
				(notice) => notice.severity === 'warning' && notice.message === 'Server unavailable'
			)
		);
		assert.ok(!notices.some((notice) => notice.message === 'Debug detail'));
		assert.doesNotMatch(
			JSON.stringify(
				await session.client.request('nvim_exec2', ['messages', { output: true }])
			),
			/No locations found|No references found/
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('gf reports missing files through native notices and preserves counted path searches and jumps', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-goto-file-'));
	const grid = new Grid();
	const notices: Extract<NidoEvent, { type: 'notification' }>[] = [];
	let session: Session | undefined;
	try {
		await mkdir(join(root, 'first'));
		await mkdir(join(root, 'second'));
		await writeFile(join(root, 'notes.txt'), 'event.preventDefault\ntarget\n');
		await writeFile(join(root, 'first', 'target.txt'), 'first match\n');
		await writeFile(join(root, 'second', 'target.txt'), 'second match\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'notification') notices.push(event);
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.openFile('notes.txt');
		await session.client.request('nvim_exec_lua', [
			"vim.opt.path = {'first', 'second'}; vim.opt.suffixesadd = {'.txt'}",
			[]
		]);
		await session.input('gg0gf');
		await session.client.request('nvim_eval', ['1']);
		assert.deepEqual(
			notices.map(({ title, message, severity }) => ({ title, message, severity })),
			[
				{
					title: 'File navigation',
					message: 'E447: Can\'t find file "event.preventDefault" in path',
					severity: 'error'
				}
			]
		);
		assert.equal(await session.client.request('nvim_eval', ["expand('%:t')"]), 'notes.txt');
		assert.equal(await session.client.request('nvim_eval', ['mode(1)']), 'n');
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [1, 0]);
		assert.match(
			grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n'),
			/event\.preventDefault/
		);
		assert.doesNotMatch(
			grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n'),
			/E447|Can't find file|Press ENTER/
		);
		assert.doesNotMatch(
			JSON.stringify(
				await session.client.request('nvim_exec2', ['messages', { output: true }])
			),
			/E447|Can't find file/
		);
		await session.input('j02gf');
		assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'second match');
		await session.input('<C-o>');
		assert.equal(await session.client.request('nvim_eval', ["expand('%:t')"]), 'notes.txt');
		await session.input('gf');
		assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'first match');
		assert.equal(notices.length, 1);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('hover without an LSP never opens help and successful saves stay quiet', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-hover-'));
	let session: Session | undefined;
	const hovers: string[] = [];
	try {
		await writeFile(join(root, 'sample.ts'), 'const state = 1;\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'hover') hovers.push(event.markdown);
		});
		await session.openFile('sample.ts');
		await session.client.request('nvim_exec_lua', [
			`assert(vim.g.nido_channel, 'missing channel')
vim.lsp.enable('typescript', false)
for _, key in ipairs({'K', '<C-k>'}) do
  local mapping = vim.fn.maparg(key, 'n', false, true)
  assert(type(mapping.callback) == 'function')
  mapping.callback()
  assert(#vim.api.nvim_list_wins() == 1)
  assert(vim.bo.filetype == 'typescript')
end
local calls = 0
local get_clients, request_all = vim.lsp.get_clients, vim.lsp.buf_request_all
vim.lsp.get_clients = function() return {{}} end
vim.lsp.buf_request_all = function(buf, method, params, callback)
  calls = calls + 1
  assert(method == 'textDocument/hover' and type(params) == 'function')
  callback({[1]={result={contents={kind='markdown', value='A type description'}}}})
end
vim.fn.maparg('K', 'n', false, true).callback()
local pending
vim.lsp.buf_request_all = function(_, _, _, callback) pending = callback end
vim.fn.maparg('K', 'n', false, true).callback()
vim.api.nvim_win_set_cursor(0, {1, 1})
pending({[1]={result={contents={kind='markdown', value='Stale type description'}}}})
vim.lsp.get_clients, vim.lsp.buf_request_all = get_clients, request_all
assert(calls == 1)
assert(#vim.api.nvim_list_wins() == 1)
vim.cmd('messages clear')`,
			[]
		]);
		await session.save(false);
		assert.ok(hovers.includes('A type description'), JSON.stringify(hovers));
		assert.ok(!hovers.includes('Stale type description'));
		assert.equal(await readFile(join(root, 'sample.ts'), 'utf8'), 'const state = 1;\n');
		assert.doesNotMatch(
			JSON.stringify(
				await session.client.request('nvim_exec2', ['messages', { output: true }])
			),
			/written|\[w\]/
		);
		await session.input('AX<Esc>');
		await session.client.request('nvim_eval', ['1']);
		await session.input('u');
		assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'const state = 1;');
		await session.input('<C-r>');
		assert.equal(
			await session.client.request('nvim_eval', ['getline(1)']),
			'const state = 1;X'
		);
		assert.doesNotMatch(
			JSON.stringify(
				await session.client.request('nvim_exec2', ['messages', { output: true }])
			),
			/before #|after #/
		);
		await session.client.request('nvim_exec_lua', ['vim.bo.readonly = true', []]);
		await assert.rejects(session.save(false), /readonly|E45/);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test('diagnostic navigation publishes native details without floating windows and clears stale cards', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-diagnostic-details-'));
	const cards: Extract<NidoEvent, { type: 'diagnostics' }>[] = [];
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'sample.txt'),
			'first line\nsecond line\nthird line\nfourth line\n'
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'diagnostics') cards.push(event);
		});
		await session.openFile('sample.txt');
		await session.client.request('nvim_exec_lua', [
			`local ns = vim.api.nvim_create_namespace('native-details-test')
vim.g.details_test_ns = ns
vim.diagnostic.set(ns, 0, {
  {lnum=0, col=0, severity=2, source='rustc', code='unused_parens', message=[[Unnecessary parentheses
Remove these parentheses.]]},
  {lnum=1, col=1, severity=1, source='rustc', code='E0277', message='The trait bound is not satisfied'},
  {lnum=1, col=3, severity=2, source='lint', code=123, message='Another warning'},
  {lnum=3, col=0, severity=4, message='A hint'},
})`,
			[]
		]);
		const keys = async (sequence: string): Promise<void> => {
			await session!.input(sequence);
			await session!.client.request('nvim_eval', ['1']);
		};
		await keys('gl');
		assert.equal(cards.at(-1)?.focus, true);
		assert.equal(cards.at(-1)?.items[0]?.code, 'unused_parens');
		assert.equal(cards.at(-1)?.items[0]?.source, 'rustc');
		assert.equal(
			cards.at(-1)?.items[0]?.message,
			'Unnecessary parentheses\nRemove these parentheses.'
		);
		await keys(']d');
		assert.equal(cards.at(-1)?.focus, false);
		assert.deepEqual(
			cards.at(-1)?.items.map((item) => [item.line, item.column, item.severity, item.code]),
			[
				[2, 2, 1, 'E0277'],
				[2, 4, 2, '123']
			]
		);
		assert.match(cards.at(-1)!.items[0].path, /sample\.txt$/);
		await keys('2]d');
		assert.equal(cards.at(-1)?.items[0]?.line, 4);
		await keys(']d');
		assert.equal(cards.at(-1)?.items[0]?.line, 1);
		await keys('[d');
		assert.equal(cards.at(-1)?.items[0]?.line, 4);
		assert.equal(((await session.client.request('nvim_list_wins', [])) as unknown[]).length, 1);
		await keys('k');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys(']d<Esc>');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys(']d<C-c>');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys('3G0');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys('gl');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys(']d');
		assert.ok(cards.at(-1)?.items.length);
		await keys('i');
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys('<Esc>gl');
		assert.ok(cards.at(-1)?.items.length);
		await session.client.request('nvim_exec_lua', [
			'vim.diagnostic.reset(vim.g.details_test_ns, 0)',
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		assert.deepEqual(cards.at(-1)?.items, []);
		await keys('gl');
		assert.deepEqual(cards.at(-1)?.items, []);
		assert.equal(((await session.client.request('nvim_list_wins', [])) as unknown[]).length, 1);
		assert.equal(
			await readFile(join(root, 'sample.txt'), 'utf8'),
			'first line\nsecond line\nthird line\nfourth line\n'
		);
	} finally {
		await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Neovim publishes and clears diagnostics including unopened files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-diagnostics-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const path = join(root, 'unopened.txt');
		await session.client.request('nvim_exec_lua', [
			"local path = ...; local b = vim.fn.bufadd(path); vim.fn.bufload(b); vim.diagnostic.set(vim.api.nvim_create_namespace('test'), b, {{lnum=0,col=0,severity=2,message='Warning'}, {lnum=0,col=0,severity=1,message='Error'}})",
			[path]
		]);
		for (let i = 0; i < 50 && !Object.keys(session.state.diagnostics || {}).length; i++) {
			await new Promise((done) => setTimeout(done, 10));
		}
		const entries = Object.entries(session.state.diagnostics || {});
		assert.equal(gitFileKey(entries[0][0]), gitFileKey(path));
		assert.equal(entries[0][1], 1);
		assert.equal(session.state.problems?.length, 2);
		const decorations = fileDecorations(
			root,
			{},
			session.state.diagnostics,
			session.state.problems
		);
		assert.equal(decorations[gitFileKey(path)].errors, 1);
		assert.equal(decorations[gitFileKey(path)].warnings, 1);
		assert.equal(decorations[gitFileKey(root)].errors, 1);
		assert.equal(decorations[gitFileKey(root)].warnings, 1);
		const version = session.state.diagnosticsVersion!;
		await session.openProblem(1, version);
		assert.equal(await session.client.request('nvim_eval', ["expand('%:p')"]), path);
		await session.client.request('nvim_exec_lua', [
			"vim.diagnostic.reset(vim.api.nvim_create_namespace('test'))",
			[]
		]);
		for (let i = 0; i < 50 && Object.keys(session.state.diagnostics || {}).length; i++) {
			await new Promise((done) => setTimeout(done, 10));
		}
		assert.deepEqual(session.state.diagnostics, {});
		assert.deepEqual(session.state.problems, []);
		assert.deepEqual(
			fileDecorations(root, {}, session.state.diagnostics, session.state.problems),
			{}
		);
		await assert.rejects(session.openProblem(1, version), /Problems have changed/);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('word searches publish counts, distinguish current matches and clear on Escape', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-search-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'words.txt'), 'alpha beta alpha\nalpha\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.openFile('words.txt');
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		const waitForSearch = async (expected: SessionState['search']): Promise<void> => {
			const signal = AbortSignal.timeout(5000);
			try {
				// An RPC response can precede the scheduled search-state notification.
				while (!isDeepStrictEqual(session!.state.search, expected)) {
					await once(session!.client, 'notification', { signal });
				}
			} catch (error) {
				if (!signal.aborted) throw error;
				assert.deepEqual(session!.state.search, expected, 'Search state was not published');
			}
		};
		await session.input('gg0*');
		const search = {
			pattern: '\\<alpha\\>',
			current: 2,
			total: 3,
			incomplete: 0
		};
		await waitForSearch(search);
		await lua('vim.cmd.redraw()');
		await lua('return 1');
		const row = grid.cells.find((cells) =>
			cells
				.map((cell) => cell.text)
				.join('')
				.includes('alpha beta alpha')
		)!;
		const text = row.map((cell) => cell.text).join('');
		assert.equal(
			grid.highlights.get(row[text.indexOf('alpha')].highlight)?.background,
			0x514020
		);
		assert.equal(
			grid.highlights.get(row[text.lastIndexOf('alpha')].highlight)?.background,
			0xa8cf9e
		);
		await session.input('#');
		await waitForSearch({ ...search, current: 1 });
		await session.input('<Esc>');
		await waitForSearch(false);
		await session.input('n');
		await waitForSearch({ ...search, current: 3 });
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Rust runnable commands request current targets and reject edits during analysis', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-stable-lenses-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		await session.client.request('nvim_exec_lua', [
			`
local api = vim.api
local buffer = api.nvim_get_current_buf()
api.nvim_buf_set_lines(0, 0, -1, false, {'fn main() {}', '', '#[test] fn sample() {}'})
vim.lsp.enable('rust_analyzer', false)
vim.bo.filetype = 'rust'
local module = require('nido_runnables')
local debugger = require('nido_debug')
local namespace = api.nvim_create_namespace('nido_runnables')
local items = {}
local function item(row, command)
  return {kind='cargo', args={cargoArgs={command}}, location={
    targetSelectionRange={start={line=row}}, targetRange={start={line=row}, ['end']={line=row}},
  }}
end
local original, runnable, notify = vim.lsp.get_clients, debugger.runnable, vim.notify
local requests, calls, notices, pending, empty = 0, {}, {}, nil, 0
vim.lsp.get_clients = function(options)
  if options and options.name == 'rust_analyzer' then
    return {{request=function(_, _, _, callback)
      requests = requests + 1
      if pending then table.insert(pending, callback)
      elseif empty > 0 then empty = empty - 1; callback(nil, {})
      else callback(nil, items) end
    end}}
  end
  return original(options)
end
debugger.runnable = function(target, debug) table.insert(calls, {target, debug}) end
vim.notify = function(message) table.insert(notices, message) end
local ok, err = pcall(function()
  items = {item(0, 'run'), item(2, 'test')}
  api.nvim_win_set_cursor(0, {1, 0})
  module.execute(false)
  api.nvim_win_set_cursor(0, {3, 0})
  module.execute(true)
  assert(requests == 2, 'each command must request the current targets')
  assert(calls[1][1] == items[1] and calls[1][2] == false, 'run main')
  assert(calls[2][1] == items[2] and calls[2][2] == true, 'debug the test')
  api.nvim_buf_set_lines(0, 0, 0, false, {'// inserted'})
  items = {item(1, 'run'), item(3, 'test')}
  api.nvim_win_set_cursor(0, {4, 0})
  module.execute(false)
  assert(requests == 3 and calls[3][1] == items[2], 'edits must request fresh ranges')
  pending = {}
  module.execute(false)
  api.nvim_buf_set_lines(0, 0, 0, false, {'// another edit'})
  pending[1](nil, items)
  assert(#calls == 3 and notices[1] == 'Code changed; try running again.',
    'edits during a request must not execute a stale target')
  pending = nil
  items = {item(2, 'run'), item(4, 'test')}
  api.nvim_win_set_cursor(0, {5, 0})
  module.execute(true)
  assert(requests == 5 and calls[4][1] == items[2], 'a new command must use the updated target')
  empty = 1
  module.execute(false)
  assert(vim.wait(1000, function() return #calls == 5 end, 10),
    'an empty response during Cargo reload must recover without another command')
  assert(requests == 7 and calls[5][1] == items[2] and #notices == 1,
    vim.inspect({requests=requests, calls=#calls, notices=notices, target=calls[5][1]}))
  items = {}
  module.execute(false)
  assert(vim.wait(1500, function() return #notices == 2 end, 10),
    'a genuinely empty target list must still finish with a notice')
  assert(requests == 11 and #calls == 5, 'empty target retries must remain bounded')
  assert(#api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {}) == 0,
    'runnables must not add CodeLens rows')
end)
vim.lsp.get_clients, debugger.runnable, vim.notify = original, runnable, notify
assert(ok, err)
`,
			[]
		]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});
