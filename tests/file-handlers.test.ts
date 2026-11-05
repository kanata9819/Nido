import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { registerFileHandlers } from '../src/main/fileHandlers';
import type { Session } from '../src/main/session';
import type { NidoEvent } from '../src/shared/types';

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
