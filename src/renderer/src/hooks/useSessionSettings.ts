import { useEffect, useRef } from 'react';
import type { Workspace } from '../../../shared/types';
import type { EditorSettings } from './useEditorSettings';

export type SessionSettings = Pick<
  EditorSettings,
  'clipboardSharing' | 'relativeLineNumbers' | 'editorConfig' | 'wordWrap' | 'methodSeparators'
>;

export function useSessionSettings(
  workspaces: Workspace[],
  {
    clipboardSharing,
    relativeLineNumbers,
    editorConfig,
    wordWrap,
    methodSeparators
  }: SessionSettings,
  setError: (message: string) => void
): void {
  const applied = useRef(
    new Map<string, Partial<Record<keyof SessionSettings, { value: boolean }>>>()
  );
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
      if (previous[key]?.value === value) {
        return;
      }
      // Record queued requests too, so rerenders do not duplicate in-flight work.
      const request = { value };
      applied.current.set(id, { ...previous, [key]: request });
      void update(id, value).catch((error) => {
        const latest = applied.current.get(id);
        if (latest?.[key] !== request) {
          return;
        }
        delete latest[key];
        setError(String(error));
      });
    };
    for (const workspace of workspaces) {
      apply(workspace.id, 'clipboardSharing', clipboardSharing, window.nido.setClipboardSharing);
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
        apply(workspace.id, 'methodSeparators', methodSeparators, window.nido.setMethodSeparators);
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
  }, [
    clipboardSharing,
    relativeLineNumbers,
    editorConfig,
    wordWrap,
    methodSeparators,
    workspaces,
    setError
  ]);
}
