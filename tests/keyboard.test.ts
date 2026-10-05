import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vimKey } from '../src/renderer/src/grid';
import { useEditorInput as createEditorInput } from '../src/renderer/src/hooks/useEditorInput';
import { useKeyboardShortcuts as createKeyboardHandler } from '../src/renderer/src/hooks/useKeyboardShortcuts';

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
                setError: unexpected,
                setFocusTick: unexpected,
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
        for (const key of ['p', 's', '@', '1', ' ']) {
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
