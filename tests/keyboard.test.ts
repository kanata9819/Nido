import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vimKey } from '../src/renderer/src/keyboard';
import { useEditorInput as createEditorInput } from '../src/renderer/src/hooks/useEditorInput';
import { useKeyboardShortcuts as createKeyboardHandler } from '../src/renderer/src/hooks/useKeyboardShortcuts';
import { buildCommands, type CommandsCallbacks } from '../src/renderer/src/commandItems';
import { createTranslator } from '../src/shared/i18n';
import type { SessionState, Workspace } from '../src/shared/types';

function leaderCommands(
	kind: 'editor' | 'terminal',
	named: boolean
): {
	actions: unknown[][];
	commands: ReturnType<typeof buildCommands>;
	state: SessionState;
	workspaces: Workspace[];
} {
	const actions: unknown[][] = [];
	const noop = (): void => {};
	const create = async (): Promise<void> => {};
	const callbacks: CommandsCallbacks = {
		save: noop,
		showPanel: (panel) => {
			actions.push(['panel', panel]);
		},
		moveWorkspace: (offset) => {
			actions.push(['move', offset]);
		},
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
		isFavorite: false
	};
	const workspaces: Workspace[] = [{ id: 'workspace', root: '/project', name: 'Project', kind }];
	const state: SessionState = {
		buffers: [{ id: 1, name: named ? '/project/file.ts' : '', modified: false }],
		current: 1,
		mode: 'n',
		line: 1,
		column: 1,
		filetype: 'typescript'
	};
	const commands = buildCommands(
		'workspace',
		workspaces,
		state,
		callbacks,
		createTranslator('en')
	);
	return { actions, commands, state, workspaces };
}

for (const [kind, named] of [
	['editor', true],
	['editor', false],
	['terminal', false]
] as const) {
	test(`leader keys are unique (${kind} workspace, ${named ? 'named' : 'unnamed'} buffer)`, () => {
		const { commands } = leaderCommands(kind, named);
		const bound = commands.filter(({ key }) => key);
		const seen = new Map<string, string>();
		for (const { key, title } of bound) {
			assert.equal(seen.has(key), false, `${key} is shared by ${seen.get(key)} and ${title}`);
			seen.set(key, title);
		}
	});
}

test('leader h opens history and leader Shift+H/L reorder workspaces', () => {
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const fixture = leaderCommands('editor', true);
	try {
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: {
				activeElement: {
					closest: (): null => null,
					hasAttribute: (): boolean => false,
					getAttribute: (): string => 'editor'
				}
			}
		});
		let handler!: ReturnType<typeof createKeyboardHandler>;
		function KeyboardProbe(): null {
			handler = createKeyboardHandler({
				save: () => {},
				panel: null,
				leader: true,
				error: '',
				dismissError: () => {},
				focusEditor: () => {},
				modal: { current: null },
				mode: { current: { workspace: 'normal' } },
				active: 'workspace',
				workspaces: fixture.workspaces,
				nextWorkspace: () => {},
				showExplorer: () => {},
				showDebugger: () => {},
				closeReferences: () => {},
				toggleTerminal: () => {},
				restartShell: () => {},
				create: async () => {},
				showPanel: () => {},
				commands: fixture.commands,
				state: fixture.state,
				run: () => {
					throw new Error('A leader key switched buffer tabs.');
				},
				setLeader: () => {},
				activate: () => {}
			});
			return null;
		}
		renderToStaticMarkup(createElement(KeyboardProbe));
		for (const key of ['h', 'H', 'L']) {
			handler({
				...keyEvent(key, false, key !== 'h'),
				ctrlKey: false,
				altKey: false,
				preventDefault: () => {},
				stopPropagation: () => {}
			} as KeyboardEvent);
		}
		assert.deepEqual(fixture.actions, [
			['panel', 'history'],
			['move', -1],
			['move', 1]
		]);
	} finally {
		if (originalDocument) {
			Object.defineProperty(globalThis, 'document', originalDocument);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
	}
});

function keyEvent(key: string, altGraph = true, shiftKey = false): KeyboardEvent {
	return {
		key,
		ctrlKey: true,
		altKey: true,
		shiftKey,
		metaKey: false,
		isComposing: false,
		getModifierState: (modifier: string): boolean => modifier === 'AltGraph' && altGraph
	} as KeyboardEvent;
}

