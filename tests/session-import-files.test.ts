import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NeovimClient } from 'neovim';
import { SessionFiles } from '../src/main/session/sessionFiles';

/** A Neovim client whose only buffers are `buffers`. */
function client(
	buffers: { name: string; listed: boolean; modified: boolean }[] = []
): NeovimClient {
	return {
		request: async (_method: string, args: unknown[]) =>
			String(args[0]).includes('local result = {}')
				? buffers.map((buffer, index) => ({ id: index + 1, ...buffer }))
				: false
	} as unknown as NeovimClient;
}

/** A workspace and a folder outside it holding the files to drop. */
async function folders(): Promise<{ root: string; outside: string; done: () => Promise<void> }> {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'nido-import-')));
	const root = join(base, 'workspace');
	const outside = join(base, 'desktop');
	await mkdir(join(root, 'src'), { recursive: true });
	await mkdir(join(outside, 'assets', 'icons'), { recursive: true });
	await writeFile(join(outside, 'notes.txt'), 'dropped\n');
	await writeFile(join(outside, 'assets', 'logo.svg'), '<svg/>\n');
	await writeFile(join(outside, 'assets', 'icons', 'a.svg'), '<svg a/>\n');
	return { root, outside, done: () => rm(base, { recursive: true, force: true }) };
}

test('dropped files and folders are copied, with everything in the folders, into the target folder', async () => {
	const { root, outside, done } = await folders();
	try {
		const files = new SessionFiles(root, client());
		const copied = await files.importFiles(
			[join(outside, 'notes.txt'), join(outside, 'assets')],
			'src'
		);
		assert.deepEqual(copied, [join('src', 'notes.txt'), join('src', 'assets')]);
		assert.equal(await readFile(join(root, 'src', 'notes.txt'), 'utf8'), 'dropped\n');
		assert.equal(
			await readFile(join(root, 'src', 'assets', 'icons', 'a.svg'), 'utf8'),
			'<svg a/>\n'
		);
		// The originals stay where they were.
		assert.equal(await readFile(join(outside, 'notes.txt'), 'utf8'), 'dropped\n');
		// '' is the workspace itself.
		assert.deepEqual(await files.importFiles([join(outside, 'notes.txt')], ''), ['notes.txt']);
		assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'dropped\n');
	} finally {
		await done();
	}
});

test('a taken name gets the explorer copy name instead of being overwritten', async () => {
	const { root, outside, done } = await folders();
	try {
		await writeFile(join(root, 'notes.txt'), 'mine\n');
		await mkdir(join(root, 'assets'));
		const files = new SessionFiles(root, client());
		assert.deepEqual(
			await files.importFiles([join(outside, 'notes.txt'), join(outside, 'assets')], ''),
			['notes copy.txt', 'assets copy']
		);
		assert.deepEqual(await files.importFiles([join(outside, 'notes.txt')], ''), [
			'notes copy 2.txt'
		]);
		assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'mine\n');
		assert.equal(await readFile(join(root, 'notes copy 2.txt'), 'utf8'), 'dropped\n');
		assert.deepEqual(await readdir(join(root, 'assets')), []);
		assert.deepEqual((await readdir(join(root, 'assets copy'))).sort(), ['icons', 'logo.svg']);
	} finally {
		await done();
	}
});

test('a name held by an open tab counts as taken, so saving the tab cannot replace the copy', async () => {
	const { root, outside, done } = await folders();
	try {
		const files = new SessionFiles(
			root,
			client([{ name: join(root, 'notes.txt'), listed: true, modified: false }])
		);
		assert.deepEqual(await files.importFiles([join(outside, 'notes.txt')], ''), [
			'notes copy.txt'
		]);
	} finally {
		await done();
	}
});

test('a drop folder outside the workspace or in .git is refused and copies nothing', async () => {
	const { root, outside, done } = await folders();
	try {
		await mkdir(join(root, '.git'));
		await writeFile(join(root, 'src', 'file.ts'), '');
		const files = new SessionFiles(root, client());
		const source = [join(outside, 'notes.txt')];
		for (const [directory, message] of [
			['..', /inside this workspace/],
			['../desktop', /inside this workspace/],
			[outside, /inside this workspace/],
			['.git', /outside \.git/],
			['src/file.ts', /Choose a folder inside this workspace/],
			['missing', /ENOENT/]
		] as const) {
			await assert.rejects(files.importFiles(source, directory), message, directory);
		}
		await assert.rejects(files.importFiles(['notes.txt'], ''), /Expected an absolute path/);
		assert.deepEqual((await readdir(root)).sort(), ['.git', 'src']);
		assert.deepEqual(await readdir(join(root, '.git')), []);
		assert.deepEqual(await readdir(join(outside)), ['assets', 'notes.txt']);
	} finally {
		await done();
	}
});

test('a folder cannot be dropped into itself', async () => {
	const { root, done } = await folders();
	try {
		const files = new SessionFiles(root, client());
		await assert.rejects(
			files.importFiles([join(root, 'src')], 'src'),
			/Cannot place a folder inside itself/
		);
		await assert.rejects(
			files.importFiles([root], 'src'),
			/Cannot place a folder inside itself/
		);
		assert.deepEqual(await readdir(join(root, 'src')), []);
		// Beside itself is a copy, as with Paste.
		assert.deepEqual(await files.importFiles([join(root, 'src')], ''), ['src copy']);
	} finally {
		await done();
	}
});
