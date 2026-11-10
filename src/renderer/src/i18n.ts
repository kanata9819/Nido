import { createContext, useCallback, useContext, useMemo } from 'react';
import {
	createTranslator,
	translateMessage,
	type Language,
	type Translator
} from '../../shared/i18n';

export const LanguageContext = createContext<Language>('en');

export function useI18n(): Translator {
	const language = useContext(LanguageContext);
	return useMemo(() => createTranslator(language), [language]);
}

/**
 * Text for a failed request, as a panel shows it: without the prefix that Electron adds to
 * an error from the main process, and translated when the message is a known one.
 */
export function useErrorMessage(): (error: unknown) => string {
	const language = useContext(LanguageContext);
	return useCallback(
		(error) =>
			translateMessage(
				language,
				String(error).replace(
					/^Error: (?:Error invoking remote method '[^']*': (?:Error: )?)?/,
					''
				)
			),
		[language]
	);
}