test('AltGr sends literal characters while ordinary Ctrl+Alt shortcuts keep their modifiers', () => {
	for (const key of ['@', '{', '}', '\\', '<', '日']) {
		for (const shift of [false, true]) {
			assert.equal(vimKey(keyEvent(key, true, shift)), key === '<' ? '<LT>' : key);
		}
	}
	assert.equal(vimKey(keyEvent('q', false)), '<C-M-q>');
	assert.equal(vimKey(keyEvent('q', false, true)), '<C-M-S-q>');
	assert.equal(vimKey(keyEvent('AltGraph')), null);
});

test('named keys without Vim notation are not typed as text', () => {
	const press = (key: string, ctrlKey = false): string | null =>
		vimKey({
			key,
			ctrlKey,
			altKey: false,
			shiftKey: false,
			metaKey: false,
			isComposing: false
		});
	for (const key of [
		'CapsLock',
		'NumLock',
		'ScrollLock',
		'ContextMenu',
		'Pause',
		'PrintScreen',
		'Zenkaku',
		'Hankaku',
		'KanjiMode',
		'Convert',
		'NonConvert',
		'KanaMode',
		'Alphanumeric',
		'AudioVolumeUp'
	]) {
		assert.equal(press(key), null, key);
		assert.equal(press(key, true), null, key);
	}
	// Single characters, including ones outside the BMP, and keys with notation still pass.
	assert.equal(press('a'), 'a');
	assert.equal(press('\u{20BB7}'), '\u{20BB7}');
	assert.equal(press('F12'), '<F12>');
	assert.equal(press('Escape'), '<Esc>');
	assert.equal(press('a', true), '<C-a>');
});

test('global shortcuts leave AltGr input available to the editor', () => {
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const unexpected = (): never => {
		throw new Error('An application shortcut consumed AltGr input.');
	};
	try {
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: {
				activeElement: {
					closest: (): null => null,
					hasAttribute: (): boolean => false,
					getAttribute: (name: string): string =>
						name === 'data-editor-input' ? 'editor' : 'Neovim input'
				}
			}
		});
		let handler!: ReturnType<typeof createKeyboardHandler>;
		function KeyboardProbe(): null {
			handler = createKeyboardHandler({
				save: unexpected,
				panel: null,
				leader: false,
				error: '',
				dismissError: unexpected,
				focusEditor: unexpected,
				modal: { current: null },
				mode: { current: { workspace: 'normal' } },
				active: 'workspace',
				workspaces: [],
				nextWorkspace: unexpected,
				showExplorer: unexpected,
				showDebugger: unexpected,
				closeReferences: unexpected,
				toggleTerminal: unexpected,
				restartShell: unexpected,
				create: unexpected,
				showPanel: unexpected,
				commands: [],
				state: { buffers: [], current: 0, filetype: '' },
				run: unexpected,
				setLeader: unexpected,
				activate: unexpected
			});
			return null;
		}
		renderToStaticMarkup(createElement(KeyboardProbe));
		for (const key of ['p', 's', 'x', '@', '1', ' ']) {
			handler({
				...keyEvent(key),
				preventDefault: unexpected,
				stopPropagation: unexpected
			} as KeyboardEvent);
		}
	} finally {
		if (originalDocument) {
			Object.defineProperty(globalThis, 'document', originalDocument);
		} else {
			Reflect.deleteProperty(globalThis, 'document');
		}
	}
});

test('editor input sends AltGr characters without invoking clipboard shortcuts', () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const sent: string[] = [];
	let clipboardPastes = 0;
	try {
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: {
				nido: {
					input: async (_id: string, key: string): Promise<void> => {
						sent.push(key);
					},
					pasteClipboard: async (): Promise<void> => {
						clipboardPastes++;
					}
				}
			}
		});
		const input = createEditorInput({
			id: 'workspace',
			blocked: false,
			composingRef: { current: false },
			paintRef: { current: (): void => {} },
			onError: (error): never => {
				throw new Error(error);
			}
		});
		for (const key of ['@', '{', '<', 'v']) {
			const nativeEvent = keyEvent(key, true, true);
			input.onKeyDown({
				...nativeEvent,
				nativeEvent,
				preventDefault: (): void => {}
			} as Parameters<typeof input.onKeyDown>[0]);
		}
		assert.deepEqual(sent, ['@', '{', '<LT>', 'v']);
		assert.equal(clipboardPastes, 0);
		const nativeEvent = { ...keyEvent('v', false, true), altKey: false };
		input.onKeyDown({
			...nativeEvent,
			nativeEvent,
			preventDefault: (): void => {}
		} as Parameters<typeof input.onKeyDown>[0]);
		assert.equal(clipboardPastes, 1);
	} finally {
		if (originalWindow) {
			Object.defineProperty(globalThis, 'window', originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, 'window');
		}
	}
});
