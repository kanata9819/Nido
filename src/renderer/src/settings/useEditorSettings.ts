import { terminalShells, uiThemes, type TerminalShell, type UITheme } from '../../../shared/types';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { parseLanguage, type Language } from '../../../shared/i18n';

// Settings of the editor and the UI, saved in the renderer's localStorage.

/** The default font before Meiryo was added to it. */
const previousDefaultFontFamily = '"Cascadia Code", "Consolas", "Yu Gothic UI", monospace';
export const defaultFontFamily = '"Cascadia Code", "Consolas", "Meiryo", "Yu Gothic UI", monospace';
export const defaultFontWeight = 350;
/** Where the activity bar sits: along the left edge or above the explorer. */
export type ActivityBarPosition = 'left' | 'top';

/**
 * State saved in localStorage under `key`. `read` turns the saved text (null when nothing is
 * saved) into a value, falling back to a default for anything invalid.
 */
function useStoredState<T>(
	key: string,
	read: (saved: string | null) => T,
	write: (value: T) => string = String
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState(() => read(localStorage.getItem(key)));
	useEffect(() => {
		localStorage.setItem(key, write(value));
	}, [key, value, write]);
	return [value, setValue];
}

/** A saved on/off setting; `fallback` applies until the user changes it. */
function useStoredFlag(
	key: string,
	fallback: boolean
): [boolean, Dispatch<SetStateAction<boolean>>] {
	return useStoredState(key, (saved) => (fallback ? saved !== 'false' : saved === 'true'));
}

/** A saved number, used when `valid` accepts it. */
function useStoredNumber(
	key: string,
	fallback: number,
	valid: (value: number) => boolean
): [number, Dispatch<SetStateAction<number>>] {
	return useStoredState(key, (saved) => {
		const value = Number(saved);
		return valid(value) ? value : fallback;
	});
}

/**
 * Every user setting of the renderer, each saved in localStorage as nido.<name>. Settings
 * that Neovim or the main process needs are passed on by useSessionSettings and
 * useNativePreferences.
 */
export function useEditorSettings(): EditorSettings {
	const [language, setLanguage] = useStoredState<Language>('nido.language', parseLanguage);
	const [theme, setTheme] = useStoredState<UITheme>('nido.theme', (saved) =>
		uiThemes.includes(saved as UITheme) ? (saved as UITheme) : 'dark'
	);
	const [wordWrap, setWordWrap] = useStoredFlag('nido.wordWrap', true);
	const [historyEnabled, setHistoryEnabled] = useStoredFlag('nido.historyEnabled', true);
	const [methodSeparators, setMethodSeparators] = useStoredFlag('nido.methodSeparators', false);
	const [stickyScroll, setStickyScroll] = useStoredFlag('nido.stickyScroll', true);
	const [stickyScrollMaxLines, setStickyScrollMaxLines] = useStoredNumber(
		'nido.stickyScrollMaxLines',
		5,
		(value) => Number.isInteger(value) && value >= 1 && value <= 10
	);
	const [terminalShell, setTerminalShell] = useStoredState<TerminalShell>(
		'nido.terminalShell',
		(saved) =>
			terminalShells.includes(saved as TerminalShell) ? (saved as TerminalShell) : 'auto'
	);
	const [editorConfig, setEditorConfig] = useStoredFlag('nido.editorConfig', true);
	const [relativeLineNumbers, setRelativeLineNumbers] = useStoredFlag(
		'nido.relativeLineNumbers',
		false
	);
	const [sidebar, setSidebar] = useStoredFlag('nido.sidebar', true);
	const [activityBarPosition, setActivityBarPosition] = useStoredState<ActivityBarPosition>(
		'nido.activityBarPosition',
		(saved) => (saved === 'top' ? 'top' : 'left')
	);
	// Compact mode was called "auto-hide session tabs" before; keep an old choice.
	const [compactMode, setCompactMode] = useStoredState(
		'nido.compactMode',
		(saved) => (saved ?? localStorage.getItem('nido.autoHideSessionTabs')) === 'true'
	);
	const [animations, setAnimations] = useStoredFlag('nido.animations', true);
	const [smoothCursor, setSmoothCursor] = useStoredFlag('nido.smoothCursor', false);
	const [smoothBlink, setSmoothBlink] = useStoredFlag('nido.smoothBlink', false);
	const [scrollFollowCursor, setScrollFollowCursor] = useStoredFlag(
		'nido.scrollFollowCursor',
		true
	);
	const [formatOnSave, setFormatOnSave] = useStoredFlag('nido.formatOnSave', true);
	const [clipboardSharing, setClipboardSharing] = useStoredFlag('nido.clipboardSharing', false);
	// The default font gained Meiryo. A font saved before that change that is still the old
	// default moves to the new one once; the migration flag keeps a later choice of it.
	const [fontFamily, setFontFamily] = useStoredState('nido.fontFamily', (saved) => {
		const migrated = localStorage.getItem('nido.fontFamily.meiryoMigration') === 'true';
		return saved === null || (!migrated && saved === previousDefaultFontFamily)
			? defaultFontFamily
			: saved;
	});
	useEffect(() => {
		localStorage.setItem('nido.fontFamily.meiryoMigration', 'true');
	}, [fontFamily]);
	const [fontWeight, setFontWeight] = useStoredNumber(
		'nido.fontWeight',
		defaultFontWeight,
		(value) => Number.isInteger(value) && value >= 100 && value <= 900
	);
	const [sidebarWidth, setSidebarWidth] = useStoredNumber(
		'nido.sidebarWidth',
		243,
		(value) => Number.isFinite(value) && value >= 160 && value <= 480
	);
	const resizeSidebar = useCallback(
		(width: number): void => {
			setSidebarWidth(Math.max(160, Math.min(480, width)));
		},
		[setSidebarWidth]
	);
	// Half sizes allow finer tuning, e.g. 9.5px between two whole sizes.
	const [fontSize, setFontSize] = useStoredNumber(
		'nido.fontSize',
		15,
		(value) => value >= 8 && value <= 24 && Number.isInteger(value * 2)
	);
	const [lineHeight, setLineHeight] = useStoredNumber(
		'nido.lineHeight',
		18,
		(value) => Number.isInteger(value) && value >= 8 && value <= 80
	);

	return {
		historyEnabled,
		setHistoryEnabled,
		language,
		setLanguage,
		theme,
		setTheme,
		wordWrap,
		setWordWrap,
		methodSeparators,
		setMethodSeparators,
		stickyScroll,
		setStickyScroll,
		stickyScrollMaxLines,
		setStickyScrollMaxLines,
		terminalShell,
		setTerminalShell,
		editorConfig,
		setEditorConfig,
		relativeLineNumbers,
		setRelativeLineNumbers,
		sidebar,
		setSidebar,
		activityBarPosition,
		setActivityBarPosition,
		compactMode,
		setCompactMode,
		animations,
		setAnimations,
		smoothCursor,
		setSmoothCursor,
		smoothBlink,
		setSmoothBlink,
		scrollFollowCursor,
		setScrollFollowCursor,
		formatOnSave,
		setFormatOnSave,
		clipboardSharing,
		setClipboardSharing,
		fontFamily,
		setFontFamily,
		fontWeight,
		setFontWeight,
		fontSize,
		setFontSize,
		lineHeight,
		setLineHeight,
		sidebarWidth,
		resizeSidebar
	};
}

