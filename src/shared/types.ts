import type { Language } from './i18n';
import type { NeovimUIPatch, NeovimUIState } from './neovimUI';
import type { HistoryList, HistoryPreview } from './history';
import type { LanguagePackSnapshot } from './languagePacks';
import type { SearchOptions, ReplacementPreview, ReplacementResult } from './search';

// Types shared by the main process, the preload script and the renderer. NidoAPI at the bottom
// is the API the preload script exposes to the renderer as `window.nido`.

/** Shells a terminal workspace can start; `auto` picks the best one installed. */
export const terminalShells = ['auto', 'pwsh', 'powershell.exe', 'cmd.exe', 'wsl.exe'] as const;
export type TerminalShell = (typeof terminalShells)[number];

/** Color themes for Nido's own UI. */
export const uiThemes = ['dark', 'acrylic', 'comfort', 'neon'] as const;
export type UITheme = (typeof uiThemes)[number];

export interface WindowState {
	maximized: boolean;
}

/** Progress of the auto-updater, shown by the update button. */
export interface UpdateState {
	status:
		| 'disabled'
		| 'idle'
		| 'checking'
		| 'current'
		| 'available'
		| 'downloading'
		| 'downloaded'
		| 'installing'
		| 'error';
	currentVersion: string;
	version?: string;
	percent?: number;
	message?: string;
}
export type UpdateAction = 'check' | 'download' | 'install';

/** An open workspace: a folder (editor) or a shell (terminal), each backed by its own Neovim. */
export interface Workspace {
	/** WSL distribution, when the folder lives inside WSL. */
	wsl?: string;
	kind?: 'editor' | 'terminal';
	/** For an editor's terminal: the id of the terminal workspace that runs it. */
	terminalId?: string;
	id: string;
	root: string;
	name: string;
	/** Neovim is stopped to save resources; waking restores the saved files and cursors. */
	sleeping?: boolean;
}
/** A folder the user pinned in the workspace list. */
export interface FavoriteWorkspace {
	root: string;
	name: string;
	kind: 'editor' | 'terminal';
}
/** What is saved so a workspace can be reopened: its open files, cursors and untitled buffers. */
export interface SavedWorkspace {
	kind?: 'editor' | 'terminal';
	/** Whether the workspace's terminal was open. */
	terminal?: boolean;
	root: string;
	files: { path: string; line: number; column: number }[];
	current: string;
	/** Unsaved untitled buffers, kept so their text survives a restart. */
	untitled?: {
		id?: string;
		index?: number;
		lines: string[];
		endOfLine: boolean;
		fileformat: 'unix' | 'dos' | 'mac';
		line: number;
		column: number;
	}[];
	/** Index into `untitled` of the current buffer, when the current buffer is untitled. */
	currentUntitled?: number;
}
/** An open buffer, shown as a tab. */
export interface BufferInfo {
	id: number;
	name: string;
	modified: boolean;
}
export interface Indentation {
	spaces: boolean;
	size: number;
}
/**
 * Editor state that Neovim reports and the renderer shows (status bar, tabs, panels). The main
 * process sends it whole as a `state` event or in parts as `statePatch` events.
 */
export interface SessionState {
	/** The active `/` search and its match count, or false when there is none. */
	search?: false | { pattern: string; current: number; total: number; incomplete: number };
	/** Diagnostics of all open files, shown in the Problems panel. */
	problems?: {
		path: string;
		line: number;
		column: number;
		severity: number;
		message: string;
		source: string;
	}[];
	/** Grows when `problems` changes, so an index into an outdated list is not opened. */
	diagnosticsVersion?: number;
	scrollCursor?: { row: number; column: number };
	scrollPercent?: number;
	/** Number of diagnostics per severity, shown in the status bar. */
	diagnostics?: Record<string, number>;
	references?: ReferenceList;
	symbols?: DocumentSymbolList;
	debug?: DebugState;
	lineEnding?: 'LF' | 'CRLF' | 'Mixed' | 'CR';
	/** Indentation of the current file: spaces or tabs, and the indent width. */
	indentation?: Indentation;
	/** Names of the language servers attached to the current buffer. */
	lsp?: string;
	lspProgress?: string;
	/** Whether no file is open, so the welcome screen is shown. */
	empty?: boolean;
	buffers: BufferInfo[];
	/** Id of the current buffer. */
	current: number;
	mode: string;
	line: number;
	column: number;
	filetype: string;
}
/**
 * Results of "find references". `version` grows with every request so the renderer can tell
 * results apart and the main process can reject requests for outdated lists.
 */
