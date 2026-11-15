// UI translations. Messages are written in English in the code; the English text is the key
// of its Japanese translation in locales/ja.ts. {name} placeholders are filled from the values.
import { japanese } from './locales/ja';

export { japanese };

/** The UI languages. */
export type Language = 'en' | 'ja';
/** Values for the {name} placeholders of a message. */
export type TranslationValues = Record<string, string | number>;
/** Translates an English message into the UI language. */
export type Translator = (message: string, values?: TranslationValues) => string;

/** A saved language setting, or English when it is not a supported language. */
export function parseLanguage(value: unknown): Language {
	return value === 'ja' ? 'ja' : 'en';
}

/** Translate a message and fill in its placeholders; unknown messages stay in English. */
export function translate(
	language: Language,
	message: string,
	values: TranslationValues = {}
): string {
	const template =
		language === 'ja' && Object.hasOwn(japanese, message) ? japanese[message] : message;
	return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : placeholder
	);
}

/**
 * Main-process messages that carry values, such as a workspace name or an exit code. A
 * message is matched against these, not against every template: UI labels such as
 * "Line {line}" could otherwise match unrelated text.
 */
const messageTemplates = [
	'Neovim for {name} stopped unexpectedly (exit code {code}).',
	'Neovim for {name} stopped unexpectedly (signal {signal}).',
	'Neovim connection closed: {message}',
	'Bundled editor resource is missing: {file}. Reinstall Nido, or run pnpm prepare:neovim in development.',
	'File is unavailable: {path}',
	'Shell is not installed or not on PATH: {command}',
	'Could not start {command}',
	'{command} is not installed or is not on PATH.',
	'Language server exited ({code}, {signal}).',
	'Invalid symbols returned by the language server: {reason}',
	'TS7 LSP not found. Install TypeScript 7 in the project or set typescript.command in {path}'
].map((template) => ({
	template,
	pattern: new RegExp(
		`^${template
			.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
			.replace(/\{(\w+)\}/g, (_, name: string) => `(?<${name}>.+)`)}$`,
		's'
	)
}));

/** Translate one line of a main-process message (see translateMessage). */
function translateLine(language: Language, line: string): string {
	if (Object.hasOwn(japanese, line)) {
		return translate(language, line);
	}
	for (const { template, pattern } of messageTemplates) {
		const values = pattern.exec(line)?.groups;
		if (values) {
			return translate(language, template, values);
		}
	}
	// "C:\\project: Error: Choose a project folder." keeps its prefix.
	const nested = /^(.*?)(?:: )?Error: (.+)$/s.exec(line);
	if (nested && nested[2] !== line) {
		const inner = translateLine(language, nested[2]);
		if (inner !== nested[2]) {
			return nested[1] ? `${nested[1]}: ${inner}` : inner;
		}
	}
	return line;
}

/**
 * Translate a message composed in the main process, line by line: a known message, a known
 * template with its values, or a known message after an "Error: " prefix. Anything else,
 * such as output from external tools, stays as it is.
 */
export function translateMessage(language: Language, message: string): string {
	if (language === 'en') {
		return message;
	}
	return message
		.split('\n')
		.map((line) => translateLine(language, line))
		.join('\n');
}

/** A translator for one language. */
export function createTranslator(language: Language): Translator {
	return (message, values) => translate(language, message, values);
}
