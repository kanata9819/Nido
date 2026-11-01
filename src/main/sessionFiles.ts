import { realpath, readdir, stat, lstat, mkdir, writeFile, rename, cp } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { workspaceRelative as relative } from './workspacePaths';
import { editorPath, hostPath } from '../shared/wsl';
import { type NeovimClient } from 'neovim';
import { gitIgnored } from './git';
import type { FileAction, FileEntry, SearchResults } from '../shared/types';
import type { SearchOptions } from '../shared/search';
import { SessionSearch } from './sessionSearch';
import { WorkspaceReplacement } from './workspaceReplacement';

export class SessionFiles {
  readonly replacements: WorkspaceReplacement;
  private mutations: Promise<void> = Promise.resolve();
  private readonly search: SessionSearch;
  constructor(
    private readonly root: string,
    private readonly client: NeovimClient
  ) {
    this.replacements = new WorkspaceReplacement(root, client, (path) => this.path(path));
    this.search = new SessionSearch(
      root,
      (path) => this.path(path),
      (path, checkIgnored) => this.files(path, checkIgnored),
      this.replacements
    );
  }

  async path(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new Error('Expected a project-relative path.');
    }
    const actual = await realpath(resolve(this.root, relativePath));
    const rel = relative(this.root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Path is outside this workspace.');
    }
    return actual;
  }

  async openFile(relativePath: string, line?: number, column = 1): Promise<void> {
    const file = await this.path(relativePath);
    if (!(await stat(file)).isFile()) {
      throw new Error('Choose a file.');
    }
    await this.client.request('nvim_exec_lua', [
      `local path, line, column = ...
local buffer = vim.fn.bufnr(path)
if line > 0 then require('nido_scroll').restore() end
-- Search navigation must preserve edits already held in an open buffer.
if line > 0 and buffer > 0 and vim.api.nvim_buf_is_loaded(buffer) then
  vim.cmd.buffer(buffer)
else
  require('nido_eol').open(path)
end
if line > 0 then
  vim.cmd.stopinsert()
  line = math.min(line, vim.api.nvim_buf_line_count(0))
  local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)[1] or ''
  vim.api.nvim_win_set_cursor(0, {line, math.min(column - 1, #text)})
  vim.cmd('normal! zvzz')
end`,
      [editorPath(this.root, file), line ?? 0, column]
    ]);
  }

  fileAction(
    action: FileAction,
    path: string,
    target: string,
    trash: (path: string) => Promise<void>
  ): Promise<void> {
    const next = this.mutations.then(async () => {
      this.cancelFindFiles();
      this.search.clearDirectories();
      try {
        await this.mutate(action, path, target, trash);
      } finally {
        this.cancelFindFiles();
        this.search.clearDirectories();
      }
    });
    this.mutations = next.catch(() => {});
    return next;
  }

  private async mutate(
    action: FileAction,
    path: string,
    target: string,
    trash: (path: string) => Promise<void>
  ): Promise<void> {
    const validate = (value: string): void => {
      const rel = relative(this.root, resolve(this.root, value));
      if (
        !value ||
        isAbsolute(value) ||
        !rel ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel) ||
        value.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')
      ) {
        throw new Error('Choose a path inside this workspace, outside .git.');
      }
    };
    validate(path);
    const destination = async (value: string): Promise<string> => {
      validate(value);
      const parent = await this.path(dirname(value));
      const result = resolve(parent, basename(value));
      validate(relative(this.root, result));
      try {
        await lstat(result);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return result;
        }
        throw error;
      }
      throw new Error('A file or folder already exists at that path.');
    };
    if (action === 'createFile' || action === 'createDirectory') {
      const result = await destination(path);
      if (action === 'createFile') {
        await writeFile(result, '', { flag: 'wx' });
      } else {
        await mkdir(result);
      }
      return;
    }
    const source = await this.path(path);
    validate(relative(this.root, source));
    const buffers = (await this.client.request('nvim_exec_lua', [
      `local result = {}
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  table.insert(result, {id=buf, name=vim.api.nvim_buf_get_name(buf), modified=vim.bo[buf].modified})
end
return result`,
      []
    ])) as { id: number; name: string; modified: boolean }[];
    for (const buffer of buffers) {
      buffer.name = hostPath(this.root, buffer.name);
    }
    const affected = buffers.filter((buf) => {
      if (!buf.name) {
        return false;
      }
      const rel = relative(source, buf.name);
      return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
    });
    if (affected.some((buf) => buf.modified)) {
      throw new Error('Save unsaved changes in this file or folder first.');
    }
    if (action === 'delete') {
      await trash(source);
      for (const buf of affected) {
        // Edits can arrive while the OS is moving the file to the trash.
        await this.client.request('nvim_buf_delete', [buf.id, { force: false }]);
      }
      return;
    }
    const result = await destination(target);
    const child = relative(source, result);
    if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) {
      throw new Error('Cannot place a folder inside itself.');
    }
    if (action === 'copy') {
      await cp(source, result, { recursive: true, force: false, errorOnExist: true });
    } else if (action === 'rename') {
      const renamed = affected.map((buf) => ({
        id: buf.id,
        name: resolve(result, relative(source, buf.name))
      }));
      if (
        buffers.some(
          (buf) =>
            !affected.includes(buf) && renamed.some((item) => relative(item.name, buf.name) === '')
        )
      ) {
        throw new Error('Close the destination file tab first.');
      }
      await rename(source, result);
      const edited = await this.client.request('nvim_exec_lua', [
        `local renamed = ...
for _, item in ipairs(renamed) do
  if vim.api.nvim_buf_is_valid(item.id) and vim.bo[item.id].modified then
    return true
  end
end
-- Check every buffer and update names in one RPC, without yielding to editor input.
for _, item in ipairs(renamed) do
  if vim.api.nvim_buf_is_valid(item.id) then
    vim.api.nvim_buf_set_name(item.id, item.name)
    if vim.api.nvim_buf_is_loaded(item.id) then
      vim.api.nvim_buf_call(item.id, function() vim.cmd.edit() end)
    end
  end
end
return false`,
        [renamed.map((item) => ({ ...item, name: editorPath(this.root, item.name) }))]
      ]);
      if (edited) {
        // Undo the disk move before touching buffer names; never overwrite a new source.
        await destination(relative(this.root, source));
        await rename(result, source);
        throw new Error(
          'File changed during the move. The move was cancelled; save and try again.'
        );
      }
    } else {
      throw new Error('Unknown file action.');
    }
  }

  async files(relativePath: string, checkIgnored = true): Promise<FileEntry[]> {
    const directory = await this.path(relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((e) => !e.isSymbolicLink() && e.name !== '.git' && (e.isFile() || e.isDirectory()))
      .map((e) => ({
        name: e.name,
        path: relative(this.root, resolve(directory, e.name)),
        directory: e.isDirectory()
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    if (!checkIgnored) {
      return files;
    }
    // Git is optional; ordinary folders still open when it is unavailable.
    const ignored = await gitIgnored(
      this.root,
      files.map((file) => file.path)
    ).catch(() => new Set<string>());
    return files.map((file) => ({ ...file, ignored: ignored.has(file.path) }));
  }

  cancelFindFiles(): void {
    this.search.cancelFindFiles();
  }

  searchText(query: string, options?: SearchOptions): Promise<SearchResults> {
    return this.search.searchText(query, options);
  }

  findFiles(query = ''): Promise<FileEntry[]> {
    return this.search.findFiles(query);
  }
}
