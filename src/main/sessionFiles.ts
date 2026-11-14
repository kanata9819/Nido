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

/** A buffer as Neovim reports it, used to protect open files during file operations. */
interface OpenBuffer {
	id: number;
	name: string;
	modified: boolean;
	/** Shown as a tab. Neovim also keeps hidden buffers, such as previewed files. */
	listed: boolean;
}

/** Whether `path` is `parent` itself or inside it. */
function isWithin(parent: string, path: string): boolean {
	const rel = relative(parent, path);
	return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * The workspace's files: resolving paths, opening files, listing folders for the explorer and
 * the explorer's file operations. Search and replacement are delegated to SessionSearch and
 * WorkspaceReplacement.
 */
export class SessionFiles {
	readonly replacements: WorkspaceReplacement;
	// File operations run one at a time.
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

	/** The real path of a workspace-relative path; throws for anything outside the workspace. */
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

	/** Open a file in the editor, optionally at a (one-based) line and column. */
	async openFile(relativePath: string, line?: number, column = 1): Promise<void> {
		const file = await this.path(relativePath);
		if (!(await stat(file)).isFile()) {
			throw new Error('Choose a file.');
		}
		await this.client.request('nvim_exec_lua', [
			`local path, line, column = ...
local buffer = require('nido_buffers').find(path)
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
		this.validate(path);
		if (action === 'createFile' || action === 'createDirectory') {
			// A new file or folder may name folders that do not exist yet, as in src/new/file.ts.
			const result = await this.destination(path, true);
			if (action === 'createFile') {
				await writeFile(result, '', { flag: 'wx' });
			} else {
				await mkdir(result);
			}
			return;
		}
		const source = await this.path(path);
		this.validate(relative(this.root, source));
		const buffers = await this.buffers();
		// Buffers showing the file, or files inside the folder, that is being changed.
		const affected = buffers.filter((buf) => buf.name && isWithin(source, buf.name));
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
		const result = await this.destination(target);
		if (isWithin(source, result)) {
			throw new Error('Cannot place a folder inside itself.');
		}
		if (
			buffers.some(
				(buf) =>
					!affected.includes(buf) &&
					// A hidden, unedited buffer is not a tab to close.
					(buf.listed || buf.modified) &&
					// Saving an old destination buffer could replace the file moved or copied here,
					// even when the source is not open in the editor.
					isWithin(result, buf.name)
			)
		) {
			throw new Error('Close the destination file tab first.');
		}
		if (action === 'copy') {
			await cp(source, result, { recursive: true, force: false, errorOnExist: true });
		} else if (action === 'rename') {
			await this.move(source, result, affected);
		} else {
			throw new Error('Unknown file action.');
		}
	}

	/** Reject paths outside the workspace, the workspace itself, and anything in .git. */
	private validate(value: string): void {
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
	}

	/**
	 * Resolve a new path which is not taken yet. Its parent must exist, unless `createParents`
	 * is set: then the missing folders are created, inside the nearest existing one.
	 */
	private async destination(value: string, createParents = false): Promise<string> {
		this.validate(value);
		const parent = createParents
			? await this.createParents(dirname(value))
			: await this.path(dirname(value));
		const result = resolve(parent, basename(value));
		this.validate(relative(this.root, result));
		try {
			await lstat(result);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return result;
			}
			throw error;
		}
		throw new Error('A file or folder already exists at that path.');
	}

	/** The folder at a project-relative path, after creating any of it that is missing. */
	private async createParents(folder: string): Promise<string> {
		const missing: string[] = [];
		let existing = folder;
		for (;;) {
			try {
				// Resolving the existing part keeps a link inside it from leading outside.
				const actual = await this.path(existing);
				if (!(await stat(actual)).isDirectory()) {
					throw new Error('A file or folder already exists at that path.');
				}
				if (!missing.length) {
					return actual;
				}
				const result = resolve(actual, ...missing.reverse());
				this.validate(relative(this.root, result));
				await mkdir(result, { recursive: true });
				return result;
			} catch (error) {
				const parent = dirname(existing);
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) {
					throw error;
				}
				missing.push(basename(existing));
				existing = parent;
			}
		}
	}

	/** Every Neovim buffer, with its name as a host path. */
	private async buffers(): Promise<OpenBuffer[]> {
		const buffers = (await this.client.request('nvim_exec_lua', [
			`local result = {}
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  table.insert(result, {id=buf, name=vim.api.nvim_buf_get_name(buf), modified=vim.bo[buf].modified,
    listed=vim.bo[buf].buflisted})
end
return result`,
			[]
		])) as OpenBuffer[];
		for (const buffer of buffers) {
			buffer.name = hostPath(this.root, buffer.name);
		}
		return buffers;
	}

	/**
	 * Move a file or folder on disk, then point its open buffers at the new location. If a buffer
	 * was edited in the meantime, the move is undone.
	 */
	private async move(source: string, result: string, affected: OpenBuffer[]): Promise<void> {
		const renamed = affected.map((buf) => ({
			id: buf.id,
			name: resolve(result, relative(source, buf.name))
		}));
		await rename(source, result);
		const edited = await this.client.request('nvim_exec_lua', [
			`local renamed = ...
for _, item in ipairs(renamed) do
  if vim.api.nvim_buf_is_valid(item.id) and vim.bo[item.id].modified then
    return true
  end
end
local find = require('nido_buffers').find
local function hidden(name, renamed_buffer)
  local buffer = find(name)
  return buffer > 0 and buffer ~= renamed_buffer and buffer or nil
end
for _, item in ipairs(renamed) do
  local taken = vim.api.nvim_buf_is_valid(item.id) and hidden(item.name, item.id)
  if taken and (vim.bo[taken].buflisted or vim.bo[taken].modified) then
    return true
  end
end
-- Check every buffer and update names in one RPC, without yielding to editor input.
for _, item in ipairs(renamed) do
  if vim.api.nvim_buf_is_valid(item.id) then
    local previous = vim.api.nvim_buf_get_name(item.id)
    local taken = hidden(item.name, item.id)
    if taken then vim.api.nvim_buf_delete(taken, {force=true}) end
    vim.api.nvim_buf_set_name(item.id, item.name)
    -- Neovim keeps the old name as a hidden buffer, which would block renaming back to it.
    local stale = hidden(previous, item.id)
    if stale and not vim.api.nvim_buf_is_loaded(stale) and not vim.bo[stale].buflisted then
      vim.api.nvim_buf_delete(stale, {force=true})
    end
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
			await this.destination(relative(this.root, source));
			await rename(result, source);
			throw new Error(
				'File changed during the move. The move was cancelled; save and try again.'
			);
		}
	}

	/**
	 * List one folder for the explorer: folders first, then files, without symbolic links or .git.
	 * With `checkIgnored`, entries are marked when .gitignore excludes them.
	 */
	async files(relativePath: string, checkIgnored = true): Promise<FileEntry[]> {
		const directory = await this.path(relativePath);
		const entries = await readdir(directory, { withFileTypes: true });
		const files = entries
			.filter(
				(e) => !e.isSymbolicLink() && e.name !== '.git' && (e.isFile() || e.isDirectory())
			)
			.map((e) => ({
				name: e.name,
				path: relative(this.root, resolve(directory, e.name)),
				directory: e.isDirectory()
			}))
			.sort(
				(a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)
			);
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
