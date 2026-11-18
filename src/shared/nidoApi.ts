// The API the preload script exposes to the renderer as window.nido, one interface per
// group of IPC handlers in src/main/ipc/.
import type { Language } from './i18n';
import type {
	GitHubStatus,
	IssueDetails,
	IssueFilter,
	IssueSummary,
	MergeMethod,
	PullRequestDetails,
	PullRequestFilter,
	PullRequestSummary,
	ReviewEvent
} from './github';
import type { HistoryList, HistoryPreview } from './history';
import type { LanguagePackSnapshot } from './languagePacks';
import type { SearchOptions, ReplacementPreview, ReplacementResult } from './search';
import type {
	DebugAction,
	FavoriteWorkspace,
	FileAction,
	FileEntry,
	GitBranchEntry,
	GitCommitEntry,
	GitRemoteAction,
	GitRemoteInfo,
	GitStatus,
	Indentation,
	MarkdownSnapshot,
	NidoEvent,
	ReferencePreview,
	SearchResults,
	SleepBlocker,
	TerminalShell,
	UITheme,
	UpdateAction,
	UpdateState,
	WindowState,
	Workspace
} from './types';

/** Language packs on the Extensions page (ipc/languagePackHandlers.ts). */
export interface LanguagePackAPI {
	languagePacks(id?: string): Promise<LanguagePackSnapshot>;
	setLanguagePackEnabled(id: string, enabled: boolean): Promise<void>;
	installLanguagePack(): Promise<void>;
	reloadLanguagePacks(): Promise<void>;
	openLanguagePackFolder(): Promise<void>;
}

/** Time Machine: the local edit history (ipc/historyHandlers.ts). */
export interface HistoryAPI {
	setHistoryEnabled(enabled: boolean): Promise<void>;
	history(id: string): Promise<HistoryList>;
	historyPreview(id: string, path: string, version: string): Promise<HistoryPreview>;
	historyRestore(id: string, path: string, version: string, token: string): Promise<void>;
}

/** The Git panel and browser, and syntax colors for their diffs (ipc/gitHandlers.ts). */
export interface GitAPI {
	highlightSources(
		id: string,
		path: string,
		before: string,
		after: string
	): Promise<ReferencePreview['lines'][]>;
	gitHistory(
		id: string,
		skip: number,
		anchor?: string
	): Promise<{ commits: GitCommitEntry[]; total: number }>;
	gitCommitFiles(id: string, hash: string): Promise<string[]>;
	gitCommitDiff(id: string, hash: string, path: string): Promise<string>;
	gitBranches(id: string): Promise<GitBranchEntry[]>;
	gitSwitch(id: string, name: string, create: boolean): Promise<void>;
	gitStatus(id: string, includeRemote?: boolean): Promise<GitStatus>;
	gitRemoteAction(
		id: string,
		action: GitRemoteAction,
		expected: GitRemoteInfo
	): Promise<number | undefined>;
	gitDiff(id: string, path: string, staged: boolean): Promise<string>;
	gitStage(id: string, path: string, staged: boolean): Promise<void>;
	gitStageAll(id: string): Promise<void>;
	gitCommit(id: string, message: string): Promise<string>;
}

/** Opening, restoring, sleeping and closing workspaces, and the folder picker (ipc/workspaceHandlers.ts). */
export interface WorkspaceAPI {
	wslDistributions(): Promise<string[]>;
	availableTerminalShells(): Promise<TerminalShell[]>;
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
	/** Start another shell in a terminal workspace and show it. */
	addTerminalShell(id: string, shell?: TerminalShell): Promise<void>;
	/** Show a terminal workspace's shell by its 1-based position. */
	selectTerminalShell(id: string, position: number): Promise<void>;
	/** Stop a terminal workspace's shell by its 1-based position. */
	closeTerminalShell(id: string, position: number): Promise<void>;
	browseFolders(
		path?: string,
		distribution?: string
	): Promise<{ path: string; parent: string; folders: FileEntry[] }>;
	/** Drive roots such as C:\ that the folder picker lists above a drive. Empty off Windows. */
	windowsDrives(): Promise<string[]>;
	closeWorkspace(id: string): Promise<boolean>;
	/**
	 * Stop a background workspace's Neovim if nothing would be lost. Resolves true when it
	 * slept, or everything that keeps it running (false when it is selected, already asleep
	 * or the app closes). With `resolve`, a running terminal is closed and unsaved files are
	 * saved first.
	 */
	sleepWorkspace(id: string, resolve?: boolean): Promise<boolean | SleepBlocker[]>;
	/** Restart a sleeping workspace's Neovim and restore its files. */
	wakeWorkspace(id: string): Promise<{ workspace: Workspace; errors: string[] }>;
}