export interface ReferenceList {
	version: number;
	search?: number;
	loading: boolean;
	error: string;
	items: { path: string; line: number; column: number; text: string }[];
}
/** Symbols of the current buffer, for the symbol palette. */
export interface DocumentSymbolList {
	version: number;
	buffer: number;
	loading: boolean;
	error: string;
	items: {
		name: string;
		kind: string;
		container: string;
		line: number;
		column: number;
	}[];
}
/** Highlighted source lines around a reference, as runs of text with a color each. */
export interface ReferencePreview {
	first: number;
	line: number;
	lines: { text: string; color: string }[][];
}
/**
 * Sticky scroll: the headers of the scopes (functions, classes, ...) that contain the top of
 * the window, drawn pinned above the editor. Positions are in grid cells.
 */
export interface StickyScrollState {
	window: number;
	buffer: number;
	top: number;
	left: number;
	width: number;
	height: number;
	gutter: number;
	tabstop: number;
	leftcol: number;
	relativeTo?: number;
	separators?: { line: number; row: number }[];
	scopes: {
		line: number;
		ending: number;
		top: number;
		bottom: number;
		text: (ReferencePreview['lines'][number][number] & { cells?: number })[];
		endText: (ReferencePreview['lines'][number][number] & { cells?: number })[];
	}[];
}
/** Actions of the Run and Debug panel. */
export type DebugAction =
	'start' | 'breakpoint' | 'over' | 'into' | 'out' | 'pause' | 'stop' | 'launch' | 'variable';
/** A row of the debugger's variable tree; `depth` and `parent` place it in the tree. */
export interface DebugVariable {
	id: number;
	parent?: number;
	scope: string;
	depth: number;
	name: string;
	value: string;
	type: string;
	expandable: boolean;
	expanded: boolean;
	changed: boolean;
	loading: boolean;
	error?: string;
}
/** State of the Run and Debug panel. */
export interface DebugState {
	kind?: 'run' | 'debug';
	terminal?: string;
	status:
		'idle' | 'building' | 'starting' | 'running' | 'paused' | 'finished' | 'error' | 'select';
	output: string;
	location?: string;
	variables: DebugVariable[];
	targets: { name: string; path: string }[];
}
/** A file or folder in the explorer, the folder picker or file search. */
export interface FileEntry {
	name: string;
	path: string;
	directory: boolean;
	/** Whether .gitignore excludes it, so it is shown dimmed. */
	ignored?: boolean;
}
export interface SearchMatch {
	path: string;
	line: number;
	column: number;
	text: string;
}
/** Results of a workspace-wide text search. `token` lets a replacement refer to them. */
export interface SearchResults {
	matches: SearchMatch[];
	truncated: boolean;
	token?: string;
}
/** The current buffer's text for the Markdown preview; `text` is absent when it has not changed. */
export interface MarkdownSnapshot {
	token: string;
	path: string;
	text?: string;
}
/** File operations from the explorer. */
export type FileAction = 'createFile' | 'createDirectory' | 'rename' | 'copy' | 'delete';
/** Batched Neovim `redraw` notifications: an event name followed by its argument lists. */
export type Redraw = [string, ...unknown[][]][];
/** A diagnostic shown in the diagnostic popup. */
export interface DiagnosticDetails {
	path: string;
	line: number;
	column: number;
	severity: number;
	source: string;
	code: string;
	message: string;
}
/**
 * Events the main process sends to the renderer. Events with an `id` belong to that workspace;
 * the others concern the whole app.
 */
