import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attach, type NeovimClient } from 'neovim';
import type { FileEntry, NidoEvent, Redraw, SavedWorkspace, SessionState, Workspace } from '../shared/types';
import { SessionFiles } from './sessionFiles';

const setup = `
local channel = ...
local pending = false
local progress = {}
local function publish()
 if pending then return end
 pending = true
 vim.schedule(function()
  pending = false
  local buffers = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
   if vim.api.nvim_buf_is_valid(b) and vim.bo[b].buflisted then
    table.insert(buffers, {id=b, name=vim.api.nvim_buf_get_name(b), modified=vim.bo[b].modified})
   end
  end
  local pos = vim.api.nvim_win_get_cursor(0)
  local clients = {}
  local tasks = {}
  for _, client in ipairs(vim.lsp.get_clients()) do
    if not client.initialized then
      table.insert(tasks, client.name .. ': 起動中…')
    end
    for _, value in pairs(progress[client.id] or {}) do
      local message = client.name .. ': ' .. (value.title or '読み込み中')
      if value.message and value.message ~= '' then message = message .. ' — ' .. value.message end
      if value.percentage then message = message .. ' (' .. value.percentage .. '%)' end
      table.insert(tasks, message)
    end
  end
  table.sort(tasks)
  for _, client in ipairs(vim.lsp.get_clients({bufnr=0})) do
    if client.initialized then table.insert(clients, client.name) end
  end
  local empty = #buffers == 1 and buffers[1].id == vim.api.nvim_get_current_buf()
    and buffers[1].name == '' and not buffers[1].modified and vim.bo.buftype == ''
    and vim.api.nvim_buf_line_count(0) == 1 and vim.api.nvim_get_current_line() == ''
    and #vim.api.nvim_tabpage_list_wins(0) == 1
  vim.rpcnotify(channel, 'nido:state', {buffers=buffers, current=vim.api.nvim_get_current_buf(),
   lsp=table.concat(clients, ', '), lspProgress=table.concat(tasks, ' / '), empty=empty, mode=vim.api.nvim_get_mode().mode, line=pos[1], column=pos[2]+1, filetype=vim.bo.filetype})
 end)
end
vim.api.nvim_create_autocmd('LspProgress', {callback=function(event)
  local id, params = event.data.client_id, event.data.params
  local value = params.value
  if type(value) ~= 'table' or not value.kind then return end
  progress[id] = progress[id] or {}
  if value.kind == 'end' then
    progress[id][params.token] = nil
    if next(progress[id]) == nil then progress[id] = nil end
  else
    progress[id][params.token] = vim.tbl_extend('force', progress[id][params.token] or {}, value)
  end
  publish()
end})
vim.api.nvim_create_autocmd({'BufEnter','BufAdd','BufDelete','BufModifiedSet','BufFilePost','BufWritePost','ModeChanged','CursorMoved','CursorMovedI','FileType','TextChanged','TextChangedI','WinEnter','WinClosed','LspAttach','LspDetach'}, {callback=publish})
publish()
`;

