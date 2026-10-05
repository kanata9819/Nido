import { readFile } from 'node:fs/promises';

// Neovim may replace a file while saving on Windows. Let expect.poll retry the brief gap.
export async function readSavedFile(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
