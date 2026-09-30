import { useEffect } from 'react';
import type { Workspace } from '../../../shared/types';
import type { EditorSettings } from './useEditorSettings';

export function useSessionSettings(
    workspaces: Workspace[],
    { clipboardSharing, relativeLineNumbers, editorConfig }: EditorSettings,
    setError: (message: string) => void
): void {
    useEffect(() => {
        for (const workspace of workspaces) {
            for (const id of [workspace.id, workspace.terminalId]) {
                if (id) {
                    void window.nido
                        .setClipboardSharing(id, clipboardSharing)
                        .catch((error) => setError(String(error)));
                }
            }
        }
    }, [clipboardSharing, workspaces]);
    useEffect(() => {
        for (const workspace of workspaces) {
            if (workspace.kind !== 'terminal') {
                void window.nido
                    .setRelativeLineNumbers(workspace.id, relativeLineNumbers)
                    .catch((error) => setError(String(error)));
            }
        }
    }, [relativeLineNumbers, workspaces]);
    useEffect(() => {
        for (const workspace of workspaces) {
            if (workspace.kind !== 'terminal') {
                void window.nido
                    .setEditorConfig(workspace.id, editorConfig)
                    .catch((error) => setError(String(error)));
            }
        }
    }, [editorConfig, workspaces]);
}
