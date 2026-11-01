import { app } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { parseWslPath } from '../shared/wsl';
import { resolveWslFolder, wslDistributions } from './wsl';

export function registerFolderBrowserHandlers({
  handle,
  text
}: {
  handle: (name: string, action: (...args: unknown[]) => unknown) => void;
  text: (value: unknown) => string;
}): void {
  handle('wslDistributions', () => wslDistributions());
  handle('browseFolders', async (value, distribution) => {
    const requested = value === undefined || value === '' ? app.getPath('home') : text(value);
    const remote = parseWslPath(requested);
    if (distribution === undefined && !isAbsolute(requested)) {
      throw new Error('Enter an absolute folder path.');
    }
    const path =
      distribution !== undefined
        ? await resolveWslFolder(text(distribution), value === undefined ? '' : text(value))
        : remote
          ? await resolveWslFolder(remote.distribution, remote.path)
          : await realpath(requested);
    const entries = await readdir(path, { withFileTypes: true });
    return {
      path,
      parent: dirname(path),
      folders: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(path, entry.name),
          directory: true
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    };
  });
}
