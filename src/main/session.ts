// Session manages one workspace, which is one Neovim process. Renderer requests such as
// input, opening files and saving end up in its methods, which delegate to session*.ts:
//   - SessionInteraction: keys, clicks and scrolling sent to Neovim
//   - SessionEvents: Neovim notifications forwarded to the renderer
//   - SessionFiles / SessionBuffers: files and tabs (buffers)
//   - SessionPersistence / SessionHistory: saving and restoring state, and edit history
//   - SessionUI / SessionOptions / SessionNavigation: UI attachment, options and code navigation
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
	DebugAction,
	FileEntry,
	SearchResults,
	FileAction,
	MarkdownSnapshot,
	NidoEvent,
	ReferencePreview,
	SavedWorkspace,
	SessionState,
	Workspace
} from '../shared/types';
import { SessionFiles } from './sessionFiles';
import { DirectoryWatcher } from './directoryWatcher';
import { SessionEvents } from './sessionEvents';
import { SessionClient } from './sessionClient';
import { SessionInteraction } from './sessionInteraction';
import type { HistoryContent, HistorySnapshot, HistoryToken } from '../shared/history';
import { hostPath, parseWslPath } from '../shared/wsl';
import { prepareWsl, resolveWslFolder, trashWslFile } from './wsl';
import { discoverLanguagePacks } from './languagePacks';
import type { LanguagePackConfiguration, LanguagePackRuntime } from '../shared/languagePacks';
import type { SearchOptions, ReplacementPreview, ReplacementResult } from '../shared/search';
import { terminalShells, type TerminalShell } from '../shared/types';
import type { Indentation } from '../shared/types';
import { resolveTerminalShell } from './terminalShells';
import { SessionPersistence } from './sessionPersistence';
import { SessionHistory } from './sessionHistory';
import { SessionUI } from './sessionUI';
import { SessionOptions } from './sessionOptions';
import { SessionBuffers } from './sessionBuffers';
import { SessionNavigation } from './sessionNavigation';
import { spawnNeovim } from './neovimProcess';
import { neovimBundle } from './neovimBundle';

export class Session {
	// The workspace's terminal runs in its own Neovim, so it is a separate Session.
	terminal?: Session;
	private terminalStarting?: Promise<Session>;
	readonly workspace: Workspace;
	readonly process: ChildProcessWithoutNullStreams;
	readonly client: SessionClient;
	private readonly fileService: SessionFiles;
	private readonly directoryWatcher: DirectoryWatcher;
	private readonly events: SessionEvents;
	get state(): SessionState {
		return this.events.state;
	}
	set state(value: SessionState) {
		this.events.state = value;
	}
	private stopped = false;
	// Whether the connection failure was already reported, so an exit does not report it again.
	private reported = false;
	/** False once stop() has started or Neovim has exited. */
	get running(): boolean {
		return !this.stopped;
	}
	private processClosed = false;
	private stopping?: Promise<void>;
	private readonly interaction: SessionInteraction;
	private readonly persistence: SessionPersistence;
	private readonly history: SessionHistory;
	private readonly ui: SessionUI;
	private readonly options: SessionOptions;
	private readonly buffers: SessionBuffers;
	private readonly navigation: SessionNavigation;

