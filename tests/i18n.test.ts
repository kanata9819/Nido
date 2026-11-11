import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createTranslator,
	japanese,
	parseLanguage,
	translate,
	translateMessage
} from '../src/shared/i18n';
import { buildItems } from '../src/renderer/src/commands';
import type { SessionState, Workspace } from '../src/shared/types';

test('missing or unsupported saved languages keep the existing English default', () => {
	for (const value of [null, undefined, '', 'fr', 'JA', 1, {}, 'en']) {
		assert.equal(parseLanguage(value), 'en');
	}
	assert.equal(parseLanguage('ja'), 'ja');
});

test('Japanese messages preserve interpolation fields and accept literal file names', () => {
	const placeholders = (message: string): string[] =>
		[...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
	for (const [english, translated] of Object.entries(japanese)) {
		assert.ok(translated.trim(), `Empty translation: ${english}`);
		assert.deepEqual(placeholders(translated), placeholders(english), english);
		assert.equal(translate('en', english), english);
	}
	const name = '日本語 $1 {name}.ts';
	assert.equal(translate('ja', 'Close file {name}', { name }), `ファイル ${name} を閉じる`);
	assert.equal(
		translate('en', 'Ln {line}, Col {column}', { line: 12, column: 3 }),
		'Ln 12, Col 3'
	);
	assert.equal(
		translate('ja', 'Ln {line}, Col {column}', { line: 12, column: 3 }),
		'12 行、3 列'
	);
});

test('external tool messages and object property names are preserved', () => {
	for (const message of ['External LSP error', 'constructor', '__proto__', 'toString']) {
		assert.equal(translate('ja', message), message);
	}
});

test('translated command searches keep shortcut keys and actions, and preserve project names', () => {
	const panels: unknown[] = [];
	const noop = (): void => {};
	const callbacks = {
		save: noop,
		showPanel: (panel: unknown): void => {
			panels.push(panel);
		},
		moveWorkspace: noop,
		run: noop,
		focusEditor: noop,
		captureFocus: () => () => true,
		closeWorkspace: noop,
		create: async (): Promise<void> => {},
		createTerminal: async (): Promise<void> => {},
		showFavorites: async (): Promise<void> => {},
		showExplorer: noop,
		openDebugger: noop,
		openFile: noop,
		activate: noop,
		toggleFavorite: noop,
		isFavorite: false
	};
	const workspaces: Workspace[] = [{ id: 'alpha', name: 'Settings', root: '/Settings' }];
	const state: SessionState = {
		buffers: [{ id: 1, name: '/Settings/Settings', modified: false }],
		current: 1,
		mode: 'n',
		line: 1,
		column: 1,
		filetype: ''
	};
	const english = buildItems('alpha', 'commands', workspaces, [], state, '', callbacks);
	const japaneseItems = buildItems(
		'alpha',
		'commands',
		workspaces,
		[],
		state,
		'設定',
		callbacks,
		createTranslator('ja')
	);
	assert.deepEqual(
		japaneseItems.commands.map((item) => item.key),
		english.commands.map((item) => item.key)
	);
	assert.equal(japaneseItems.filtered.length, 1);
	assert.equal(japaneseItems.filtered[0].title, '設定');
	japaneseItems.filtered[0].run();
	assert.deepEqual(panels, ['settings']);
	assert.equal(english.commands.find((item) => item.key === ',')?.title, 'Settings');
	for (const title of ['Toggle line comments', 'Undo', 'Redo']) {
		assert.ok(english.commands.some((item) => item.title === title));
		assert.ok(japaneseItems.commands.some((item) => item.title === translate('ja', title)));
	}
	const terminal = buildItems(
		'alpha',
		'commands',
		[{ ...workspaces[0], kind: 'terminal' }],
		[],
		state,
		'',
		callbacks
	);
	for (const title of ['Toggle line comments', 'Undo', 'Redo']) {
		assert.ok(!terminal.commands.some((item) => item.title === title));
	}
	const projects = buildItems(
		'alpha',
		'workspaces',
		workspaces,
		[],
		state,
		'',
		callbacks,
		createTranslator('ja')
	);
	assert.equal(projects.items[0].title, 'Settings');
	const files = buildItems(
		'alpha',
		'buffers',
		workspaces,
		[],
		state,
		'',
		callbacks,
		createTranslator('ja')
	);
	assert.equal(files.items[0].title, 'Settings');
});

test('every literal message passed to t() has a Japanese translation', async () => {
	const root = fileURLToPath(new URL('../src', import.meta.url));
	const files = (await readdir(root, { recursive: true })).filter((file) => /\.tsx?$/.test(file));
	const missing: string[] = [];
	for (const file of files) {
		const source = await readFile(join(root, file), 'utf8');
		for (const [, literal] of source.matchAll(/\bt\(\s*('(?:\\.|[^'\\])*')\s*[,)]/g)) {
			const message = JSON.parse(
				`"${literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"')}"`
			) as string;
			if (!Object.hasOwn(japanese, message)) {
				missing.push(`${file}: ${message}`);
			}
		}
	}
	assert.deepEqual(missing, []);
});

test('main-process error messages are translated, with their values and prefixes kept', () => {
	assert.equal(
		translateMessage('ja', 'Workspace is no longer running.'),
		'このワークスペースはすでに終了しています。'
	);
	assert.equal(
		translateMessage('ja', 'Neovim for Alpha stopped unexpectedly (exit code 3221225477).'),
		'AlphaのNeovimが予期せず終了しました（終了コード3221225477）。'
	);
	assert.equal(
		translateMessage(
			'ja',
			'Neovim for Beta stopped unexpectedly (signal SIGTERM).\nstderr line'
		),
		'BetaのNeovimが予期せず終了しました（シグナルSIGTERM）。\nstderr line'
	);
	assert.equal(
		translateMessage('ja', 'C:\\project: Error: Choose a project folder.'),
		'C:\\project: プロジェクトのフォルダーを選んでください。'
	);
	assert.equal(
		translateMessage('ja', 'Error: Workspace was closed.'),
		'ワークスペースは閉じられました。'
	);
	// Messages that the editor's Lua code raises with the file or shell they are about.
	assert.equal(
		translateMessage('ja', 'File is unavailable: C:\\work\\notes.txt'),
		'ファイルを開けません：C:\\work\\notes.txt'
	);
	assert.equal(
		translateMessage('ja', 'Shell is not installed or not on PATH: pwsh.exe'),
		'シェルがインストールされていないか、PATHにありません：pwsh.exe'
	);
	assert.equal(
		translateMessage('ja', 'Language server exited (1, 0).'),
		'言語サーバーが終了しました（1、0）。'
	);
	assert.equal(
		translateMessage('ja', 'pwsh.exe is not installed or is not on PATH.'),
		'pwsh.exeがインストールされていないか、PATHにありません。'
	);
	assert.equal(
		translateMessage('ja', 'Stage changes before committing.'),
		'コミットする前に、変更をステージしてください。'
	);
	// Unknown messages, such as output from external tools, and UI-label templates stay as they are.
	for (const message of ['tsserver: unexpected token', 'Line 5', 'Workspace Alpha']) {
		assert.equal(translateMessage('ja', message), message);
	}
	assert.equal(
		translateMessage('en', 'Workspace is no longer running.'),
		'Workspace is no longer running.'
	);
});

/**
 * Messages that the main process or the editor's Lua code raises, but that only guard against
 * requests the interface never makes, or that are for developers: they need no translation.
 * Anything a user can meet belongs in the Japanese table instead.
 */
const untranslatedMessages = new Set([
	// Validation of IPC arguments, which the interface always sends in the expected form.
	'Expected a project-relative path.',
	'Expected a WSL file path.',
	'Invalid buffer',
	'Invalid branch action.',
	'Invalid clipboard setting.',
	'Invalid commit.',
	'Invalid completion index.',
	'Invalid debug action',
	'Invalid directory selection.',
	'Invalid EditorConfig setting.',
	'Invalid favorite workspace.',
	'Invalid file action.',
	'Invalid Git selection.',
	'Invalid history offset.',
	'Invalid history setting.',
	'Invalid indent size',
	'Invalid indentation',
	'Invalid language pack selection.',
	'Invalid language.',
	'Invalid line ending',
	'Invalid line number setting.',
	'Invalid method separator setting.',
	'Invalid mouse position.',
	'Invalid number.',
	'Invalid scroll distance',
	'Invalid session type.',
	'Invalid symbol list',
	'Invalid target buffer',
	'Invalid terminal command.',
	'Invalid terminal shell.',
	'Invalid text.',
	'Invalid theme.',
	'Invalid word wrap setting.',
	'Invalid workspace layout.',
	'Invalid WSL distribution.',
	'Not a terminal session.',
	'Unknown built-in language adapter',
	'Unknown file action.',
	'Unknown update action.',
	'Unknown window action.',
	'Unsupported documentation URL.',
	'Untrusted sender.',
	// Damaged settings files, reported with the file's own details.
	'Invalid favorite workspace data.',
	'Invalid language pack settings.',
	// A superseded or cancelled request, which the interface discards without showing.
	'Git preview session is closed.',
	'Git preview was superseded.',
	'History preview was superseded.',
	'Search cancelled.',
	'Search worker exited.',
	// For language pack authors, naming the pack's own settings.
	'Invalid LSP command argument',
	'Invalid LSP configuration: ',
	'Invalid language pack configuration: ',
	'No command configured for ',
	'TypeScript native package has no CLI entry point',
	'typescript.command must be an argument array',
	'typescript.server must be auto, native or legacy',
	// Internal failures, reported with details that are only useful in a bug report.
	'Bracket analysis failed: ',
	// A language server's own message, which Nido only labels.
	'LSP[%s][%s] %s'
]);

function sourceFiles(directory: string, extension: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(directory, entry.name), extension)
			: entry.name.endsWith(extension)
				? [join(directory, entry.name)]
				: []
	);
}

