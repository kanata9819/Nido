import { createContext, useCallback, useContext, useMemo } from 'react';
import {
	createTranslator,
	translateMessage,
	type Language,
	type Translator
} from '../../shared/i18n';

/** The UI language, provided at the root of the app. */
export const LanguageContext = createContext<Language>('en');

/** The translator for the current UI language: it maps an English message to the UI language. */
export function useI18n(): Translator {
	const language = useContext(LanguageContext);
	return useMemo(() => createTranslator(language), [language]);
}

/**
 * The message of a failed request without the prefix that Electron adds to an error from the
 * main process ("Error: Error invoking remote method 'nido:...': Error: ").
 */
export function remoteErrorText(error: unknown): string {
	return String(error).replace(
		/^Error: (?:Error invoking remote method '[^']*': (?:Error: )?)?/,
		''
	);
}

/**
 * Text for a failed request, as a panel shows it: without Electron's prefix, and translated
 * when the message is a known one.
 */
export function useErrorMessage(): (error: unknown) => string {
	const language = useContext(LanguageContext);
	return useCallback((error) => translateMessage(language, remoteErrorText(error)), [language]);
}
