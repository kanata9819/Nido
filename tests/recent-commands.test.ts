import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	byRecentUse,
	recentCommandIds,
	rememberCommand
} from '../src/renderer/src/palette/recentCommands';
import type { Item } from '../src/renderer/src/types';
import { buildCommands, type CommandsCallbacks } from '../src/renderer/src/palette/commandItems';
import { createTranslator } from '../src/shared/i18n';
import type { SessionState, Workspace } from '../src/shared/types';

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

function buildFor(language: 'en' | 'ja', isFavorite: boolean): Item[] {
	const noop = (): void => {};
	const create = async (): Promise<void> => {};
	const callbacks: CommandsCallbacks = {
		save: noop,
		showPanel: noop,
		moveWorkspace: noop,
		run: noop,
		focusEditor: noop,
		captureFocus: () => () => true,
		closeWorkspace: noop,
		create,
		createTerminal: create,
		showFavorites: create,
		showExplorer: noop,
		openDebugger: noop,
		openFile: noop,
		activate: noop,
		toggleFavorite: noop,
		sleepWorkspace: noop,
		isFavorite
	};
	const workspaces: Workspace[] = [{ id: 'w', root: '/project', name: 'Project' }];
	const state: SessionState = {
		buffers: [{ id: 1, name: '/project/a.ts', modified: false }],
		current: 1,
		mode: 'n',
		line: 1,
		column: 1,
		filetype: 'typescript',
		indentation: { spaces: true, size: 4 }
	};
	return buildCommands('w', workspaces, state, callbacks, createTranslator(language));
}

function withStorage(run: () => void): void {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		}
	});
	// Commands call window.nido; these tests only look at what they remember.
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { nido: new Proxy({}, { get: () => async () => {} }) }
	});
	try {
		run();
	} finally {
		Reflect.deleteProperty(globalThis, 'localStorage');
		Reflect.deleteProperty(globalThis, 'window');
	}
}

test('command ids stay the same across languages and toggled titles', () => {
	const ids = (commands: Item[]): string[] => commands.map((command) => command.id!);
	assert.deepEqual(ids(buildFor('ja', false)), ids(buildFor('en', false)));
	assert.deepEqual(ids(buildFor('en', true)), ids(buildFor('en', false)));
	withStorage(() => {
		const find = (commands: Item[], title: string): Item =>
			commands.find((command) => command.title === title)!;
		find(buildFor('en', false), 'Add workspace to favorites').run();
		find(buildFor('ja', false), '改行コードをCRLFに変換').run();
		const after = byRecentUse(buildFor('en', true), recentCommandIds());
		assert.deepEqual(
			after.slice(0, 2).map(({ title }) => title),
			['Convert line endings to CRLF', 'Remove workspace from favorites']
		);
	});
});

test('commands that close or hide something are not offered again first', () => {
	withStorage(() => {
		const commands = buildFor('en', false);
		for (const title of ['Settings', 'Quit Nido', 'Close workspace', 'Minimize window']) {
			commands.find((command) => command.title === title)!.run();
		}
		assert.deepEqual(recentCommandIds(), ['Settings']);
	});
});