test('messages raised by the main process and the editor have Japanese translations', () => {
	const patterns = {
		ts: [
			/new Error\(\s*'((?:[^'\\\n]|\\.)+)'/g,
			// A message chosen by a condition, such as "Git is not installed or is not on PATH."
			/\?\s*'([A-Z][^'\n]+[.!?])'\s*:/g
		],
		lua: [
			/\berror\(\s*'([^'\n]+)'/g,
			/\bassert\([^\n]*?,\s*'([^'\n]+)'\s*(?:\)|\.\.)/g,
			/vim\.notify\(\s*'([^'\n]+)'/g,
			/[.{]\s*(?:error|message)\s*=\s*'([^'\n]+)'/g,
			/'error',\s*'([^'\n]+)'/g,
			/\(\s*'([^'\n]*%s[^'\n]*)'\s*\):format/g
		]
	};
	const messages = new Map<string, string>();
	for (const file of [
		...sourceFiles('src/main', '.ts'),
		...sourceFiles('src/shared', '.ts').filter((file) => !file.endsWith('i18n.ts')),
		...sourceFiles('resources/nido', '.lua')
	]) {
		const text = readFileSync(file, 'utf8');
		for (const pattern of patterns[file.endsWith('.lua') ? 'lua' : 'ts']) {
			for (const match of text.matchAll(pattern)) {
				messages.set(match[1].replace(/\\'/g, "'"), file);
			}
		}
	}
	const templates = Object.keys(japanese).map((key) => key.replace(/\{\w+\}/g, '%s'));
	const missing = [...messages]
		.filter(([message]) => {
			if (untranslatedMessages.has(message) || Object.hasOwn(japanese, message)) {
				return false;
			}
			// A message completed with a value ('File is unavailable: ' .. path) or formatted
			// with one (%s) needs a template such as "File is unavailable: {path}".
			const pattern = message.endsWith(' ') ? `${message}%s` : message;
			return !templates.includes(pattern);
		})
		.map(([message, file]) => `${file}: ${message}`);
	assert.ok(messages.size > 100, `Found only ${messages.size} messages; check the patterns.`);
	assert.deepEqual(missing, []);
});
