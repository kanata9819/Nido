import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslator, japanese, parseLanguage, translate } from '../src/shared/i18n';
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
    assert.equal(translate('en', 'Ln {line}, Col {column}', { line: 12, column: 3 }), 'Ln 12, Col 3');
    assert.equal(translate('ja', 'Ln {line}, Col {column}', { line: 12, column: 3 }), '12 行、3 列');
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
        showPanel: (panel: unknown): void => { panels.push(panel); },
        moveWorkspace: noop,
        run: noop,
        focusEditor: noop,
        closeWorkspace: noop,
        create: async (): Promise<void> => {},
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
        current: 1, mode: 'n', line: 1, column: 1, filetype: ''
    };
    const english = buildItems('alpha', 'commands', workspaces, [], state, '', callbacks);
    const japaneseItems = buildItems('alpha', 'commands', workspaces, [], state, '設定', callbacks, createTranslator('ja'));
    assert.deepEqual(japaneseItems.commands.map((item) => item.key), english.commands.map((item) => item.key));
    assert.equal(japaneseItems.filtered.length, 1);
    assert.equal(japaneseItems.filtered[0].title, '設定');
    japaneseItems.filtered[0].run();
    assert.deepEqual(panels, ['settings']);
    assert.equal(english.commands.find((item) => item.key === ',')?.title, 'Settings');
    const projects = buildItems('alpha', 'workspaces', workspaces, [], state, '', callbacks, createTranslator('ja'));
    assert.equal(projects.items[0].title, 'Settings');
    const files = buildItems('alpha', 'buffers', workspaces, [], state, '', callbacks, createTranslator('ja'));
    assert.equal(files.items[0].title, 'Settings');
});