const gridEvents = new Set([
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
  readonly workspace: Workspace;
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: NeovimClient;
  private readonly fileService: SessionFiles;
  state: SessionState = { buffers: [], current: 0, mode: 'n', line: 1, column: 1, filetype: '' };
  private stopped = false;
  private attached = false;
  private inputQueue: Promise<void> = Promise.resolve();

  private constructor(
    root: string,
    private emit: (event: NidoEvent) => void,
    resources: string
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
          VIMRUNTIME: resolve(resources, 'nvim-win64/share/nvim/runtime'),
          VIMINIT: '',
          EXINIT: ''
        },
        windowsHide: true,
        stdio: 'pipe'
      }
    );
    this.client = attach({ proc: this.process });
    this.fileService = new SessionFiles(this.workspace.root, this.client);
    this.client.on('notification', (method: string, args: unknown[]) => {
      if (method === 'redraw') {
        // Other events can contain Neovim Window handles, which cannot cross Electron IPC.
        const events = (args as Redraw).filter(([name]) => gridEvents.has(name));
        if (events.length) {
          this.emit({ type: 'redraw', id: this.workspace.id, events });
        }
      }
      if (method === 'nido:state') {
        this.state = args[0] as SessionState;
        // Lua encodes an empty table as a map rather than an array.
        if (!Array.isArray(this.state.buffers)) {
          this.state.buffers = [];
        }
        this.emit({ type: 'state', id: this.workspace.id, state: this.state });
      }
    });
    this.process.stderr.on('data', () => {
      /* Drain the child pipe; RPC errors are surfaced separately. */
    });
    this.process.on('exit', () => {
      this.stopped = true;
      this.emit({ type: 'exit', id: this.workspace.id });
    });
    this.process.on('error', (error) => this.emit({ type: 'error', id: this.workspace.id, message: error.message }));
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
    for (const file of ['nvim-win64/bin/nvim.exe', 'nido/init.lua']) {
      try {
        await stat(resolve(resources, file));
      } catch {
        throw new Error(
          `Bundled Neovim is missing: ${file}. Reinstall Nido, or run pnpm prepare:neovim in development.`
        );
      }
    }
    const session = new Session(actual, emit, resources);
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
        })(),
        new Promise<never>((_, reject) => {
          session.process.once('error', reject);
          timer = setTimeout(
            () => reject(new Error('Bundled Neovim did not start. Check the Nido installation.')),
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
      await this.client.request('nvim_ui_attach', [columns, rows, { rgb: true, ext_linegrid: true }]);
      this.emit({ type: 'state', id: this.workspace.id, state: this.state });
    } catch (error) {
      this.attached = false;
      throw error;
    }
  }

  async resize(columns: number, rows: number): Promise<void> {
    if (this.attached) {
      await this.client.request('nvim_ui_try_resize', [columns, rows]);
    }
  }

  input(keys: string): Promise<void> {
    // nvim_input can accept only part of a byte sequence when its input queue is full.
    const next = this.inputQueue.then(async () => {
      let rest = Buffer.from(keys);
      while (rest.length && !this.stopped) {
        const accepted = (await this.client.request('nvim_input', [rest.toString()])) as number;
        rest = rest.subarray(accepted);
        if (!accepted) {
          await new Promise((done) => setTimeout(done, 2));
        }
      }
    });
    this.inputQueue = next.catch(() => {});
    return next;
  }

  async paste(text: string): Promise<void> {
    await this.client.request('nvim_paste', [text, true, -1]);
  }

  async save(): Promise<void> {
    await this.write('write');
  }

  async snapshot(): Promise<SavedWorkspace> {
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
      ...data,
      files: Array.isArray(data.files) ? data.files : []
    };
  }

  async restore(saved: SavedWorkspace): Promise<string[]> {
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

  async modified(): Promise<boolean> {
    return (await this.client.request('nvim_exec_lua', [
      'for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].modified then return true end end return false',
      []
    ])) as boolean;
  }

  async saveAll(): Promise<void> {
    await this.write('wall');
  }

  private async write(command: 'write' | 'wall'): Promise<void> {
    const error = (await this.client.request('nvim_exec_lua', [
      'local ok, err = pcall(vim.cmd, ...); return ok and "" or tostring(err)',
      [command]
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
    return (await this.client.request('nvim_get_option_value', ['modified', { buf: buffer }])) as boolean;
  }

  async path(relativePath: string): Promise<string> {
    return this.fileService.path(relativePath);
  }

  async openFile(relativePath: string): Promise<void> {
    await this.fileService.openFile(relativePath);
  }

  async files(relativePath: string): Promise<FileEntry[]> {
    return this.fileService.files(relativePath);
  }

  async findFiles(): Promise<FileEntry[]> {
    return this.fileService.findFiles();
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.process.pid) {
      return;
    }
    this.stopped = true;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.process.kill();
        done();
      }, 2000);
      this.process.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      // Let Neovim remove its swap files before terminating the process.
      this.client.notify('nvim_command', ['qa!']);
    });
  }
}
