import { realpath, readdir, stat, lstat, mkdir, writeFile, rename, cp } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type NeovimClient } from 'neovim';
import { gitIgnored } from './git';
import type { FileAction, FileEntry } from '../shared/types';

export class SessionFiles {
    constructor(
        private readonly root: string,
        private readonly client: NeovimClient
    ) {}

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

    async openFile(relativePath: string): Promise<void> {
        const file = await this.path(relativePath);
        if (!(await stat(file)).isFile()) {
            throw new Error('Choose a file.');
        }
        await this.client.request('nvim_exec_lua', [
            'vim.cmd.edit(vim.fn.fnameescape(...))',
            [file]
        ]);
    }

    async fileAction(
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
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
                throw error;
            }
            throw new Error('A file or folder already exists at that path.');
        };
        if (action === 'createFile' || action === 'createDirectory') {
            const result = await destination(path);
            if (action === 'createFile') await writeFile(result, '', { flag: 'wx' });
            else await mkdir(result);
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
        const affected = buffers.filter((buf) => {
            if (!buf.name) return false;
            const rel = relative(source, buf.name);
            return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
        });
        if (affected.some((buf) => buf.modified))
            throw new Error('Save unsaved changes in this file or folder first.');
        if (action === 'delete') {
            await trash(source);
            for (const buf of affected)
                await this.client.request('nvim_buf_delete', [buf.id, { force: true }]);
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
                        !affected.includes(buf) &&
                        renamed.some((item) => item.name.toLowerCase() === buf.name.toLowerCase())
                )
            ) {
                throw new Error('Close the destination file tab first.');
            }
            await rename(source, result);
            for (const buf of renamed)
                await this.client.request('nvim_exec_lua', [
                    `local buf, name = ...
vim.api.nvim_buf_set_name(buf, name)
-- Reload the clean buffer so Neovim recognizes the moved file as an existing file.
if vim.api.nvim_buf_is_loaded(buf) then
  vim.api.nvim_buf_call(buf, function() vim.cmd.edit({bang=true}) end)
end`,
                    [buf.id, buf.name]
                ]);
        } else {
            throw new Error('Unknown file action.');
        }
    }

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
        if (!checkIgnored) return files;
        // Git is optional; ordinary folders still open when it is unavailable.
        const ignored = await gitIgnored(
            this.root,
            files.map((file) => file.path)
        ).catch(() => new Set<string>());
        return files.map((file) => ({ ...file, ignored: ignored.has(file.path) }));
    }

    async findFiles(): Promise<FileEntry[]> {
        const result: FileEntry[] = [];
        const visit = async (directory: string, depth: number): Promise<void> => {
            if (depth > 12 || result.length >= 5000) {
                return;
            }
            for (const entry of await this.files(directory, false)) {
                if (result.length >= 5000) {
                    break;
                }
                if (!entry.directory) {
                    result.push(entry);
                } else if (
                    !['node_modules', 'dist', 'out', 'build', 'target', '.next'].includes(
                        entry.name
                    )
                ) {
                    await visit(entry.path, depth + 1);
                }
            }
        };
        // ponytail: cap at 5,000 files/12 levels; use a cancellable indexed search for larger projects.
        await visit('', 0);
        return result;
    }
}
