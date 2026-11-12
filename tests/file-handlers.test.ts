import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { registerFileHandlers } from '../src/main/fileHandlers';
import { windowsDrives } from '../src/main/folderBrowserHandlers';
import type { Session } from '../src/main/session';
import { SessionSearch } from '../src/main/sessionSearch';
import type { WorkspaceReplacement } from '../src/main/workspaceReplacement';
import type { FileEntry, NidoEvent } from '../src/shared/types';
import { filterItems } from '../src/renderer/src/commands';

test('file IPC validates requests and protects files open in other workspace sessions', async () => {
	const root = resolve('file-handler-fixture');
	const sent: NidoEvent[] = [];
	const mutations: unknown[][] = [];
	const trashed: string[] = [];
	const trash = async (path: string): Promise<void> => {
		trashed.push(path);
	};
	const current = {
		workspace: { id: 'current', root },
		state: { buffers: [{ name: join(root, 'src/file.txt') }] },
		path: async (path: string) => join(root, path),
		fileAction: async (...args: unknown[]) => mutations.push(args),
		searchText: async () => ({ matches: [], truncated: false }),
		watchDirectories: async () => {}
	} as unknown as Session;
	const mirror = {
		workspace: { id: 'mirror', root },
		state: { buffers: [{ name: '' }] }
	} as Session;
	const other = {
		workspace: { id: 'other', root: join(root, 'src') },
		state: { buffers: [{ name: join(root, 'src/file.txt') }] }
	} as Session;
	const sessions = new Map([
		['current', current],
		['mirror', mirror],
		['other', other]
	]);
	const sleeping: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	registerFileHandlers({
		handle: (name, action) => handlers.set(name, action),
		session: (id) => sessions.get(String(id))!,
		text: (value) => {
			assert.equal(typeof value, 'string');
			return value as string;
		},
		integer: (value) => Number(value),
		sessions,
		sleepingFiles: () => sleeping,
		send: (event) => sent.push(event),
		trash
	});
	const fileAction = (action: string, path = 'src'): Promise<void> =>
		handlers.get('fileAction')!('current', action, path) as Promise<void>;

	for (const action of ['rename', 'delete', 'copy']) {
		await assert.rejects(fileAction(action), /other workspace session/);
		await assert.rejects(fileAction(action, 'src/file.txt'), /other workspace session/);
	}
	await assert.rejects(fileAction('invalid'), /Invalid file action/);
	assert.deepEqual(mutations, []);
	assert.deepEqual(sent, []);

	// A sibling with the same prefix is outside the selected directory.
	other.state.buffers[0].name = join(root, 'src-sibling/file.txt');
	// A sleeping workspace has no Session, but reopens its files when it wakes.
	sleeping.push(join(root, 'src/file.txt'));
	for (const action of ['rename', 'delete', 'copy']) {
		await assert.rejects(fileAction(action), /other workspace session/);
	}
	assert.deepEqual(mutations, []);
	sleeping[0] = join(root, 'src-sibling/file.txt');
	await fileAction('delete');
	assert.deepEqual(mutations, [['delete', 'src', '', trash]]);
	assert.deepEqual(sent, [
		{ type: 'filesChanged', id: 'current' },
		{ type: 'filesChanged', id: 'mirror' }
	]);
	await (mutations[0][3] as typeof trash)(join(root, 'src'));
	assert.deepEqual(trashed, [join(root, 'src')]);

	sent.length = 0;
	current.fileAction = async () => {
		throw new Error('File operation failed');
	};
	await assert.rejects(fileAction('delete'), /File operation failed/);
	assert.deepEqual(sent, []);

	const watch = handlers.get('watchDirectories')!;
	for (const paths of ['src', [1], ['a'.repeat(4097)]]) {
		assert.throws(() => watch('current', paths), /Invalid directory selection/);
	}
	await watch('current', ['src']);
	const search = handlers.get('searchText')!;
	for (const options of [null, [], 'invalid']) {
		assert.throws(() => search('current', 'needle', options), /Invalid search options/);
	}
	await search('current', 'needle');
	assert.throws(
		() => handlers.get('previewReplacement')!('current', 'token', 'replacement', null),
		/Choose matching lines/
	);
});

