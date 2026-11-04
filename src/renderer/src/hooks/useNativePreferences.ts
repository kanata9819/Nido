import { useEffect, useLayoutEffect } from 'react';
import type { EditorSettings } from './useEditorSettings';

/** Mirrors app-wide settings onto the document and the main process. */
export function useNativePreferences(
  {
    theme,
    language,
    historyEnabled
  }: Pick<EditorSettings, 'theme' | 'language' | 'historyEnabled'>,
  report: (message: string) => void
): void {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    void window.nido.setTheme(theme).catch((error) => report(String(error)));
  }, [theme, report]);
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    void window.nido.setLanguage(language).catch((error) => report(String(error)));
  }, [language, report]);
  useEffect(() => {
    void window.nido.setHistoryEnabled(historyEnabled).catch((error) => report(String(error)));
  }, [historyEnabled, report]);
}
