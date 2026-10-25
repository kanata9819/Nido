import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { editorPath, hostPath, parseWslPath } from '../shared/wsl';
import { prepareWsl, resolveWslFolder, trashWslFile, wslArguments } from './wsl';
import { discoverLanguagePacks } from './languagePacks';
import type { LanguagePackConfiguration, LanguagePackRuntime } from '../shared/languagePacks';
import type { SearchOptions, ReplacementPreview, ReplacementResult } from '../shared/search';
import { terminalShells, type TerminalShell } from '../shared/types';
import { resolveTerminalShell } from './terminalShells';

export class Session {
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
  private processClosed = false;
  private stopping?: Promise<void>;
  private attached = false;
  private uiQueue: Promise<void> = Promise.resolve();
  private resizeGeneration = 0;
  private readonly interaction: SessionInteraction;

  private constructor(
    root: string,
    private emit: (event: NidoEvent) => void,
    private resources: string,
    runtime?: Awaited<ReturnType<typeof prepareWsl>>
  ) {
    const remote = parseWslPath(root);
    this.workspace = {
      id: randomUUID(),
      root,
      name: basename(root) || root,
      ...(remote ? { wsl: remote.distribution } : {})
    };
    this.events = new SessionEvents(
      this.workspace.id,
      emit,
      remote ? (path) => hostPath(root, path) : undefined
    );
    const args = [
      '--embed',
      '--noplugin',
      // Time Machine owns recovery; an embedded startup cannot answer swap prompts.
      '-n',
      '-i',
      'NONE',
      '-u',
      runtime ? `${runtime.resources}/nido/init.lua` : resolve(resources, 'nido/init.lua'),
      '--cmd',
      // Keep bundled parser DLLs discoverable while excluding personal config.
      "lua vim.opt.runtimepath = {vim.env.VIMRUNTIME, vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim'}; vim.opt.packpath = {}"
    ];
    this.process = spawn(
      runtime && remote ? 'wsl.exe' : resolve(resources, 'nvim-win64/bin/nvim.exe'),
      runtime && remote
        ? wslArguments(remote.distribution, remote.path, [
            'env',
            '-u',
            'VIMRUNTIME',
            '-u',
            'VIMINIT',
            '-u',
            'EXINIT',
            '-u',
            'NVIM',
            '-u',
            'NVIM_LISTEN_ADDRESS',
            '-u',
            'NODE_OPTIONS',
            '-u',
            'NIDO_LSP_CONFIG',
            'NVIM_APPNAME=nido',
            'NIDO_WSL=1',
            `NIDO_WORKSPACE_ROOT=${remote.path}`,
            `NIDO_NODE=${runtime.node}`,
            `NIDO_LANGUAGES=${runtime.resources}/languages`,
            runtime.nvim,
            ...args
          ])
        : args,
      {
        cwd: runtime ? resources : root,
        env: runtime
          ? process.env
          : {
              ...process.env,
              NVIM_APPNAME: 'nido',
              NIDO_WORKSPACE_ROOT: root,
              NIDO_NODE: process.execPath,
              NIDO_LANGUAGES: resolve(resources, 'languages'),
              VIMRUNTIME: resolve(resources, 'nvim-win64/share/nvim/runtime'),
              VIMINIT: '',
              EXINIT: ''
            },
        windowsHide: true,
        stdio: 'pipe'
      }
    );
    this.client = new SessionClient(this.process, (error) => {
      if (!this.stopped) {
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
    this.fileService = new SessionFiles(this.workspace.root, this.client);
    this.directoryWatcher = new DirectoryWatcher(
      (path) => this.fileService.path(path),
      (paths) => this.emit({ type: 'directoryChanged', id: this.workspace.id, paths }),
      this.workspace.root.startsWith('\\\\')
    );
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
    this.process.on('exit', () => {
      if (!this.stopped && stderr.trim()) {
        this.emit({ type: 'error', id: this.workspace.id, message: stderr.trim() });
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

  static async create(
    root: string,
    emit: (event: NidoEvent) => void,
    resources = resolve(__dirname, '../../resources'),
    languagePacks?: LanguagePackConfiguration
  ): Promise<Session> {
    const remote = parseWslPath(root);
    const actual = remote
      ? await resolveWslFolder(remote.distribution, remote.path)
      : await realpath(root);
    if (!(await stat(actual)).isDirectory()) {
      throw new Error('Choose a project folder.');
    }
    for (const file of [
      ...(!remote ? ['nvim-win64/bin/nvim.exe'] : ['nido/wsl-runtime.sh']),
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
    const session = new Session(actual, emit, resources, runtime);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const api = (await session.client.request('nvim_get_api_info', [])) as [number, unknown];
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

  async attach(columns: number, rows: number): Promise<void> {
    const next = this.uiQueue.then(async () => {
      if (this.attached) {
        // A new renderer missed startup highlight definitions. Reattach the UI
        // so Neovim resends all colors and grid state, not just changed cells.
        await this.client.request('nvim_ui_detach', []);
        this.attached = false;
      }
      try {
        await this.client.request('nvim_ui_attach', [
          columns,
          rows,
          {
            rgb: true,
            ext_linegrid: true,
            ext_popupmenu: true,
            ext_hlstate: true,
            ext_messages: true,
            ext_cmdline: true
          }
        ]);
        // Preserve the viewport's bottom inset and pixel-scroll overscan. All
        // command text and messages are external even with cmdheight=1.
        await this.client.request('nvim_set_option_value', ['cmdheight', 1, {}]);
        this.attached = true;
        this.events.replayUI();
        this.emit({ type: 'state', id: this.workspace.id, state: this.state });
      } catch (error) {
        this.attached = false;
        throw error;
      }
    });
    this.uiQueue = next.catch(() => {});
    return next;
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

  async resize(columns: number, rows: number): Promise<void> {
    const generation = ++this.resizeGeneration;
    const next = this.uiQueue.then(async () => {
      if (this.attached && generation === this.resizeGeneration) {
        await this.client.request('nvim_ui_try_resize', [columns, rows]);
      }
    });
    this.uiQueue = next.catch(() => {});
    return next;
  }

  async setClipboardSharing(enabled: boolean): Promise<void> {
    await this.client.request('nvim_set_option_value', [
      'clipboard',
      enabled ? 'unnamedplus' : '',
      {}
    ]);
  }

  async markdownPreview(known = ''): Promise<MarkdownSnapshot> {
    const snapshot = (await this.client.request('nvim_exec_lua', [
      `if vim.bo.filetype ~= 'markdown' then
  error('Open a Markdown file to preview.')
end
local known = ...
local buffer = vim.api.nvim_get_current_buf()
local token = buffer .. ':' .. vim.api.nvim_buf_get_changedtick(buffer)
return {token=token, path=vim.api.nvim_buf_get_name(buffer),
  text=token ~= known and table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\\n') or nil}`,
      [known]
    ])) as MarkdownSnapshot;
    return { ...snapshot, path: hostPath(this.workspace.root, snapshot.path) };
  }

  async setRelativeLineNumbers(enabled: boolean): Promise<void> {
    if (this.workspace.kind === 'terminal') {
      return;
    }
    await this.client.request('nvim_exec_lua', [
      `local enabled = ...
vim.go.relativenumber = enabled
for _, win in ipairs(vim.api.nvim_list_wins()) do
  if vim.api.nvim_win_get_config(win).relative == '' then
    vim.api.nvim_set_option_value('relativenumber', enabled, {win=win})
  end
end`,
      [enabled]
    ]);
  }

  async setMethodSeparators(enabled: boolean): Promise<void> {
    if (this.workspace.kind === 'terminal') {
      return;
    }
    await this.client.request('nvim_exec_lua', [
      "require('nido_sticky').set_method_separators(...)",
      [enabled]
    ]);
  }

  async setWordWrap(enabled: boolean): Promise<void> {
    if (this.workspace.kind === 'terminal') {
      return;
    }
    await this.client.request('nvim_exec_lua', [
      `local enabled = ...
vim.go.wrap = enabled
for _, win in ipairs(vim.api.nvim_list_wins()) do
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.api.nvim_win_get_config(win).relative == ''
      and vim.bo[buf].buftype == '' then
    vim.api.nvim_set_option_value('wrap', enabled, {win=win})
  end
end`,
      [enabled]
    ]);
  }

  async setEditorConfig(enabled: boolean): Promise<void> {
    if (this.workspace.kind === 'terminal') {
      return;
    }
    await this.client.request('nvim_exec_lua', [
      "require('nido_editorconfig').set_enabled(...)",
      [enabled]
    ]);
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

  scroll(lines: number, follow = true, pixel = false): Promise<void> {
    return this.interaction.scroll(lines, follow, pixel);
  }

  async debug(action: DebugAction, target?: number): Promise<void> {
    await this.interaction.restoreScroll();
    const [channel] = (await this.client.request('nvim_get_api_info', [])) as [number, unknown];
    await this.client.request('nvim_exec_lua', [
      "require('nido_debug').action(...)",
      [action, channel, target ?? 0]
    ]);
  }

  async setLineEnding(format: 'LF' | 'CRLF'): Promise<void> {
    await this.interaction.command(() =>
      this.client.request('nvim_exec_lua', ["require('nido_eol').convert(...)", [format]])
    );
  }

  async snapshot(options: { restoreScroll?: boolean } = {}): Promise<SavedWorkspace> {
    if (options.restoreScroll !== false) {
      await this.interaction.restoreScroll();
    }
    if (this.workspace.kind === 'terminal') {
      return { root: this.workspace.root, kind: 'terminal', files: [], current: '' };
    }
    const data = (await this.client.request('nvim_exec_lua', [
      `local files = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        local name = vim.api.nvim_buf_get_name(b)
        if vim.bo[b].buflisted and vim.bo[b].buftype == '' and name ~= '' then
          local pos = vim.api.nvim_buf_get_mark(b, '"')
          local wins = vim.fn.win_findbuf(b)
          if #wins > 0 then
            pos = vim.api.nvim_win_get_cursor(wins[1])
            -- Background checkpoints preserve the detached viewport and the editing anchor.
            if wins[1] == vim.api.nvim_get_current_win() then
              pos = require('nido_scroll').cursor() or pos
            end
          end
          table.insert(files, {path=name, line=math.max(1,pos[1]), column=pos[2]})
        end
      end
      return {files=files, current=vim.api.nvim_buf_get_name(0)}`,
      []
    ])) as Omit<SavedWorkspace, 'root'>;
    return {
      root: this.workspace.root,
      terminal: !!this.terminal,
      ...data,
      current: hostPath(this.workspace.root, data.current),
      files: Array.isArray(data.files)
        ? data.files.map((file) => ({
            ...file,
            path: hostPath(this.workspace.root, file.path)
          }))
        : []
    };
  }

  async restore(saved: SavedWorkspace, shell = 'auto'): Promise<string[]> {
    if (saved.kind === 'terminal') {
      await this.startTerminal(shell);
      return [];
    }
    if (saved.terminal) {
      await this.openTerminal(shell);
    }
    const errors: string[] = [];
    for (const file of saved.files) {
      try {
        if (!(await stat(file.path)).isFile()) {
          throw new Error('File is unavailable.');
        }
        await this.client.request('nvim_exec_lua', [
          `local path, line, column = ...
          require('nido_eol').open(path)
          line = math.min(line, vim.api.nvim_buf_line_count(0))
          vim.api.nvim_win_set_cursor(0, {line, column})`,
          [editorPath(this.workspace.root, file.path), file.line, file.column]
        ]);
      } catch (error) {
        errors.push(`${file.path}: ${String(error)}`);
      }
    }
    await this.client.request('nvim_exec_lua', [
      `local b = vim.fn.bufnr(...)
      if b > 0 then
        vim.api.nvim_set_current_buf(b)
      end`,
      [editorPath(this.workspace.root, saved.current)]
    ]);
    return errors;
  }

  async refreshFiles(): Promise<void> {
    await this.client.request('nvim_command', ['checktime']);
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

  async modified(): Promise<boolean> {
    return (await this.interaction.command(() =>
      this.client.request('nvim_exec_lua', [
        `for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
  if (vim.bo[buffer].buftype == '' or vim.bo[buffer].buftype == 'acwrite') and vim.bo[buffer].modified then
    return true
  end
end
return false`,
        []
      ])
    )) as boolean;
  }

  async saveAll(): Promise<void> {
    await this.interaction.write('wall');
  }

  async selectBuffer(buffer: number): Promise<void> {
    this.interaction.cancelPrefetch();
    await this.interaction.command(() => this.client.request('nvim_set_current_buf', [buffer]));
  }

  async closeBuffer(buffer: number, force = false): Promise<void> {
    this.interaction.cancelPrefetch();
    await this.interaction.command(() =>
      this.client.request('nvim_exec_lua', [
        `local buffer, force = ...
if not force and vim.bo[buffer].modified then error('Buffer has unsaved changes.') end
vim.api.nvim_buf_delete(buffer, {force=force})`,
        [buffer, force]
      ])
    );
  }

  async bufferModified(buffer: number): Promise<boolean> {
    return (await this.interaction.command(() =>
      this.client.request('nvim_get_option_value', ['modified', { buf: buffer }])
    )) as boolean;
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

  async openReference(index: number, version: number): Promise<void> {
    this.interaction.cancelPrefetch();
    await this.interaction.command(async () => {
      await this.interaction.restoreScroll();
      await this.client.request('nvim_exec_lua', [
        "require('nido_references').open(...)",
        [index, version]
      ]);
    });
  }

  async findSymbols(): Promise<number> {
    return this.client.request('nvim_exec_lua', ["return require('nido_symbols').find()", []]);
  }

  async openSymbol(index: number, version: number): Promise<void> {
    this.interaction.cancelPrefetch();
    await this.interaction.command(() =>
      this.client.request('nvim_exec_lua', ["require('nido_symbols').open(...)", [index, version]])
    );
  }

  async openProblem(index: number, version: number): Promise<void> {
    this.interaction.cancelPrefetch();
    await this.interaction.command(async () => {
      const problem = this.state.problems?.[index - 1];
      if (!problem || version !== this.state.diagnosticsVersion) {
        throw new Error('Problems have changed. Select the item again.');
      }
      await this.interaction.restoreScroll();
      await this.client.request('nvim_exec_lua', [
        `local path, line, column = ...
vim.cmd("normal! m'")
require('nido_eol').open(path)
line = math.min(line, vim.api.nvim_buf_line_count(0))
local text = vim.api.nvim_buf_get_lines(0, line-1, line, false)[1] or ''
vim.api.nvim_win_set_cursor(0, {line, math.min(column-1, #text)})
vim.cmd('normal! zv')
require('nido_scroll').center()`,
        [editorPath(this.workspace.root, problem.path), problem.line, problem.column]
      ]);
    });
  }

  async previewReference(index: number, version: number): Promise<ReferencePreview> {
    return this.client.request('nvim_exec_lua', [
      "return require('nido_references').preview(...)",
      [index, version]
    ]);
  }

  async highlightSources(
    path: string,
    before: string,
    after: string
  ): Promise<ReferencePreview['lines'][]> {
    // Large previews remain readable without monopolizing Neovim's input thread.
    if (before.length + after.length > 128000) {
      return [[], []];
    }
    return this.client.request('nvim_exec_lua', [
      `local path, before, after = ...
local language = vim.filetype.match({filename=path})
local function highlight(source)
  if source == '' then
    return {}
  end
  return require('nido_references').highlight_text(vim.split(source, '\\n', {plain=true}), language)
end
return {highlight(before), highlight(after)}`,
      [editorPath(this.workspace.root, path), before, after]
    ]);
  }

  async files(relativePath: string): Promise<FileEntry[]> {
    await this.directoryWatcher.ready();
    return this.fileService.files(relativePath);
  }

  watchDirectories(paths: string[]): Promise<void> {
    return this.stopped ? Promise.resolve() : this.directoryWatcher.set(paths);
  }

  async historySnapshots(tokens: HistoryToken[]): Promise<HistorySnapshot[]> {
    if (this.stopped || this.workspace.kind === 'terminal') {
      return [];
    }
    const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
    if (mode.blocking) {
      return [];
    }
    const result = (await this.client.request('nvim_exec_lua', [
      "return require('nido_history').changed(...)",
      [tokens]
    ])) as HistorySnapshot[];
    return Array.isArray(result)
      ? result.map((value) => ({
          ...value,
          path: hostPath(this.workspace.root, value.path)
        }))
      : [];
  }

  historyCurrent(): Promise<HistorySnapshot> {
    return this.interaction.enqueue(async () => {
      const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
      if (mode.blocking) {
        throw new Error('Finish the current Neovim command before opening Time Machine.');
      }
      return this.historyResult("return require('nido_history').current()", []);
    });
  }

  historyDiff(before: string, after: string): Promise<string> {
    return this.client.request('nvim_exec_lua', [
      "return require('nido_history').diff(...)",
      [before, after]
    ]);
  }

  historyRestore(path: string, token: string, content: HistoryContent): Promise<HistorySnapshot> {
    return this.interaction.enqueue(async () => {
      const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
      if (mode.blocking) {
        throw new Error('Finish the current Neovim command before restoring.');
      }
      return this.historyResult("return require('nido_history').restore(...)", [
        editorPath(this.workspace.root, path),
        token,
        content
      ]);
    });
  }

  private async historyResult(code: string, args: unknown[]): Promise<HistorySnapshot> {
    const result = (await this.client.request('nvim_exec_lua', [code, args])) as
      HistorySnapshot | { error: string };
    if ('error' in result) {
      throw new Error(result.error);
    }
    return { ...result, path: hostPath(this.workspace.root, result.path) };
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
