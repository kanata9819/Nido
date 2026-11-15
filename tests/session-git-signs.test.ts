import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';
import { Grid } from '../src/renderer/src/grid/grid';

test('Git gutter signs compare committed bytes as the buffer reads them', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-git-signs-encoding-'));
	let session: Session | undefined;
	const git = (...args: string[]): void => {
		execFileSync('git', args, { cwd: root });
	};
	const files: Record<string, Buffer> = {
		'bom.txt': Buffer.from('\uFEFFone\ntwo\nthree\n'),
		'bom-crlf.txt': Buffer.from('\uFEFFone\r\ntwo\r\nthree\r\n'),
		'latin1.txt': Buffer.from('caf\xe9\ntwo\nna\xefve\n', 'latin1'),
		'utf16.txt': Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('one\ntwo\nthree\n', 'utf16le')
		]),
		'mixed.txt': Buffer.from('one\r\ntwo\nthree\r\n')
	};
	try {
		git('init', '-q');
		// Commit the bytes as they are, whatever the machine's line ending conversion.
		git('config', 'core.autocrlf', 'false');
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(root, name), content);
		}
		git('add', '.');
		git(
			'-c',
			'user.name=Nido Test',
			'-c',
			'user.email=nido@example.test',
			'commit',
			'-qm',
			'base'
		);
		session = await Session.create(root, () => {});
		const signs = (expected: [number, string][]): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [
				`
local expected = ...
local buffer = vim.api.nvim_get_current_buf()
local namespace = vim.api.nvim_get_namespaces().nido_git_signs
local function signs()
  local result = {}
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {details=true})) do
    table.insert(result, {mark[2], mark[4].sign_hl_group})
  end
  return result
end
local module = require('nido_git_signs')
local system, finished = vim.system, 0
vim.system = function(command, options, callback)
  return system(command, options, function(result)
    callback(result)
    if vim.tbl_contains(command, 'show') then vim.schedule(function() finished = finished + 1 end) end
  end)
end
module.refresh(buffer)
-- Signs are empty before the comparison too: wait for the committed file to be read.
local ok = vim.wait(5000, function()
  return (#expected > 0 or finished > 0) and vim.deep_equal(signs(), expected)
end, 20)
vim.system = system
assert(ok, vim.fn.bufname(buffer) .. ': ' .. vim.inspect(signs()))`,
				[expected]
			]);
		for (const name of Object.keys(files)) {
			await session.openFile(name);
			await signs([]);
			// An edit is still found, on its own line only.
			await session.client.request('nvim_buf_set_lines', [0, 1, 2, false, ['changed']]);
			await signs([[1, 'NidoGitChanged']]);
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Git gutter signs distinguish an empty file from a single newline, including background buffers', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-git-signs-empty-'));
	let session: Session | undefined;
	const git = (...args: string[]): void => {
		execFileSync('git', args, { cwd: root, windowsHide: true });
	};
	try {
		git('init', '-q');
		git('config', 'core.autocrlf', 'false');
		await writeFile(join(root, 'empty.txt'), '');
		await writeFile(join(root, 'newline.txt'), '\n');
		git('add', '.');
		git(
			'-c',
			'user.name=Nido Test',
			'-c',
			'user.email=nido@example.test',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'-qm',
			'base'
		);
		await writeFile(join(root, 'new-empty.txt'), '');
		await writeFile(join(root, 'new-newline.txt'), '\n');
		session = await Session.create(root, () => {});
		const lua = (
			code: string,
			args: unknown[] = []
		): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, args]);
		const signs = async (expected: [number, string][], buffer = 0): Promise<void> => {
			await lua(
				`
local expected, buffer = ...
if buffer == 0 then buffer = vim.api.nvim_get_current_buf() end
local system, active, started = vim.system, 0, false
vim.system = function(command, options, callback)
  if command[1] ~= 'git' then return system(command, options, callback) end
  active = active + 1
  started = true
  return system(command, options, function(result)
    callback(result)
    vim.schedule(function() active = active - 1 end)
  end)
end
require('nido_git_signs').refresh(buffer)
local completed = vim.wait(5000, function() return started and active == 0 end, 10)
vim.system = system
assert(completed, 'Git sign comparison completed')
local result = {}
for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, vim.api.nvim_get_namespaces().nido_git_signs, 0, -1, {details=true})) do
  table.insert(result, {mark[2], mark[4].sign_hl_group})
end
assert(vim.deep_equal(result, expected), vim.api.nvim_buf_get_name(buffer) .. ': ' .. vim.inspect(result))`,
				[expected, buffer]
			);
		};
		await session.openFile('empty.txt');
		await signs([]);
		await session.openFile('newline.txt');
		await signs([]);
		const newline = (await lua('return vim.api.nvim_get_current_buf()')) as number;
		await lua('vim.api.nvim_buf_set_lines(0, 0, -1, false, {})');
		await signs([[0, 'NidoGitDeleted']]);
		await session.openFile('new-empty.txt');
		await signs([]);
		await session.openFile('new-newline.txt');
		await signs([[0, 'NidoGitAdded']]);
		await signs([[0, 'NidoGitDeleted']], newline);
		await lua('vim.api.nvim_buf_set_lines(...)', [newline, 0, -1, false, ['']]);
		await lua('vim.api.nvim_buf_set_lines(0, 0, -1, false, {})');
		await signs([]);
		await signs([], newline);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('Git gutter signs track HEAD, unsaved edits, deletions, new files and commits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-git-signs-'));
	let session: Session | undefined;
	const git = (...args: string[]): void => {
		execFileSync('git', args, { cwd: root });
	};
	try {
		git('init', '-q');
		await writeFile(join(root, 'tracked.txt'), 'first\r\nsecond\r\nthird\r\n');
		await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
		git('add', '.');
		git(
			'-c',
			'user.name=Nido Test',
			'-c',
			'user.email=nido@example.test',
			'commit',
			'-qm',
			'base'
		);
		const grid = new Grid();
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		const lua = (
			code: string,
			args: unknown[] = []
		): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, args]);
		const signs = async (expected: [number, string][], refresh = true): Promise<void> => {
			await lua(
				`
local expected, refresh = ...
local buffer = vim.api.nvim_get_current_buf()
local namespace = vim.api.nvim_get_namespaces().nido_git_signs
local function signs()
  local result = {}
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {details=true})) do
    table.insert(result, {mark[2], mark[4].sign_hl_group})
  end
  return result
end
if refresh then require('nido_git_signs').refresh(buffer) end
assert(vim.wait(5000, function() return vim.deep_equal(signs(), expected) end, 20), vim.inspect(signs()))
vim.cmd('redraw!')`,
				[expected, refresh]
			);
		};
		const edit = (lines: string[]): ReturnType<Session['client']['request']> =>
			lua('vim.api.nvim_buf_set_lines(0, 0, -1, false, ...)', [lines]);
		await session.openFile('tracked.txt');
		await signs([]);
		await lua(`
local module = require('nido_git_signs')
local buffer = vim.api.nvim_get_current_buf()
local system, diff, get_lines = vim.system, vim.diff, vim.api.nvim_buf_get_lines
local active = 0
local metrics = {git=0, shows=0, diffs=0, reads=0}
vim.system = function(command, options, callback)
  if command[1] ~= 'git' then return system(command, options, callback) end
  metrics.git = metrics.git + 1
  if vim.tbl_contains(command, 'show') then metrics.shows = metrics.shows + 1 end
  active = active + 1
  return system(command, options, function(result)
    callback(result)
    vim.schedule(function() active = active - 1 end)
  end)
end
vim.diff = function(...) metrics.diffs = metrics.diffs + 1; return diff(...) end
vim.api.nvim_buf_get_lines = function(buf, first, last, strict)
  -- Other decoration providers read this buffer while vim.wait processes their timers.
  if buf == buffer and first == 0 and last == -1
      and debug.getinfo(2, 'S').source:match('nido_git_signs%.lua$') then
    metrics.reads = metrics.reads + 1
  end
  return get_lines(buf, first, last, strict)
end
local function refresh()
  local started = metrics.git
  module.refresh(buffer)
  -- The initial empty signs may precede a Git request that started before this
  -- instrumentation. A queued refresh must actually start before zero means done.
  assert(vim.wait(3000, function() return metrics.git > started and active == 0 end, 5),
    'Git refresh started and completed: ' .. vim.inspect(metrics))
end
local ok, err = pcall(function()
  refresh()
  metrics = {git=0, shows=0, diffs=0, reads=0}
  vim.api.nvim_exec_autocmds('Syntax', {buffer=buffer})
  for _=1,10 do refresh() end
  assert(vim.wait(3000, function() return require('nido_brackets').ready(buffer) end, 5), 'background bracket scan completed')
  assert(metrics.git >= 10, 'still verify external HEAD changes')
  assert(metrics.shows == 0, 'reuse the committed file until HEAD changes')
  assert(metrics.diffs == 0 and metrics.reads == 0, 'unchanged refreshes skip full-buffer work: ' .. vim.inspect(metrics))
  local tick = vim.api.nvim_buf_get_changedtick(buffer)
  vim.bo[buffer].endofline = false
  assert(vim.api.nvim_buf_get_changedtick(buffer) == tick, 'option change leaves changedtick unchanged')
  refresh()
  assert(metrics.diffs == 1 and metrics.reads == 1, 'endofline change invalidates the rendered signs')
  vim.bo[buffer].endofline = true
  refresh()
end)
vim.system, vim.diff, vim.api.nvim_buf_get_lines = system, diff, get_lines
assert(ok, err)
`);
		await edit(['first', 'changed', 'third', 'added']);
		await signs([
			[1, 'NidoGitChanged'],
			[3, 'NidoGitAdded']
		]);
		await lua('return 1');
		const ink = (row: number): (number | undefined)[] =>
			grid.cells[row]
				.filter((cell) => cell.text === '▎' || cell.text === '▸')
				.map((cell) => grid.highlights.get(cell.highlight)?.foreground);
		assert.deepEqual(ink(1), [0x0078d4]);
		assert.deepEqual(ink(3), [0x2ea043]);
		const marks = (): ReturnType<Session['client']['request']> =>
			lua(`return vim.api.nvim_buf_get_extmarks(0,
            vim.api.nvim_get_namespaces().nido_git_signs, 0, -1, {details=true})`);
		const beforeSave = await marks();
		await session.save();
		await lua('vim.wait(500)');
		assert.deepEqual(await marks(), beforeSave, 'saving unchanged signs preserves their IDs');
		await edit(['second', 'third']);
		await signs([[0, 'NidoGitDeleted']]);
		await lua('return 1');
		assert.deepEqual(ink(0), [0xf85149]);
		await edit(['first', 'second']);
		await signs([[1, 'NidoGitDeleted']]);
		await edit(['first', 'third']);
		await signs([[1, 'NidoGitDeleted']]);
		await edit(['changed']);
		await signs([
			[0, 'NidoGitChanged'],
			[0, 'NidoGitDeleted']
		]);
		await edit([]);
		await signs([[0, 'NidoGitDeleted']]);
		await edit(['first', 'second', 'third']);
		await signs([]);
		await edit(['first', 'changed', 'third']);
		await session.save();
		git('add', 'tracked.txt');
		await signs([[1, 'NidoGitChanged']]);
		git(
			'-c',
			'user.name=Nido Test',
			'-c',
			'user.email=nido@example.test',
			'commit',
			'-qm',
			'update'
		);
		await signs([], false);
		await writeFile(join(root, 'new.txt'), 'new\nfile\n');
		await session.openFile('new.txt');
		await signs([
			[0, 'NidoGitAdded'],
			[1, 'NidoGitAdded']
		]);
		await writeFile(join(root, '.gitignore'), 'ignored.txt\nnew.txt\n');
		await signs([]);
		git('add', '-f', 'new.txt');
		await signs([
			[0, 'NidoGitAdded'],
			[1, 'NidoGitAdded']
		]);
		await writeFile(join(root, 'ignored.txt'), 'ignored\n');
		await session.openFile('ignored.txt');
		await signs([]);
		await mkdir(join(root, 'fresh'));
		execFileSync('git', ['init', '-q'], { cwd: join(root, 'fresh') });
		await writeFile(join(root, 'fresh/new.txt'), 'unborn\n');
		await session.openFile('fresh/new.txt');
		await signs([[0, 'NidoGitAdded']]);
		assert.equal(await session.modified(), false);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
