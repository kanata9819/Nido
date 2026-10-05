import { createContext, useContext, useMemo } from 'react';
import { createTranslator, type Language, type Translator } from '../../shared/i18n';

export const LanguageContext = createContext<Language>('en');

export function useI18n(): Translator {
    const language = useContext(LanguageContext);
    return useMemo(() => createTranslator(language), [language]);
}
