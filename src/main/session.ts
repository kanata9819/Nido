import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
    DebugAction,
    DebugState,
    FileEntry,
    NidoEvent,
    Redraw,
    ReferencePreview,
    SavedWorkspace,
    SessionState,
    Workspace
} from '../shared/types';
import { SessionFiles } from './sessionFiles';
import { SessionClient } from './sessionClient';

const gridEvents = new Set([
    'popupmenu_show',
    'popupmenu_select',
    'popupmenu_hide',
    'grid_resize',
    'grid_clear',
    'grid_line',
    'grid_scroll',
    'grid_cursor_goto',
    'hl_attr_define',
    'default_colors_set',
    'mode_change',
    'busy_start',
    'busy_stop',
    'flush'
]);

export class Session {
    terminal?: Session;
    private terminalStarting?: Promise<Session>;
    readonly workspace: Workspace;
    readonly process: ChildProcessWithoutNullStreams;
    readonly client: SessionClient;
    private readonly fileService: SessionFiles;
    state: SessionState = { buffers: [], current: 0, mode: 'n', line: 1, column: 1, filetype: '' };
    private stopped = false;
    private processClosed = false;
    private stopping?: Promise<void>;
    private attached = false;
    private inputQueue: Promise<void> = Promise.resolve();
    private pendingRedraw: Redraw = [];
    private batchingScroll = false;
    private scrollDetached = false;

