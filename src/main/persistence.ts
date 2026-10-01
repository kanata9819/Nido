import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FavoriteWorkspace, SavedWorkspace } from '../shared/types';

export interface SavedLayout {
    version: 1;
    window?: { width: number; height: number; maximized: boolean };
    workspaces: SavedWorkspace[];
    active: number;
}

export async function readLayout(path: string): Promise<SavedLayout> {
    let data: SavedLayout;
    try {
        data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, workspaces: [], active: 0 };
        }
        throw error;
    }
    if (
        !data ||
        data.version !== 1 ||
        !Number.isInteger(data.active) ||
        !Array.isArray(data.workspaces) ||
        !data.workspaces.every(
            (w) =>
                w &&
                (w.kind === undefined || w.kind === 'editor' || w.kind === 'terminal') &&
                (w.terminal === undefined || typeof w.terminal === 'boolean') &&
                typeof w.root === 'string' &&
                isAbsolute(w.root) &&
                typeof w.current === 'string' &&
                Array.isArray(w.files) &&
                w.files.every(
                    (f) =>
                        f &&
                        typeof f.path === 'string' &&
                        isAbsolute(f.path) &&
                        Number.isSafeInteger(f.line) &&
                        f.line > 0 &&
                        Number.isSafeInteger(f.column) &&
                        f.column >= 0
                )
        )
    ) {
        throw new Error('Invalid saved workspace data.');
    }
    return data;
}

export async function writeLayout(path: string, data: SavedLayout): Promise<void> {
    await writeJson(path, data);
}

export async function readFavorites(path: string): Promise<FavoriteWorkspace[]> {
    let data: unknown;
    try {
        data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    if (
        !Array.isArray(data) ||
        !data.every(
            (w) =>
                w &&
                typeof w.root === 'string' &&
                isAbsolute(w.root) &&
                typeof w.name === 'string' &&
                (w.kind === 'editor' || w.kind === 'terminal')
        )
    ) {
        throw new Error('Invalid favorite workspace data.');
    }
    return data;
}

export async function writeFavorites(path: string, data: FavoriteWorkspace[]): Promise<void> {
    await writeJson(path, data);
}

async function writeJson(path: string, data: unknown): Promise<void> {
    await writeFile(`${path}.tmp`, JSON.stringify(data), 'utf8');
    await rename(`${path}.tmp`, path);
}
