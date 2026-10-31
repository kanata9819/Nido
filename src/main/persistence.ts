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
  try {
    return parseLayout(await readFile(path, 'utf8'));
  } catch (error) {
    // Keep a last-known-good layout available after interrupted or corrupt writes.
    try {
      return parseLayout(await readFile(`${path}.bak`, 'utf8'));
    } catch (backupError) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') {
          return { version: 1, workspaces: [], active: 0 };
        }
        throw backupError;
      }
      throw error;
    }
  }
}

function parseLayout(content: string): SavedLayout {
  const data: SavedLayout = JSON.parse(content);
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
        (w.untitled === undefined ||
          (Array.isArray(w.untitled) &&
            w.untitled.length <= 100 &&
            w.untitled.every(
              (draft) =>
                draft &&
                (draft.id === undefined ||
                  (typeof draft.id === 'string' && /^[a-f0-9-]{36}:\d+$/.test(draft.id))) &&
                Array.isArray(draft.lines) &&
                draft.lines.length > 0 &&
                draft.lines.every((line) => typeof line === 'string' && !line.includes('\n')) &&
                draft.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0) <=
                  8 * 1024 * 1024 + 1 &&
                typeof draft.endOfLine === 'boolean' &&
                ['unix', 'dos', 'mac'].includes(draft.fileformat) &&
                Number.isSafeInteger(draft.line) &&
                draft.line > 0 &&
                Number.isSafeInteger(draft.column) &&
                draft.column >= 0
            ) &&
            w.untitled.reduce(
              (bytes, draft) =>
                bytes + draft.lines.reduce((size, line) => size + Buffer.byteLength(line) + 1, 0),
              0
            ) <=
              16 * 1024 * 1024 + w.untitled.length)) &&
        (w.currentUntitled === undefined ||
          (Number.isSafeInteger(w.currentUntitled) &&
            w.currentUntitled >= 0 &&
            w.currentUntitled < (w.untitled?.length ?? 0))) &&
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

export async function writeLayout(
  path: string,
  data: SavedLayout,
  options: { replaceBackup?: boolean } = {}
): Promise<void> {
  parseLayout(JSON.stringify(data));
  let previous: SavedLayout | undefined;
  try {
    previous = parseLayout(await readFile(path, 'utf8'));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && error.message === 'Invalid saved workspace data.')
    ) {
      throw error;
    }
  }
  // A damaged primary file must never replace a valid backup.
  if (!options.replaceBackup && previous && JSON.stringify(previous) !== JSON.stringify(data)) {
    await writeJson(`${path}.bak`, retainExistingDrafts(previous, data));
  }
  await writeJson(path, data);
  if (options.replaceBackup) {
    await writeJson(`${path}.bak`, data);
  }
}

/** A backup must not resurrect drafts that have since been saved or discarded. */
function retainExistingDrafts(previous: SavedLayout, current: SavedLayout): SavedLayout {
  const ids = new Set(
    current.workspaces.flatMap((workspace) =>
      (workspace.untitled || []).flatMap((draft) => (draft.id ? [draft.id] : []))
    )
  );
  return {
    ...previous,
    workspaces: previous.workspaces.map((workspace) => {
      if (!workspace.untitled) {
        return workspace;
      }
      const retained = workspace.untitled.filter((draft) => draft.id && ids.has(draft.id));
      const active =
        workspace.currentUntitled === undefined
          ? undefined
          : workspace.untitled[workspace.currentUntitled];
      const currentUntitled = active ? retained.indexOf(active) : -1;
      const rest = { ...workspace };
      delete rest.untitled;
      delete rest.currentUntitled;
      return {
        ...rest,
        ...(retained.length ? { untitled: retained } : {}),
        ...(currentUntitled >= 0 ? { currentUntitled } : {})
      };
    })
  };
}

export async function readFavorites(path: string): Promise<FavoriteWorkspace[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
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
  await writeFile(`${path}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
