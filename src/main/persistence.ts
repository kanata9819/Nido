import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SavedWorkspace } from '../shared/types';

export interface SavedLayout {
  version: 1;
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
  )
    throw new Error('Invalid saved workspace data.');
  return data;
}

export async function writeLayout(path: string, data: SavedLayout): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(data), 'utf8');
  await rename(`${path}.tmp`, path);
}