export type NidoEvent =
	| { type: 'update'; id?: never; state: UpdateState }
	| { type: 'windowState'; id?: never; state: WindowState }
	| {
			type: 'notification';
			id: string;
			message: string;
			title: string;
			severity: 'info' | 'warning' | 'error';
	  }
	| {
			type: 'hover';
			id: string;
			markdown: string;
			filetype: string;
			codeBlocks: ReferencePreview['lines'][];
	  }
	| { type: 'diagnostics'; id: string; items: DiagnosticDetails[]; focus: boolean }
	| { type: 'filesChanged'; id: string }
	| { type: 'directoryChanged'; id: string; paths: string[] }
	| { type: 'redraw'; id: string; events: Redraw }
	| { type: 'neovimUI'; id: string; state: NeovimUIState }
	| { type: 'neovimUIPatch'; id: string; state: NeovimUIPatch }
	| { type: 'state'; id: string; state: SessionState }
	| { type: 'statePatch'; id: string; state: Partial<SessionState> }
	| { type: 'exit'; id: string }
	| { type: 'error'; id: string; message: string };
/** A changed file in Git status. `original` is the old path of a renamed file. */
export interface GitChange {
	path: string;
	original?: string;
	status: string;
	staged: boolean;
}

export interface GitStatus {
	root: string;
	branch: string;
	changes: GitChange[];
}

/**
 * The API the preload script exposes as `window.nido`. Most methods take the workspace id
 * first and are forwarded to that workspace's Session in the main process.
 */