/** Every setting with its setter. */
export interface EditorSettings {
	historyEnabled: boolean;
	setHistoryEnabled: Dispatch<SetStateAction<boolean>>;
	language: Language;
	setLanguage: Dispatch<SetStateAction<Language>>;
	theme: UITheme;
	setTheme: Dispatch<SetStateAction<UITheme>>;
	wordWrap: boolean;
	setWordWrap: Dispatch<SetStateAction<boolean>>;
	methodSeparators: boolean;
	setMethodSeparators: Dispatch<SetStateAction<boolean>>;
	stickyScroll: boolean;
	setStickyScroll: Dispatch<SetStateAction<boolean>>;
	stickyScrollMaxLines: number;
	setStickyScrollMaxLines: Dispatch<SetStateAction<number>>;
	terminalShell: TerminalShell;
	setTerminalShell: Dispatch<SetStateAction<TerminalShell>>;
	editorConfig: boolean;
	setEditorConfig: Dispatch<SetStateAction<boolean>>;
	relativeLineNumbers: boolean;
	setRelativeLineNumbers: Dispatch<SetStateAction<boolean>>;
	sidebar: boolean;
	setSidebar: Dispatch<SetStateAction<boolean>>;
	activityBarPosition: ActivityBarPosition;
	setActivityBarPosition: Dispatch<SetStateAction<ActivityBarPosition>>;
	compactMode: boolean;
	setCompactMode: Dispatch<SetStateAction<boolean>>;
	animations: boolean;
	setAnimations: Dispatch<SetStateAction<boolean>>;
	smoothCursor: boolean;
	setSmoothCursor: Dispatch<SetStateAction<boolean>>;
	smoothBlink: boolean;
	setSmoothBlink: Dispatch<SetStateAction<boolean>>;
	scrollFollowCursor: boolean;
	setScrollFollowCursor: Dispatch<SetStateAction<boolean>>;
	formatOnSave: boolean;
	setFormatOnSave: Dispatch<SetStateAction<boolean>>;
	clipboardSharing: boolean;
	setClipboardSharing: Dispatch<SetStateAction<boolean>>;
	fontFamily: string;
	setFontFamily: Dispatch<SetStateAction<string>>;
	fontWeight: number;
	setFontWeight: Dispatch<SetStateAction<number>>;
	fontSize: number;
	setFontSize: Dispatch<SetStateAction<number>>;
	lineHeight: number;
	setLineHeight: Dispatch<SetStateAction<number>>;
	sidebarWidth: number;
	resizeSidebar: (width: number) => void;
}
