import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
	rename,
	symlink,
	stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';
import {
	readFavorites,
	readLayout,
	writeFavorites,
	writeLayout
} from '../src/main/workspace/persistence';
import { fileDecorations } from '../src/renderer/src/explorer/fileDecorations';

test('workspace grep finds saved text beyond filename limits, respects ignores and opens byte positions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-workspace-grep-'));
	const outside = await mkdtemp(join(tmpdir(), 'nido-grep-outside-'));
	let session: Session | undefined;
	try {
		execFileSync('git', ['init', '-q', root], { windowsHide: true });
		await writeFile(join(root, '.gitignore'), 'ignored/\n');
		for (const name of ['src', 'ignored', 'node_modules']) await mkdir(join(root, name));
		for (let index = 0; index < 105; index++) {
			await writeFile(join(root, `empty-${index}.txt`), 'nothing here\n');
		}
		const path = join('src', '日本語.txt');
		const original = '\uFEFFfirst\r\n日本語 needle.* needle.*\r\nlast\r\n';
		await writeFile(join(root, path), original);
		await writeFile(join(root, 'ignored/secret.txt'), 'needle.*');
		await writeFile(join(root, 'node_modules/dependency.txt'), 'needle.*');
		await writeFile(join(root, 'binary.bin'), Buffer.from('needle.*\0'));
		await writeFile(join(root, 'invalid.bin'), Buffer.from([0xff, ...Buffer.from('needle.*')]));
		await writeFile(join(root, 'huge.txt'), 'needle.*' + 'x'.repeat(1024 * 1024));
		await writeFile(join(outside, 'outside.txt'), 'needle.*');
		await symlink(outside, join(root, 'link'), 'junction');
		session = await Session.create(root, () => {});
		await session.attach(80, 24);
		const result = await session.searchText('needle.*');
		assert.deepEqual(result, {
			matches: [{ path, line: 2, column: 11, text: '日本語 needle.* needle.*' }],
			truncated: false
		});
		assert.deepEqual((await session.searchText('NEEDLE.*')).matches, []);
		assert.deepEqual((await session.searchText('')).matches, []);
		await assert.rejects(session.searchText('x\ny'), /single-line/);
		await assert.rejects(session.searchText('x'.repeat(1001)), /1,000/);
		const searching = session.searchText('needle.*');
		session.cancelFindFiles();
		assert.deepEqual((await searching).matches, []);
		await session.openFile(path, 2, 11);
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [2, 10]);
		await session.input('iUNSAVED<Esc>');
		await session.inputMode();
		assert.equal((await session.searchText('UNSAVED')).matches.length, 0);
		await session.openFile(path, 99, 999);
		assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [3, 3]);
		assert.equal(await session.modified(), true);
		assert.equal(await readFile(join(root, path), 'utf8'), original);
		await assert.rejects(session.openFile('../outside.txt', 1, 1));
		await writeFile(join(root, 'many.txt'), 'needle.*\n'.repeat(201));
		const capped = await session.searchText('needle.*');
		assert.equal(capped.matches.length, 200);
		assert.equal(capped.truncated, true);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('favorite storage preserves entries independently and sets damaged data aside', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-favorites-store-'));
	const path = join(root, 'favorites.json');
	try {
		assert.deepEqual(await readFavorites(path), []);
		const favorites = [{ root, name: 'Project', kind: 'editor' as const }];
		await writeFavorites(path, favorites);
		await writeLayout(join(root, 'workspaces.json'), {
			version: 1,
			workspaces: [],
			active: 0
		});
		assert.deepEqual(await readFavorites(path), favorites);
		await writeFavorites(path, []);
		assert.deepEqual(await readFavorites(path), []);
		for (const invalid of [
			null,
			{},
			[{ root: 'relative', name: 'X', kind: 'editor' }],
			[{ root, name: 'X', kind: 'invalid' }],
			[{ root, kind: 'editor' }]
		]) {
			await writeFile(path, JSON.stringify(invalid));
			assert.deepEqual(await readFavorites(path), []);
			// Damaged data is kept aside, and the next change starts a new list.
			assert.equal(await readFile(`${path}.invalid`, 'utf8'), JSON.stringify(invalid));
			await assert.rejects(readFile(path), { code: 'ENOENT' });
		}
		await writeFile(path, '{broken');
		const [first, second] = await Promise.all([readFavorites(path), readFavorites(path)]);
		assert.deepEqual([first, second], [[], []]);
		assert.equal(await readFile(`${path}.invalid`, 'utf8'), '{broken');
		await writeFavorites(path, favorites);
		assert.deepEqual(await readFavorites(path), favorites);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('file decorations propagate to parents and prioritize errors without losing Git status', () => {
	const git = { 'c:/repo/src/deep/a.rs': { code: 'M', title: 'Git: Modified' } };
	const result = fileDecorations('C:\\repo', git, {
		'C:\\repo\\src\\deep\\a.rs': 2,
		'C:/repo/src/b.rs': 1,
		'C:/repository/other.rs': 1
	});
	assert.equal(result['c:/repo/src/deep'].code, 'M');
	assert.equal(result['c:/repo/src/deep'].diagnostic, 'warning');
	assert.equal(result['c:/repo/src'].diagnostic, 'error');
	assert.equal(result['c:/repo'].diagnostic, 'error');
	assert.equal(result['c:/repo/src/deep/a.rs'].code, 'M');
	assert.equal(fileDecorations('C:/repo', git)['c:/repo/src'].diagnostic, undefined);
	assert.deepEqual(fileDecorations('C:/repo', {}, {}), {});
	assert.equal(fileDecorations('C:/repo', {}, { 'C:/repository/a.rs': 1 })['c:/repo'], undefined);
});

test('explorer file actions preserve buffers, reject overwrites and protect workspace boundaries', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-file-actions-'));
	const outside = await mkdtemp(join(tmpdir(), 'nido-file-outside-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const action = (
			operation: import('../src/shared/types').FileAction,
			path: string,
			target = ''
		): Promise<string> =>
			session!.fileAction(operation, path, target, (source) =>
				rename(source, join(root, 'trashed'))
			);
		await action('createDirectory', 'src');
		await action('createFile', 'src/first.txt');
		await writeFile(join(root, 'src/first.txt'), 'hello\n');
		await session.openFile('src/first.txt');
		const buffer = await session.client.request('nvim_get_current_buf', []);
		await action('rename', 'src', 'renamed');
		// Windows TEMP can use an 8.3 alias; Session resolves it to the canonical path.
		assert.equal(
			await session.client.request('nvim_buf_get_name', [buffer]),
			await realpath(join(root, 'renamed/first.txt'))
		);
		await action('copy', 'renamed', 'copied');
		assert.equal(await readFile(join(root, 'copied/first.txt'), 'utf8'), 'hello\n');
		await assert.rejects(
			action('rename', 'renamed/first.txt', 'copied/first.txt'),
			/already exists/
		);
		await assert.rejects(action('createFile', '../escape.txt'), /inside this workspace/);
		await assert.rejects(action('delete', ''), /inside this workspace/);
		await mkdir(join(root, '.git'));
		await assert.rejects(action('delete', '.git'), /outside .git/);
		await assert.rejects(action('copy', 'renamed', 'renamed/inside'), /inside itself/);
		await symlink(outside, join(root, 'link'), 'junction');
		await assert.rejects(action('createFile', 'link/escape.txt'), /outside this workspace/);
		// New folders on the way are created, but never through a link that leads outside.
		await action('createFile', 'new/nested/file.txt');
		assert.equal(await readFile(join(root, 'new/nested/file.txt'), 'utf8'), '');
		await action('createDirectory', 'made/of/folders');
		assert.ok((await stat(join(root, 'made/of/folders'))).isDirectory());
		await assert.rejects(
			action('createFile', 'link/missing/escape.txt'),
			/outside this workspace/
		);
		await assert.rejects(stat(join(outside, 'missing')), { code: 'ENOENT' });
		await assert.rejects(action('createFile', 'copied/first.txt/inside.txt'), /already exists/);
		await assert.rejects(action('createFile', 'new/.git/hooks/x'), /outside .git/);
		await session.input('AX<Esc>');
		await session.client.request('nvim_eval', ['1']);
		await assert.rejects(action('delete', 'renamed'), /unsaved changes/);
		await assert.rejects(action('copy', 'renamed', 'dirty-copy'), /unsaved changes/);
		await session.save();
		await action('delete', 'renamed');
		assert.equal(await session.client.request('nvim_buf_is_valid', [buffer]), false);
		assert.equal(await readFile(join(root, 'trashed/first.txt'), 'utf8'), 'helloX\n');
	} finally {
		await session?.stop();
		await rm(join(root, 'link'), { force: true, recursive: true });
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test('file mutations serialize and retain edits arriving during OS operations', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-file-race-'));
	const session = await Session.create(root, () => {});
	try {
		await writeFile(join(root, 'source.txt'), 'saved\n');
		await session.openFile('source.txt');
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session.client.request('nvim_exec_lua', [code, []]);
		const buffer = await session.client.request('nvim_get_current_buf', []);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const deletion = assert.rejects(
			session.fileAction('delete', 'source.txt', '', async (source) => {
				started();
				await gate;
				await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'keep these edits'})");
				await rename(source, join(root, 'trashed.txt'));
			}),
			/Failed to unload buffer/
		);
		await ready;
		// A second mutation must wait until the first operation releases its OS boundary.
		const creation = session.fileAction('createFile', 'source.txt', '', async () => {});
		release();
		await Promise.all([deletion, creation]);
		assert.equal(await session.client.request('nvim_buf_is_valid', [buffer]), true);
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'keep these edits');
		assert.equal(await readFile(join(root, 'trashed.txt'), 'utf8'), 'saved\n');
		assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), '');
		// Inject an edit between the disk rename and the buffer name update.
		await writeFile(join(root, 'rename-source.txt'), 'rename saved\n');
		await session.openFile('rename-source.txt');
		const request = session.client.request.bind(session.client);
		session.client.request = async (method, args = []) => {
			if (method === 'nvim_exec_lua' && String(args[0]).includes('local renamed = ...')) {
				await request('nvim_exec_lua', [
					"vim.api.nvim_buf_set_lines(0, 0, -1, false, {'edited during rename'})",
					[]
				]);
			}
			return request(method, args);
		};
		await assert.rejects(
			session.fileAction('rename', 'rename-source.txt', 'moved.txt', async () => {}),
			/move was cancelled/
		);
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'edited during rename');
		assert.equal(await session.modified(), true);
		await session.save();
		assert.equal(
			await readFile(join(root, 'rename-source.txt'), 'utf8'),
			'edited during rename\n'
		);
		await assert.rejects(readFile(join(root, 'moved.txt')), /ENOENT/);
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('an open file renames back to an earlier name, and only a real tab blocks a rename', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-rename-back-')));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'a.txt'), 'a\n');
		await writeFile(join(root, 'other.txt'), 'other\n');
		session = await Session.create(root, () => {});
		const rename = (from: string, to: string): Promise<string> =>
			session!.fileAction('rename', from, to, async () => {});
		const names = (): Promise<string[]> =>
			session!.client.request('nvim_exec_lua', [
				'return vim.tbl_map(vim.api.nvim_buf_get_name, vim.api.nvim_list_bufs())',
				[]
			]) as Promise<string[]>;
		await session.openFile('a.txt');
		await rename('a.txt', 'b.txt');
		// Neovim would keep a hidden buffer named a.txt, which is not a tab to close.
		assert.deepEqual(await names(), [join(root, 'b.txt')]);
		await rename('b.txt', 'a.txt');
		assert.deepEqual(await names(), [join(root, 'a.txt')]);
		assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a\n');

		// A hidden buffer under the new name, such as a previewed file, gives way.
		await session.client.request('nvim_exec_lua', [
			'vim.fn.bufload(vim.fn.bufadd(...))',
			[join(root, 'preview.txt')]
		]);
		await rename('a.txt', 'preview.txt');
		assert.deepEqual(await names(), [join(root, 'preview.txt')]);

		// An open tab under the new name still does not.
		await session.openFile('other.txt');
		await rm(join(root, 'other.txt'));
		await assert.rejects(
			rename('preview.txt', 'other.txt'),
			/Close the destination file tab first/
		);
		assert.equal(await readFile(join(root, 'preview.txt'), 'utf8'), 'a\n');

		// The source need not have a buffer: the destination tab still owns that name.
		await writeFile(join(root, 'unopened.txt'), 'unopened\n');
		await assert.rejects(
			rename('unopened.txt', 'other.txt'),
			/Close the destination file tab first/
		);
		assert.equal(await readFile(join(root, 'unopened.txt'), 'utf8'), 'unopened\n');

		// The same protection applies to children of an unopened folder.
		await mkdir(join(root, 'unopened'));
		await writeFile(join(root, 'unopened/child.txt'), 'child\n');
		await session.client.request('nvim_exec_lua', [
			'local buf = vim.fn.bufadd(...); vim.fn.bufload(buf); vim.bo[buf].buflisted = true',
			[join(root, 'destination/child.txt')]
		]);
		await assert.rejects(
			rename('unopened', 'destination'),
			/Close the destination file tab first/
		);
		assert.equal(await readFile(join(root, 'unopened/child.txt'), 'utf8'), 'child\n');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('GUI file opens and workspace restoration do not inherit binary mode', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-text-mode-'));
	let session: Session | undefined;
	try {
		const samples = [
			{ name: 'dos.txt', text: 'first\r\ninside\rcarriage\r\nlast\r\n', format: 'dos' },
			{ name: 'unix.txt', text: 'first\ninside\rcarriage\nlast\n', format: 'unix' }
		];
		for (const sample of samples) await writeFile(join(root, sample.name), sample.text);
		session = await Session.create(root, () => {});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		for (const sample of samples) {
			await lua('vim.o.binary = true');
			await session.openFile(sample.name);
			assert.equal(await lua('return vim.bo.binary'), false);
			assert.equal(await lua('return vim.bo.fileformat'), sample.format);
			assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
				'first',
				'inside\rcarriage',
				'last'
			]);
			assert.equal(await lua('return vim.bo.modified'), false);
			await session.save();
			assert.equal(await readFile(join(root, sample.name), 'utf8'), sample.text);
		}
		await lua("vim.cmd('bwipeout! dos.txt'); vim.o.binary = true");
		const path = join(root, 'dos.txt');
		assert.deepEqual(
			await session.restore({
				root,
				files: [{ path, line: 2, column: 1 }],
				current: path
			}),
			[]
		);
		assert.equal(await lua('return vim.bo.binary'), false);
		assert.equal(await lua('return vim.bo.fileformat'), 'dos');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'inside\rcarriage');
		assert.equal(await readFile(path, 'utf8'), samples[0].text);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('workspace snapshot restores each cursor and tolerates missing files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-restore-'));
	const sessions: Session[] = [];
	try {
		await writeFile(join(root, 'first.txt'), 'first line\nsecond line\nthird line\n');
		await writeFile(join(root, 'second.txt'), 'another file\n');
		const first = await Session.create(root, () => {});
		sessions.push(first);
		await first.openFile('first.txt');
		await first.client.request('nvim_win_set_cursor', [0, [3, 4]]);
		await first.openFile('second.txt');
		await first.client.request('nvim_win_set_cursor', [0, [1, 6]]);
		const snapshot = await first.snapshot();
		assert.deepEqual(
			snapshot.files.map((f) => [f.line, f.column]),
			[
				[3, 4],
				[1, 6]
			]
		);
		const path = join(root, 'workspaces.json');
		assert.deepEqual((await readLayout(path)).workspaces, []);
		await writeLayout(path, { version: 1, workspaces: [snapshot], active: 0 });
		await first.stop();
		const restored = await Session.create(root, () => {});
		sessions.push(restored);
		assert.deepEqual(await restored.restore((await readLayout(path)).workspaces[0]), []);
		await restored.attach(90, 30);
		assert.deepEqual(await restored.snapshot(), snapshot);
		await restored.stop();
		await writeFile(join(root, 'first.txt'), 'short\n');
		await rm(join(root, 'second.txt'));
		const changed = await Session.create(root, () => {});
		sessions.push(changed);
		assert.equal((await changed.restore(snapshot)).length, 1);
		assert.equal((await changed.snapshot()).files[0].line, 1);
		await writeFile(path, '{broken');
		await assert.rejects(readLayout(path));
		await writeFile(path, JSON.stringify({ version: 1, active: 0, workspaces: [{ root }] }));
		await assert.rejects(readLayout(path), /Invalid/);
	} finally {
		await Promise.all(sessions.map((s) => s.stop()));
		await rm(root, { recursive: true, force: true });
	}
});