    private constructor(
        root: string,
        private emit: (event: NidoEvent) => void,
        private resources: string
    ) {
        this.workspace = { id: randomUUID(), root, name: basename(root) || root };
        this.process = spawn(
            resolve(resources, 'nvim-win64/bin/nvim.exe'),
            [
                '--embed',
                '--noplugin',
                '-i',
                'NONE',
                '-u',
                resolve(resources, 'nido/init.lua'),
                '--cmd',
                // Keep bundled parser DLLs discoverable while excluding personal config.
                "lua vim.opt.runtimepath = {vim.env.VIMRUNTIME, vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim'}; vim.opt.packpath = {}"
            ],
            {
                cwd: root,
                env: {
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
        this.fileService = new SessionFiles(this.workspace.root, this.client);
        this.client.on('notification', (method: string, args: unknown[]) => {
            switch (method) {
                case 'nido:hover': {
                    if (typeof args[0] === 'string' && typeof args[1] === 'string') {
                        this.emit({
                            type: 'hover',
                            id: this.workspace.id,
                            markdown: args[0],
                            filetype: args[1],
                            codeBlocks: Array.isArray(args[2])
                                ? (args[2] as ReferencePreview['lines'][])
                                : []
                        });
                    }
                    break;
                }
                case 'nido:scroll': {
                    this.pendingRedraw.push(['nido_scroll', args[0] as unknown[]]);
                    break;
                }
                case 'nido:edit': {
                    this.pendingRedraw.push(['nido_edit', []]);
                    break;
                }
                case 'nido:pixel_scroll': {
                    if (this.batchingScroll) {
                        this.pendingRedraw.push(['nido_pixel_scroll', args]);
                        break;
                    }
                    this.emit({
                        type: 'redraw',
                        id: this.workspace.id,
                        events: [
                            ['nido_pixel_scroll', args],
                            ['flush', []]
                        ]
                    });
                    break;
                }
                case 'nido:message': {
                    this.emit({ type: 'error', id: this.workspace.id, message: String(args[0]) });
                    break;
                }
                case 'redraw': {
                    // Other events can contain Neovim Window handles, which cannot cross Electron IPC.
                    for (const event of args as Redraw) {
                        if (!gridEvents.has(event[0])) {
                            continue;
                        }
                        this.pendingRedraw.push(event);
                        // A repaint can span several RPC notifications. Never expose a partial frame.
                        if (event[0] === 'flush' && !this.batchingScroll) {
                            const events = this.pendingRedraw;
                            this.pendingRedraw = [];
                            this.emit({ type: 'redraw', id: this.workspace.id, events });
                        }
                    }
                    break;
                }
                case 'nido:state': {
                    this.state = {
                        ...(args[0] as SessionState),
                        debug: this.state.debug,
                        references: this.state.references
                    };
                    // Lua encodes an empty table as a map rather than an array.
                    if (!Array.isArray(this.state.buffers)) {
                        this.state.buffers = [];
                    }
                    if (!Array.isArray(this.state.problems)) {
                        this.state.problems = [];
                    }
                    this.emit({ type: 'state', id: this.workspace.id, state: this.state });
                    break;
                }
                case 'nido:references': {
                    const references = args[0] as NonNullable<SessionState['references']>;
                    if (!Array.isArray(references.items)) {
                        references.items = [];
                    }
                    this.state = { ...this.state, references };
                    this.emit({ type: 'state', id: this.workspace.id, state: this.state });
                    break;
                }
                case 'nido:debug': {
                    const debug = args[0] as DebugState;
                    if (!Array.isArray(debug.variables)) {
                        debug.variables = [];
                    }
                    if (!Array.isArray(debug.targets)) {
                        debug.targets = [];
                    }
                    this.state = { ...this.state, debug };
                    this.emit({ type: 'state', id: this.workspace.id, state: this.state });
                    break;
                }
            }
        });
        this.process.stderr.on('data', () => {
            /* Drain the child pipe; RPC errors are surfaced separately. */
        });
        this.process.on('exit', () => {
            this.stopped = true;
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
        resources = resolve(__dirname, '../../resources')
    ): Promise<Session> {
        const actual = await realpath(root);
        if (!(await stat(actual)).isDirectory()) {
            throw new Error('Choose a project folder.');
        }
        for (const file of [
            'nvim-win64/bin/nvim.exe',
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
        const session = new Session(actual, emit, resources);
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
                })(),
                new Promise<never>((_, reject) => {
                    session.process.once('error', reject);
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'Bundled Neovim did not start. Check the Nido installation.'
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

    async attach(columns: number, rows: number): Promise<void> {
        if (this.attached) {
            // A new renderer missed startup highlight definitions. Reattach the UI
            // so Neovim resends all colors and grid state, not just changed cells.
            await this.client.request('nvim_ui_detach', []);
            this.attached = false;
        }
        this.attached = true;
        try {
            await this.client.request('nvim_ui_attach', [
                columns,
                rows,
                { rgb: true, ext_linegrid: true, ext_popupmenu: true }
            ]);
            this.emit({ type: 'state', id: this.workspace.id, state: this.state });
        } catch (error) {
            this.attached = false;
            throw error;
        }
    }

    async startTerminal(): Promise<void> {
        const next = this.inputQueue.then(async () => {
            await this.client.request('nvim_exec_lua', ["require('nido_terminal').start()", []]);
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
        this.inputQueue = next.catch(() => {});
        return next;
    }

    async openTerminal(): Promise<Session> {
        if (this.workspace.kind === 'terminal') {
            return this;
        }
        if (this.terminal && !this.terminal.stopped) {
            return this.terminal;
        }
        this.terminalStarting ??= (async () => {
            const terminal = await Session.create(this.workspace.root, this.emit, this.resources);
            try {
                await terminal.startTerminal();
                if (this.stopped) {
                    throw new Error('Workspace was closed.');
                }
                this.terminal = terminal;
                this.workspace.terminalId = terminal.workspace.id;
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
        if (this.attached) {
            await this.client.request('nvim_ui_try_resize', [columns, rows]);
        }
    }

    async setClipboardSharing(enabled: boolean): Promise<void> {
        await this.client.request('nvim_set_option_value', [
            'clipboard',
            enabled ? 'unnamedplus' : '',
            {}
        ]);
    }

    async markdownPreview(): Promise<string> {
        return this.client.request('nvim_exec_lua', [
            `if vim.bo.filetype ~= 'markdown' then error('Open a Markdown file to preview.') end
return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')`,
            []
        ]);
    }

    async setRelativeLineNumbers(enabled: boolean): Promise<void> {
        if (this.workspace.kind === 'terminal') return;
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

    async setEditorConfig(enabled: boolean): Promise<void> {
        if (this.workspace.kind === 'terminal') return;
        await this.client.request('nvim_exec_lua', [
            "require('nido_editorconfig').set_enabled(...)",
            [enabled]
        ]);
    }

    input(keys: string): Promise<void> {
        // nvim_input can accept only part of a byte sequence when its input queue is full.
        const next = this.inputQueue.then(async () => {
            if (this.stopped) {
                throw new Error('Neovim session is closed.');
            }
            await this.restoreScroll();
            // Native completion bypasses insert mappings for Ctrl+N/P and inserts previews.
            if ((keys === '<C-n>' || keys === '<C-p>') &&
                await this.client.request('nvim_eval', ['pumvisible()'])) {
                keys = keys === '<C-n>' ? '<Down>' : '<Up>';
            }
            if (this.workspace.kind === 'terminal') {
                await this.client.request('nvim_command', ['startinsert']);
            }
            let rest = Buffer.from(keys);
            while (rest.length && !this.stopped) {
                const accepted = (await this.client.request('nvim_input', [
                    rest.toString()
                ])) as number;
                rest = rest.subarray(accepted);
                if (!accepted) {
                    await new Promise((done) => setTimeout(done, 2));
                }
            }
        });
        this.inputQueue = next.catch(() => {});
        return next;
    }

    click(row: number, column: number): Promise<void> {
        const next = this.inputQueue.then(async () => {
            // Mouse coordinates refer to the visible viewport, not the pre-scroll editing anchor.
            await this.client.request('nvim_exec_lua', [
                "require('nido_scroll').restore(true)",
                []
            ]);
            this.scrollDetached = false;
            await this.client.request('nvim_input_mouse', ['left', 'press', '', 1, row, column]);
            await this.client.request('nvim_input_mouse', ['left', 'release', '', 1, row, column]);
        });
        this.inputQueue = next.catch(() => {});
        return next;
    }

    async paste(text: string): Promise<void> {
        await this.restoreScroll();
        if (this.workspace.kind === 'terminal') {
            await this.client.request('nvim_command', ['startinsert']);
        }
        await this.client.request('nvim_paste', [text, true, -1]);
    }

    async save(format = false): Promise<void> {
        await this.write('write', format);
    }

    private async restoreScroll(): Promise<void> {
        if (!this.scrollDetached) {
            return;
        }
        await this.client.request('nvim_exec_lua', ["require('nido_scroll').restore()", []]);
        this.scrollDetached = false;
    }

    async scroll(lines: number, follow = true, pixel = false): Promise<void> {
        if (!lines) {
            return;
        }
        const next = this.inputQueue.then(async () => {
            this.scrollDetached = true;
            this.batchingScroll = true;
            try {
                if (this.workspace.kind === 'terminal') {
                    await this.client.request('nvim_command', ['stopinsert']);
                }
                await this.client.request('nvim_exec_lua', [
                    "require('nido_scroll').scroll(...)",
                    [lines, follow, pixel]
                ]);
                // Neovim emits cursor/WinScrolled updates when the Lua request returns to its event loop.
                await this.client.request('nvim_eval', ['1']);
            } finally {
                // Publish the grid, fractional offset and anchored cursor as one frame, even for sub-line deltas.
                this.batchingScroll = false;
                const events = this.pendingRedraw;
                this.pendingRedraw = [];
                if (events.length) {
                    this.emit({
                        type: 'redraw',
                        id: this.workspace.id,
                        events: [...events, ['flush', []]]
                    });
                }
            }
        });
        this.inputQueue = next.catch(() => {});
        return next;
    }

    async debug(action: DebugAction, target?: number): Promise<void> {
        await this.restoreScroll();
        const [channel] = (await this.client.request('nvim_get_api_info', [])) as [number, unknown];
        await this.client.request('nvim_exec_lua', [
            "require('nido_debug').action(...)",
            [action, channel, target ?? 0]
        ]);
    }

    async setLineEnding(format: 'LF' | 'CRLF'): Promise<void> {
        await this.client.request('nvim_exec_lua', ["require('nido_eol').convert(...)", [format]]);
    }

    async snapshot(): Promise<SavedWorkspace> {
        await this.restoreScroll();
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
          if #wins > 0 then pos = vim.api.nvim_win_get_cursor(wins[1]) end
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
            files: Array.isArray(data.files) ? data.files : []
        };
    }

    async restore(saved: SavedWorkspace): Promise<string[]> {
        if (saved.kind === 'terminal') {
            await this.startTerminal();
            return [];
        }
        if (saved.terminal) {
            await this.openTerminal();
        }
        const errors: string[] = [];
        for (const file of saved.files) {
            try {
                if (!(await stat(file.path)).isFile()) {
                    throw new Error('File is unavailable.');
                }
                await this.client.request('nvim_exec_lua', [
                    `local path, line, column = ...
          vim.cmd.edit(vim.fn.fnameescape(path))
          line = math.min(line, vim.api.nvim_buf_line_count(0))
          vim.api.nvim_win_set_cursor(0, {line, column})`,
                    [file.path, file.line, file.column]
                ]);
            } catch (error) {
                errors.push(`${file.path}: ${String(error)}`);
            }
        }
        await this.client.request('nvim_exec_lua', [
            `local b = vim.fn.bufnr(...)
      if b > 0 then vim.api.nvim_set_current_buf(b) end`,
            [saved.current]
        ]);
        return errors;
    }

    async refreshFiles(): Promise<void> {
        await this.client.request('nvim_command', ['checktime']);
    }

    async modified(): Promise<boolean> {
        return (await this.client.request('nvim_exec_lua', [
            "for _,b in ipairs(vim.api.nvim_list_bufs()) do if (vim.bo[b].buftype == '' or vim.bo[b].buftype == 'acwrite') and vim.bo[b].modified then return true end end return false",
            []
        ])) as boolean;
    }

    async saveAll(): Promise<void> {
        await this.write('wall');
    }

    private async write(command: 'write' | 'wall', format = false): Promise<void> {
        await this.restoreScroll();
        const error = (await this.client.request('nvim_exec_lua', [
            `local command, format = ...
local ok, err = pcall(function()
  if format and #vim.lsp.get_clients({bufnr=0, method='textDocument/formatting'}) > 0 then
    vim.lsp.buf.format({bufnr=0, async=false, timeout_ms=3000})
  end
  vim.cmd({cmd=command, mods={silent=true}})
end)
return ok and "" or tostring(err)`,
            [command, format]
        ])) as string;
        if (error) {
            throw new Error(error);
        }
    }

    async selectBuffer(buffer: number): Promise<void> {
        await this.client.request('nvim_set_current_buf', [buffer]);
    }

    async closeBuffer(buffer: number, force = false): Promise<void> {
        if (!force && (await this.bufferModified(buffer))) {
            throw new Error('Buffer has unsaved changes.');
        }
        await this.client.request('nvim_buf_delete', [buffer, { force }]);
    }

    async bufferModified(buffer: number): Promise<boolean> {
        return (await this.client.request('nvim_get_option_value', [
            'modified',
            { buf: buffer }
        ])) as boolean;
    }

    async path(relativePath: string): Promise<string> {
        return this.fileService.path(relativePath);
    }

    async openFile(relativePath: string): Promise<void> {
        if (this.workspace.kind === 'terminal') {
            throw new Error('Open an Editor session to edit files.');
        }
        await this.fileService.openFile(relativePath);
    }

    async openReference(index: number, version: number): Promise<void> {
        await this.client.request('nvim_exec_lua', [
            "require('nido_references').open(...)",
            [index, version]
        ]);
    }

    async openProblem(index: number, version: number): Promise<void> {
        const problem = this.state.problems?.[index - 1];
        if (!problem || version !== this.state.diagnosticsVersion) {
            throw new Error('Problems have changed. Select the item again.');
        }
        await this.restoreScroll();
        await this.client.request('nvim_exec_lua', [
            `local path, line, column = ...
vim.cmd("normal! m'")
vim.cmd.edit(vim.fn.fnameescape(path))
line = math.min(line, vim.api.nvim_buf_line_count(0))
local text = vim.api.nvim_buf_get_lines(0, line-1, line, false)[1] or ''
vim.api.nvim_win_set_cursor(0, {line, math.min(column-1, #text)})
vim.cmd('normal! zv')
require('nido_scroll').center()`,
            [problem.path, problem.line, problem.column]
        ]);
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
        return this.client.request('nvim_exec_lua', [
            `local path, before, after = ...
local language = vim.filetype.match({filename=path})
local function highlight(source)
  if source == '' then return {} end
  return require('nido_references').highlight_text(vim.split(source, '\\n', {plain=true}), language)
end
return {highlight(before), highlight(after)}`,
            [path, before, after]
        ]);
    }

    async files(relativePath: string): Promise<FileEntry[]> {
        return this.fileService.files(relativePath);
    }

    async findFiles(): Promise<FileEntry[]> {
        return this.fileService.findFiles();
    }

    stop(): Promise<void> {
        if (this.stopping) {
            return this.stopping;
        }
        this.stopped = true;
        this.client.cancelRequests();
        this.stopping = (async () => {
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
