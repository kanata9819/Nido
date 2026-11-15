import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	byRecentUse,
	recentCommandIds,
	rememberCommand
} from '../src/renderer/src/palette/recentCommands';
import type { Item } from '../src/renderer/src/types';

const command = (id: string): Item => ({ id, key: '', title: id, detail: '', run: () => {} });

test('recently run commands come first, newest first, and the rest keep their order', () => {
	const commands = ['Save file', 'Find file', 'Problems', 'Settings'].map(command);
	const ordered = byRecentUse(commands, ['Settings', 'Find file', 'Removed command']);
	assert.deepEqual(
		ordered.map(({ title, recent }) => [title, !!recent]),
		[
			['Settings', true],
			['Find file', true],
			['Save file', false],
			['Problems', false]
		]
	);
	assert.deepEqual(byRecentUse(commands, []), commands);
});

test('remembering a command moves it to the front and keeps five', () => {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		}
	});
	try {
		for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) {
			rememberCommand(id);
		}
		assert.deepEqual(recentCommandIds(), ['b', 'f', 'e', 'd', 'c']);
		values.set('nido.recentCommands', 'not json');
		assert.deepEqual(recentCommandIds(), []);
	} finally {
		Reflect.deleteProperty(globalThis, 'localStorage');
	}
});