for (const action of ['rename', 'copy'] as const) {
	for (const folder of [false, true]) {
		for (const sleeping of [false, true]) {
			test(`${action} protects a ${folder ? 'folder child' : 'file'} destination in another ${sleeping ? 'sleeping' : 'active'} workspace`, async () => {
				const root = resolve('file-destination-handler-fixture');
				const destination = join(root, 'actual/target');
				let openFile = folder ? join(destination, 'notes.txt') : destination;
				const mutations: unknown[][] = [];
				const current = {
					workspace: { id: 'current', root },
					state: { buffers: [] },
					// The destination's parent can be reached through an in-workspace link.
					path: async (path: string) =>
						path === 'alias' ? join(root, 'actual') : resolve(root, path),
					fileAction: async (...args: unknown[]) => mutations.push(args)
				} as unknown as Session;
				const other = {
					workspace: { id: 'other', root },
					state: { buffers: [{ name: openFile, modified: true }] }
				} as Session;
				const sessions = new Map([
					['current', current],
					...(!sleeping ? [['other', other] as const] : [])
				]);
				const handlers = new Map<string, (...args: unknown[]) => unknown>();
				registerFileHandlers({
					handle: (name, action) => handlers.set(name, action),
					session: (id) => sessions.get(String(id))!,
					text: (value) => String(value),
					integer: Number,
					sessions,
					sleepingFiles: () => (sleeping ? [openFile] : []),
					send: () => {},
					trash: async () => {}
				});
				const run = (): Promise<void> =>
					handlers.get('fileAction')!(
						'current',
						action,
						'source',
						'alias/target'
					) as Promise<void>;
				await assert.rejects(run(), /other workspace session/);
				assert.deepEqual(mutations, []);
				// The shared prefix does not put a neighboring file or directory inside the destination.
				openFile = folder
					? join(`${destination}-sibling`, 'notes.txt')
					: `${destination}-sibling`;
				other.state.buffers[0].name = openFile;
				await run();
				assert.equal(mutations.length, 1);
			});
		}
	}
}

test('the folder picker lists the Windows drives that can be opened, and none elsewhere', async () => {
	const checked: string[] = [];
	const readable = async (root: string): Promise<boolean> => {
		checked.push(root);
		if (root === 'E:\\') {
			throw new Error('The device is not ready.');
		}
		return root === 'C:\\' || root === 'D:\\' || root === 'Z:\\';
	};
	assert.deepEqual(await windowsDrives('win32', readable), ['C:\\', 'D:\\', 'Z:\\']);
	assert.equal(checked.length, 26);
	assert.deepEqual(await windowsDrives('linux', readable), []);
	assert.equal(checked.length, 26);
});

test('quick open matches folder separators typed either way', async () => {
	// On Windows, listed paths use backslashes.
	const listing: Record<string, FileEntry[]> = {
		'': [
			{ name: 'src', path: 'src', directory: true },
			{ name: 'README.md', path: 'README.md', directory: false }
		],
		src: [{ name: 'main', path: 'src\\main', directory: true }],
		'src\\main': [{ name: 'index.ts', path: 'src\\main\\index.ts', directory: false }]
	};
	// Every listed folder resolves to one real folder, which the listing cache can stat.
	const folder = await mkdtemp(join(tmpdir(), 'nido-quick-open-'));
	try {
		const search = new SessionSearch(
			folder,
			async () => folder,
			async (path) => listing[path] ?? [],
			{ clear: () => {} } as unknown as WorkspaceReplacement
		);
		for (const query of ['src/main/index', 'src\\main\\index', 'SRC/Main/INDEX.ts']) {
			assert.deepEqual(
				(await search.findFiles(query)).map((file) => file.path),
				['src\\main\\index.ts'],
				query
			);
		}
		assert.deepEqual(await search.findFiles('src/other'), []);
		// The palette filters the results again with the same query.
		const items = (await search.findFiles('src/main')).map((file) => ({
			key: '',
			title: file.name,
			detail: file.path,
			run: () => {}
		}));
		assert.deepEqual(
			filterItems(items, 'src/main/index').map((item) => item.detail),
			['src\\main\\index.ts']
		);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});
