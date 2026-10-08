import { useEffect, useRef } from 'react';
import type { Workspace } from '../../../shared/types';
import type { EditorSettings } from './useEditorSettings';

export type SessionSettings = Pick<
    EditorSettings,
    'clipboardSharing' | 'relativeLineNumbers' | 'editorConfig' | 'wordWrap'
>;

export function useSessionSettings(
    workspaces: Workspace[],
    { clipboardSharing, relativeLineNumbers, editorConfig, wordWrap }: SessionSettings,
    setError: (message: string) => void
): void {
    const applied = useRef(new Map<string, Partial<SessionSettings>>());
    useEffect(() => {
        const currentIds = new Set<string>();
        const apply = (
            id: string,
            key: keyof SessionSettings,
            value: boolean,
            update: (id: string, value: boolean) => Promise<void>
        ): void => {
            currentIds.add(id);
            const previous = applied.current.get(id) || {};
            if (previous[key] === value) {
                return;
            }
            // Record queued requests too, so rerenders do not duplicate in-flight work.
            applied.current.set(id, { ...previous, [key]: value });
            void update(id, value).catch((error) => {
                const latest = applied.current.get(id);
                if (latest?.[key] === value) {
                    delete latest[key];
                }
                setError(String(error));
            });
        };
        for (const workspace of workspaces) {
            apply(
                workspace.id,
                'clipboardSharing',
                clipboardSharing,
                window.nido.setClipboardSharing
            );
            if (workspace.terminalId) {
                apply(
                    workspace.terminalId,
                    'clipboardSharing',
                    clipboardSharing,
                    window.nido.setClipboardSharing
                );
            }
            if (workspace.kind !== 'terminal') {
                apply(workspace.id, 'wordWrap', wordWrap, window.nido.setWordWrap);
                apply(
                    workspace.id,
                    'relativeLineNumbers',
                    relativeLineNumbers,
                    window.nido.setRelativeLineNumbers
                );
                apply(workspace.id, 'editorConfig', editorConfig, window.nido.setEditorConfig);
            }
        }
        for (const id of applied.current.keys()) {
            if (!currentIds.has(id)) {
                applied.current.delete(id);
            }
        }
    }, [clipboardSharing, relativeLineNumbers, editorConfig, wordWrap, workspaces, setError]);
}