export interface NidoAPI {
	languagePacks(id?: string): Promise<LanguagePackSnapshot>;
	setLanguagePackEnabled(id: string, enabled: boolean): Promise<void>;
	installLanguagePack(): Promise<void>;
	reloadLanguagePacks(): Promise<void>;
	openLanguagePackFolder(): Promise<void>;
	wslDistributions(): Promise<string[]>;
	availableTerminalShells(): Promise<TerminalShell[]>;
	setHistoryEnabled(enabled: boolean): Promise<void>;
	history(id: string): Promise<HistoryList>;
	historyPreview(id: string, path: string, version: string): Promise<HistoryPreview>;
	historyRestore(id: string, path: string, version: string, token: string): Promise<void>;
	highlightSources(
		id: string,
		path: string,
		before: string,
		after: string
	): Promise<ReferencePreview['lines'][]>;
	gitHistory(id: string, skip: number): Promise<{ commits: GitCommitEntry[]; total: number }>;
	gitCommitFiles(id: string, hash: string): Promise<string[]>;
	gitCommitDiff(id: string, hash: string, path: string): Promise<string>;
	gitBranches(id: string): Promise<GitBranchEntry[]>;
	gitSwitch(id: string, name: string, create: boolean): Promise<void>;
	gitStatus(id: string): Promise<GitStatus>;
	gitDiff(id: string, path: string, staged: boolean): Promise<string>;
	gitStage(id: string, path: string, staged: boolean): Promise<void>;
	gitStageAll(id: string): Promise<void>;
	gitCommit(id: string, message: string): Promise<string>;
	restoreWorkspaces(
		shell?: TerminalShell
	): Promise<{ workspaces: Workspace[]; active: string; errors: string[] }>;
	workspaceLayout(ids: string[], active: string): Promise<void>;
	favoriteWorkspaces(): Promise<FavoriteWorkspace[]>;
	setWorkspaceFavorite(
		path: string,
		kind: 'editor' | 'terminal',
		enabled: boolean
	): Promise<FavoriteWorkspace[]>;
	createWorkspace(
		path: string,
		kind?: 'editor' | 'terminal',
		shell?: TerminalShell
	): Promise<Workspace | null>;
	openTerminal(id: string, shell?: TerminalShell): Promise<Workspace>;
	restartTerminal(id: string, shell?: TerminalShell): Promise<void>;
	browseFolders(
		path?: string,
		distribution?: string
	): Promise<{ path: string; parent: string; folders: FileEntry[] }>;
	/** Drive roots such as C:\ that the folder picker lists above a drive. Empty off Windows. */
	windowsDrives(): Promise<string[]>;
	closeWorkspace(id: string): Promise<boolean>;
	/** Stop a background workspace's Neovim if nothing would be lost. Resolves whether it slept. */
	sleepWorkspace(id: string): Promise<boolean>;
	/** Restart a sleeping workspace's Neovim and restore its files. */
	wakeWorkspace(id: string): Promise<{ workspace: Workspace; errors: string[] }>;
	attach(id: string, columns: number, rows: number): Promise<void>;
	resize(id: string, columns: number, rows: number): Promise<void>;
	input(id: string, keys: string): Promise<void>;
	inputMode(id: string): Promise<string>;
	selectCompletion(id: string, index: number): Promise<void>;
	markdownPreview(id: string, token?: string): Promise<MarkdownSnapshot>;
	setClipboardSharing(id: string, enabled: boolean): Promise<void>;
	setRelativeLineNumbers(id: string, enabled: boolean): Promise<void>;
	setWordWrap(id: string, enabled: boolean): Promise<void>;
	setMethodSeparators(id: string, enabled: boolean): Promise<void>;
	setEditorConfig(id: string, enabled: boolean): Promise<void>;
	openDocumentation(url: string): Promise<void>;
	click(id: string, row: number, column: number): Promise<void>;
	scroll(
		id: string,
		lines: number,
		follow?: boolean,
		pixel?: boolean,
		columns?: number
	): Promise<void>;
	prefetchScroll(id: string, down?: boolean): Promise<void>;
	jumpSticky(id: string, window: number, buffer: number, line: number): Promise<void>;
	paste(id: string, text: string): Promise<void>;
	pasteClipboard(id: string): Promise<void>;
	files(id: string, relative: string): Promise<FileEntry[]>;
	watchDirectories(id: string, paths: string[]): Promise<void>;
	fileAction(id: string, action: FileAction, path: string, target?: string): Promise<void>;
	findFiles(id: string, query?: string): Promise<FileEntry[]>;
	searchText(id: string, query: string, options?: SearchOptions): Promise<SearchResults>;
	previewReplacement(
		id: string,
		token: string,
		replacement: string,
		selected: number[]
	): Promise<ReplacementPreview>;
	applyReplacement(id: string, token: string): Promise<ReplacementResult>;
	cancelFindFiles(id: string): Promise<void>;
	openFile(id: string, relative: string, line?: number, column?: number): Promise<void>;
	openReference(id: string, index: number, version: number): Promise<void>;
	openProblem(id: string, index: number, version: number): Promise<void>;
	findSymbols(id: string): Promise<number>;
	openSymbol(id: string, index: number, version: number): Promise<void>;
	previewReference(id: string, index: number, version: number): Promise<ReferencePreview>;
	selectBuffer(id: string, buffer: number): Promise<void>;
	closeBuffer(id: string, buffer: number): Promise<boolean>;
	moveBuffer(id: string, buffer: number, target: number): Promise<void>;
	reopenBuffer(id: string): Promise<void>;
	save(id: string, format?: boolean): Promise<void>;
	debug(id: string, action: DebugAction, target?: number): Promise<void>;
	setLineEnding(id: string, format: 'LF' | 'CRLF'): Promise<void>;
	/** Change the current file's indentation; `rewrite` also converts existing leading whitespace. */
	setIndentation(id: string, indentation: Indentation, rewrite?: boolean): Promise<void>;
	setTheme(theme: UITheme): Promise<void>;
	setLanguage(language: Language): Promise<void>;
	updateState(): Promise<UpdateState>;
	updateAction(action: UpdateAction): Promise<UpdateState>;
	windowState(): Promise<WindowState>;
	windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
	onEvent(callback: (event: NidoEvent) => void): () => void;
}

export interface GitCommitEntry {
	hash: string;
	author: string;
	date: string;
	subject: string;
}

export interface GitBranchEntry {
	name: string;
	current: boolean;
	remote: boolean;
}
