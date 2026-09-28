import { realpath, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { type NeovimClient } from 'neovim';
import { gitIgnored } from './git';
import type { FileEntry } from '../shared/types';

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