	// Use Session.create(), which waits until Neovim has started.
	private constructor(
		root: string,
		private emit: (event: NidoEvent) => void,
		private resources: string,
		runtime?: Awaited<ReturnType<typeof prepareWsl>>,
		id: string = randomUUID()
	) {
		const remote = parseWslPath(root);
		this.workspace = {
			id,
			root,
			name: basename(root) || root,
			...(remote ? { wsl: remote.distribution } : {})
		};
		this.events = new SessionEvents(
			this.workspace.id,
			emit,
			remote ? (path) => hostPath(root, path) : undefined
		);
		this.process = spawnNeovim(root, resources, remote, runtime);
		this.client = new SessionClient(this.process, (error) => {
			if (!this.stopped) {
				this.reported = true;
				this.emit({
					type: 'error',
					id: this.workspace.id,
					message: `Neovim connection closed: ${error.message}`
				});
			}
		});
		this.interaction = new SessionInteraction(
			this.client,
			this.events,
			this.workspace,
			() => this.stopped
		);
		this.persistence = new SessionPersistence(
			this.workspace,
			this.client,
			this.interaction,
			() => !!this.terminal
		);
		this.history = new SessionHistory(
			this.workspace,
			this.client,
			this.interaction,
			() => this.stopped
		);
		this.ui = new SessionUI(this.client, this.events, this.workspace, (event) =>
			this.emit(event)
		);
		this.options = new SessionOptions(this.client, this.workspace);
		this.buffers = new SessionBuffers(this.client, this.interaction, this.workspace);
		this.navigation = new SessionNavigation(
			this.client,
			this.interaction,
			this.events,
			this.workspace
		);
		this.fileService = new SessionFiles(this.workspace.root, this.client);
		this.directoryWatcher = new DirectoryWatcher(
			(path) => this.fileService.path(path),
			(paths) => this.emit({ type: 'directoryChanged', id: this.workspace.id, paths }),
			this.workspace.root.startsWith('\\\\')
		);
		// Neovim notifications: 'redraw' for the UI and 'nido:*' sent by session.lua.
		this.client.on('notification', (method: string, args: unknown[]) => {
			if (method === 'nido:terminal_exit') {
				void this.stop();
				return;
			}
			if (
				method === 'nido:buffer' ||
				method === 'nido:edit' ||
				(method === 'redraw' &&
					(args as [string, ...unknown[][]][]).some(
						([name]) => name === 'grid_clear' || name === 'grid_resize'
					))
			) {
				this.interaction.cancelPrefetch();
			}
			if (method === 'nido:scroll') {
				this.interaction.observeScroll(args[0] as unknown[]);
			}
			this.events.receiveNotification(method, args);
		});
		let stderr = '';
		this.process.stderr.on('data', (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-4000);
		});
		// Clean up and tell the renderer when Neovim exits.
		this.process.on('exit', (code, signal) => {
			if (!this.stopped) {
				// :q exits with 0 and needs no notice. A crash may leave stderr empty, so say
				// why the tab disappears instead of closing it silently.
				const failed = code !== 0 && !this.reported;
				const message = [
					failed
						? `Neovim for ${this.workspace.name} stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`}).`
						: '',
					stderr.trim()
				]
					.filter(Boolean)
					.join('\n');
				if (message) {
					this.emit({ type: 'error', id: this.workspace.id, message });
				}
			}
			this.stopped = true;
			this.directoryWatcher.close();
			this.fileService.cancelFindFiles();
			void this.terminal?.stop();
			this.emit({ type: 'exit', id: this.workspace.id });
		});
		this.process.once('close', () => {
			this.processClosed = true;
		});
		this.process.on('error', (error) =>
			this.emit({ type: 'error', id: this.workspace.id, message: error.message })
		);
	}

	/**
	 * Start the workspace's Neovim and wait until it is ready:
	 * 1. check the folder and the bundled resources
	 * 2. start Neovim and run session.lua
	 * 3. attach an 80×24 UI and wait for init.lua to finish
	 * 4. apply the language packs
	 * Neovim is stopped if this does not finish within 12 seconds.
	 */
	static async create(
		root: string,
		emit: (event: NidoEvent) => void,
		resources = resolve(__dirname, '../../resources'),
		languagePacks?: LanguagePackConfiguration,
		/** Reuse a workspace ID, e.g. when waking a sleeping workspace. */
		id?: string
	): Promise<Session> {
		const remote = parseWslPath(root);
		const actual = remote
			? await resolveWslFolder(remote.distribution, remote.path)
			: await realpath(root);
		if (!(await stat(actual)).isDirectory()) {
			throw new Error('Choose a project folder.');
		}
		for (const file of [
			...(!remote ? [neovimBundle().executable] : ['nido/wsl-runtime.sh']),
			'nido/init.lua',
			'nido/session.lua',
			'languages/node_modules/typescript-language-server/lib/cli.mjs',
			'languages/node_modules/typescript/lib/tsserver.js'
		]) {
			try {
				await stat(resolve(resources, file));
			} catch {
				throw new Error(
					`Bundled editor resource is missing: ${file}. Reinstall Nido, or run pnpm prepare:neovim in development.`
				);
			}
		}
		const setup = await readFile(resolve(resources, 'nido/session.lua'), 'utf8');
		const runtime = remote ? await prepareWsl(remote.distribution, resources) : undefined;
		const session = new Session(actual, emit, resources, runtime, id);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					const api = (await session.client.request('nvim_get_api_info', [])) as [
						number,
						unknown
					];
					await session.client.request('nvim_exec_lua', [setup, [api[0]]]);
					// Embedded Neovim loads init.lua only after a UI attaches. Finish startup
					// before restoring buffers so startup cannot reset their cursor positions.
					await session.attach(80, 24);
					await session.client.request('nvim_exec_lua', [
						'assert(vim.wait(10000, function() return vim.v.vim_did_enter == 1 end), "Neovim startup timed out")',
						[]
					]);
					await session.reloadLanguagePacks(
						languagePacks ?? (await discoverLanguagePacks(resources))
					);
				})(),
				new Promise<never>((_, reject) => {
					session.process.once('error', reject);
					timer = setTimeout(
						() =>
							reject(
								new Error(
									remote
										? 'WSL Neovim did not start. Reconnect to this workspace.'
										: 'Bundled Neovim did not start. Check the Nido installation.'
								)
							),
						12000
					);
				})
			]);
			return session;
		} catch (error) {
			await session.stop();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	// Apply language packs with apply() in resources/nido/lua/nido_language_packs.lua.
	async reloadLanguagePacks(config: LanguagePackConfiguration): Promise<void> {
		await this.client.request('nvim_exec_lua', [
			"require('nido_language_packs').apply(vim.json.decode(...))",
			[JSON.stringify(config)]
		]);
	}

	async languagePacks(): Promise<LanguagePackRuntime[]> {
		return this.client.request('nvim_exec_lua', [
			"return require('nido_language_packs').snapshot()",
			[]
		]) as Promise<LanguagePackRuntime[]>;
	}

	// Most methods below delegate to the session* helpers.

	// Attach the UI. Neovim then starts sending 'redraw' notifications.
	attach(columns: number, rows: number): Promise<void> {
		return this.ui.attach(columns, rows);
	}

	setFocus(focused: boolean): void {
		if (!this.stopped) {
			this.ui.setFocus(focused);
		}
	}

	async startTerminal(shell = 'auto'): Promise<void> {
		return this.interaction.enqueue(async () => {
			if (!terminalShells.includes(shell as TerminalShell)) {
				throw new Error('Invalid terminal shell.');
			}
			const command = this.workspace.wsl ? [] : await resolveTerminalShell(shell);
			await this.client.request('nvim_exec_lua', [
				"require('nido_terminal').start(...)",
				[shell, command]
			]);
			this.workspace.kind = 'terminal';
			this.workspace.name = `Terminal · ${basename(this.workspace.root)}`;
			// Buffer replacement leaves terminal mode asynchronously. Queue input until it returns.
			for (let attempt = 0; attempt < 100; attempt++) {
				const mode = (await this.client.request('nvim_get_mode', [])) as { mode: string };
				if (mode.mode === 't') {
					return;
				}
				await this.client.request('nvim_command', ['startinsert']);
				await new Promise((done) => setTimeout(done, 10));
			}
			throw new Error('Terminal input did not become ready.');
		});
	}

	// Return the running terminal, wait for one that is starting, or start a new one.
	async openTerminal(shell = 'auto'): Promise<Session> {
		if (this.stopped) {
			throw new Error('Workspace was closed.');
		}
		if (this.workspace.kind === 'terminal') {
			return this;
		}
		if (this.terminal && !this.terminal.stopped) {
			return this.terminal;
		}
		this.terminalStarting ??= (async () => {
			const terminal = await Session.create(this.workspace.root, this.emit, this.resources);
			try {
				await terminal.startTerminal(shell);
				if (this.stopped) {
					throw new Error('Workspace was closed.');
				}
				this.terminal = terminal;
				this.workspace.terminalId = terminal.workspace.id;
				terminal.process.once('exit', () => {
					if (this.terminal === terminal) {
						this.terminal = undefined;
						this.workspace.terminalId = undefined;
					}
				});
				return terminal;
			} catch (error) {
				await terminal.stop();
				throw error;
			}
		})().finally(() => {
			this.terminalStarting = undefined;
		});
		return this.terminalStarting;
	}

	resize(columns: number, rows: number): Promise<void> {
		return this.ui.resize(columns, rows);
	}

	setClipboardSharing(enabled: boolean): Promise<void> {
		return this.options.setClipboardSharing(enabled);
	}

	markdownPreview(known = ''): Promise<MarkdownSnapshot> {
		return this.buffers.markdownPreview(known);
	}

	setRelativeLineNumbers(enabled: boolean): Promise<void> {
		return this.options.setRelativeLineNumbers(enabled);
	}

	setMethodSeparators(enabled: boolean): Promise<void> {
		return this.options.setMethodSeparators(enabled);
	}

	setWordWrap(enabled: boolean): Promise<void> {
		return this.options.setWordWrap(enabled);
	}

	setEditorConfig(enabled: boolean): Promise<void> {
		return this.options.setEditorConfig(enabled);
	}

	input(keys: string): Promise<void> {
		return this.interaction.input(keys);
	}

	inputMode(): Promise<string> {
		return this.interaction.inputMode();
	}

	selectCompletion(index: number): Promise<void> {
		return this.interaction.selectCompletion(index);
	}

	click(row: number, column: number): Promise<void> {
		return this.interaction.click(row, column);
	}

	jumpSticky(window: number, buffer: number, line: number): Promise<void> {
		return this.interaction.jumpSticky(window, buffer, line);
	}

	paste(text: string | (() => Promise<string>)): Promise<void> {
		return this.interaction.paste(text);
	}

	async save(format = false): Promise<void> {
		await this.interaction.write('write', format);
	}

	prefetchScroll(down = false): Promise<void> {
		return this.interaction.prefetchScroll(down);
	}

	scroll(lines: number, follow = true, pixel = false, columns = 0): Promise<void> {
		return this.interaction.scroll(lines, follow, pixel, columns);
	}

	async debug(action: DebugAction, target?: number): Promise<void> {
		await this.interaction.restoreScroll();
		const [channel] = (await this.client.request('nvim_get_api_info', [])) as [number, unknown];
		await this.client.request('nvim_exec_lua', [
			"require('nido_debug').action(...)",
			[action, channel, target ?? 0]
		]);
	}

	setLineEnding(format: 'LF' | 'CRLF'): Promise<void> {
		return this.buffers.setLineEnding(format);
	}

	setIndentation(indentation: Indentation, rewrite = false): Promise<void> {
		return this.buffers.setIndentation(indentation, rewrite);
	}

	snapshot(
		options: { restoreScroll?: boolean; includeUntitled?: boolean } = {}
	): Promise<SavedWorkspace> {
		return this.persistence.snapshot(options);
	}

	async restore(saved: SavedWorkspace, shell = 'auto'): Promise<string[]> {
		if (saved.kind === 'terminal') {
			await this.startTerminal(shell);
			return [];
		}
		if (saved.terminal) {
			await this.openTerminal(shell);
		}
		return this.persistence.restore(saved);
	}

	/** Reload unedited buffers whose files changed on disk, such as after a branch switch. */
	async refreshFiles(): Promise<void> {
		// A bare :checktime reloads only the buffers shown in a window, so a file open in a
		// background tab would keep its old text until selected.
		await this.client.request('nvim_exec_lua', [
			`for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(buffer) and vim.bo[buffer].buftype == ''
      and not vim.bo[buffer].modified and vim.api.nvim_buf_get_name(buffer) ~= '' then
    vim.cmd.checktime(buffer)
  end
end`,
			[]
		]);
	}

	async refreshGitSigns(): Promise<void> {
		await this.client.request('nvim_exec_lua', [
			`local signs = require('nido_git_signs')
if signs.refresh_all then
  signs.refresh_all()
end`,
			[]
		]);
	}

	modified(): Promise<boolean> {
		return this.buffers.modified();
	}

	/**
	 * Whether stopping Neovim now and restoring a snapshot later loses nothing: no unsaved
	 * edits, shells, debug sessions or pending prompts.
	 */
	async canSleep(): Promise<boolean> {
		if (this.stopped || this.workspace.kind === 'terminal' || this.terminal) {
			return false;
		}
		const debug = this.state.debug?.status;
		if (debug && !['idle', 'finished', 'error'].includes(debug)) {
			return false;
		}
		const mode = (await this.client.request('nvim_get_mode', [])) as {
			mode: string;
			blocking: boolean;
		};
		if (mode.blocking || mode.mode !== 'n') {
			return false;
		}
		return !(await this.modified());
	}

	async saveAll(): Promise<void> {
		await this.interaction.write('wall');
	}

	selectBuffer(buffer: number): Promise<void> {
		return this.buffers.selectBuffer(buffer);
	}

	closeBuffer(buffer: number, force = false): Promise<void> {
		return this.buffers.closeBuffer(buffer, force);
	}

	moveBuffer(buffer: number, target: number): Promise<void> {
		return this.buffers.moveBuffer(buffer, target);
	}

	reopenBuffer(): Promise<void> {
		return this.buffers.reopenBuffer();
	}

	bufferModified(buffer: number): Promise<boolean> {
		return this.buffers.bufferModified(buffer);
	}

	async path(relativePath: string): Promise<string> {
		return this.fileService.path(relativePath);
	}

	async openFile(relativePath: string, line?: number, column?: number): Promise<void> {
		if (this.workspace.kind === 'terminal') {
			throw new Error('Open an Editor session to edit files.');
		}
		this.interaction.cancelPrefetch();
		await this.interaction.command(() => this.fileService.openFile(relativePath, line, column));
	}

	async fileAction(
		action: FileAction,
		path: string,
		target: string,
		trash: (path: string) => Promise<void>
	): Promise<void> {
		// Drain preceding input without blocking typing during the filesystem operation.
		await this.inputMode();
		await this.fileService.fileAction(
			action,
			path,
			target,
			this.workspace.wsl ? trashWslFile : trash
		);
	}

	openReference(index: number, version: number): Promise<void> {
		return this.navigation.openReference(index, version);
	}

	findSymbols(): Promise<number> {
		return this.navigation.findSymbols();
	}

	openSymbol(index: number, version: number): Promise<void> {
		return this.navigation.openSymbol(index, version);
	}

	openProblem(index: number, version: number): Promise<void> {
		return this.navigation.openProblem(index, version);
	}

	previewReference(index: number, version: number): Promise<ReferencePreview> {
		return this.navigation.previewReference(index, version);
	}

	highlightSources(
		path: string,
		before: string,
		after: string
	): Promise<ReferencePreview['lines'][]> {
		return this.navigation.highlightSources(path, before, after);
	}

	async files(relativePath: string): Promise<FileEntry[]> {
		await this.directoryWatcher.ready();
		return this.fileService.files(relativePath);
	}

	watchDirectories(paths: string[]): Promise<void> {
		return this.stopped ? Promise.resolve() : this.directoryWatcher.set(paths);
	}

	historySnapshots(tokens: HistoryToken[]): Promise<HistorySnapshot[]> {
		return this.history.historySnapshots(tokens);
	}

	historyCurrent(): Promise<HistorySnapshot> {
		return this.history.historyCurrent();
	}

	historyDiff(before: string, after: string): Promise<string> {
		return this.history.historyDiff(before, after);
	}

	historyRestore(path: string, token: string, content: HistoryContent): Promise<HistorySnapshot> {
		return this.history.historyRestore(path, token, content);
	}

	async findFiles(query = ''): Promise<FileEntry[]> {
		return this.fileService.findFiles(query);
	}

	searchText(query: string, options?: SearchOptions): Promise<SearchResults> {
		return this.fileService.searchText(query, options);
	}

	previewReplacement(
		token: string,
		replacement: string,
		selected: number[]
	): Promise<ReplacementPreview> {
		return this.interaction.enqueue(() =>
			this.fileService.replacements.prepare(token, replacement, selected)
		);
	}

	applyReplacement(token: string): Promise<ReplacementResult> {
		this.interaction.cancelPrefetch();
		return this.interaction.enqueue(() => this.fileService.replacements.apply(token));
	}

	cancelFindFiles(): void {
		this.fileService.cancelFindFiles();
	}

	// Stop Neovim once, however often this is called: ask with :qa!, then kill after 2 seconds.
	stop(): Promise<void> {
		if (this.stopping) {
			return this.stopping;
		}
		this.stopped = true;
		this.directoryWatcher.close();
		this.fileService.cancelFindFiles();
		this.client.cancelRequests();
		this.stopping = (async () => {
			// A child being created must finish its own cancellation and cleanup first.
			await this.terminalStarting?.catch(() => {});
			await this.terminal?.stop();
			if (!this.process.pid || this.processClosed) {
				return;
			}
			await new Promise<void>((done) => {
				const timer = setTimeout(() => this.process.kill(), 2000);
				// Wait for pipe handles to close as well as the process, including forced termination.
				this.process.once('close', () => {
					clearTimeout(timer);
					done();
				});
				this.client.quit();
			});
		})();
		return this.stopping;
	}
}