/** A workspace's editor: its grid, input, settings and Run and Debug (ipc/editorHandlers.ts). */
export interface EditorAPI {
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
	/** Put a terminal in copy mode (Ctrl+Shift+C). */
	terminalCopyMode(id: string): Promise<void>;
	pasteClipboard(id: string): Promise<void>;
	debug(id: string, action: DebugAction, target?: number): Promise<void>;
}

/** The explorer, file search, text search and replacement (ipc/fileHandlers.ts). */
export interface FileAPI {
	files(id: string, relative: string): Promise<FileEntry[]>;
	watchDirectories(id: string, paths: string[]): Promise<void>;
	fileAction(id: string, action: FileAction, path: string, target?: string): Promise<void>;
	/**
	 * Copy files and folders from anywhere on the computer into a workspace folder (`''` is the
	 * workspace itself), naming any copy whose name is taken as the explorer does. Resolves to
	 * the workspace-relative paths of the copies.
	 */
	importFiles(id: string, sources: string[], directory: string): Promise<string[]>;
	/** The absolute path of a file or folder dropped from the operating system; '' if it has none. */
	pathForFile(file: File): string;
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
}

/** File tabs, saving, and jumps to symbols, references and problems (ipc/editorHandlers.ts). */
export interface BufferAPI {
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
	setLineEnding(id: string, format: 'LF' | 'CRLF'): Promise<void>;
	/** Change the current file's indentation; `rewrite` also converts existing leading whitespace. */
	setIndentation(id: string, indentation: Indentation, rewrite?: boolean): Promise<void>;
}

/** Pull requests and issues of the workspace's GitHub repository (ipc/githubHandlers.ts). */
export interface GitHubAPI {
	githubStatus(id: string): Promise<GitHubStatus>;
	githubPullRequests(id: string, filter: PullRequestFilter): Promise<PullRequestSummary[]>;
	githubPullRequest(id: string, number: number): Promise<PullRequestDetails>;
	/** The pull request's diff as [path, diff of that file] pairs. */
	githubPullRequestDiff(id: string, number: number): Promise<[string, string][]>;
	githubCheckout(id: string, number: number): Promise<void>;
	githubComment(id: string, kind: 'pr' | 'issue', number: number, body: string): Promise<void>;
	githubReview(id: string, number: number, event: ReviewEvent, body: string): Promise<void>;
	githubReply(id: string, thread: string, body: string): Promise<void>;
	githubResolve(id: string, thread: string, resolved: boolean): Promise<void>;
	githubLineComment(
		id: string,
		number: number,
		path: string,
		line: number,
		side: 'LEFT' | 'RIGHT',
		body: string
	): Promise<void>;
	/** Push the checked-out branch and open a pull request from it; returns its address. */
	githubCreatePullRequest(
		id: string,
		title: string,
		body: string,
		base: string,
		draft: boolean
	): Promise<string>;
	/** Merge; `branchError` says why the branch on GitHub could not be deleted, if it was not. */
	githubMerge(
		id: string,
		number: number,
		method: MergeMethod,
		deleteBranch: boolean
	): Promise<{ branchError?: string }>;
	githubIssues(id: string, filter: IssueFilter): Promise<IssueSummary[]>;
	githubIssue(id: string, number: number): Promise<IssueDetails>;
	githubSetIssueOpen(id: string, number: number, open: boolean): Promise<void>;
}

/** The app itself: theme, language, window, updates, links and events (ipc/appHandlers.ts). */
export interface AppAPI {
	openDocumentation(url: string): Promise<void>;
	setTheme(theme: UITheme): Promise<void>;
	setLanguage(language: Language): Promise<void>;
	updateState(): Promise<UpdateState>;
	updateAction(action: UpdateAction): Promise<UpdateState>;
	windowState(): Promise<WindowState>;
	windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
	onEvent(callback: (event: NidoEvent) => void): () => void;
}

/**
 * The API the preload script exposes as `window.nido`. Most methods take the workspace id
 * first and are forwarded to that workspace's Session in the main process. It is grouped
 * like the IPC handlers in src/main/ipc/.
 */
export interface NidoAPI
	extends
		LanguagePackAPI,
		HistoryAPI,
		GitAPI,
		GitHubAPI,
		WorkspaceAPI,
		EditorAPI,
		FileAPI,
		BufferAPI,
		AppAPI {}
