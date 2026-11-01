import { app } from 'electron';
import { basename, isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { readFavorites, writeFavorites } from './persistence';
import { parseWslPath } from '../shared/wsl';
import { resolveWslFolder } from './wsl';

export function registerFavoriteHandlers({
  handle,
  text
}: {
  handle: (name: string, action: (...args: unknown[]) => unknown) => void;
  text: (value: unknown) => string;
}): void {
  const favoritesPath = join(app.getPath('userData'), 'favorites.json');
  let favoriteWrite: Promise<unknown> = Promise.resolve();
  handle('favorites', async () => {
    await favoriteWrite;
    return readFavorites(favoritesPath);
  });
  handle('favorite', (value, kind, enabled) => {
    const path = text(value);
    if (
      !isAbsolute(path) ||
      (kind !== 'editor' && kind !== 'terminal') ||
      typeof enabled !== 'boolean'
    ) {
      throw new Error('Invalid favorite workspace.');
    }
    // Serialize read/modify/write so simultaneous requests cannot overwrite each other.
    const update = favoriteWrite.then(async () => {
      const remote = parseWslPath(path);
      const root = enabled
        ? remote
          ? await resolveWslFolder(remote.distribution, remote.path)
          : await realpath(path)
        : path;
      if (enabled && !(await stat(root)).isDirectory()) {
        throw new Error('Choose a project folder.');
      }
      const favorites = (await readFavorites(favoritesPath)).filter(
        (w) => w.root !== root || w.kind !== kind
      );
      if (enabled) {
        favorites.push({ root, name: basename(root) || root, kind });
      }
      await writeFavorites(favoritesPath, favorites);
      return favorites;
    });
    favoriteWrite = update.catch(() => {});
    return update;
  });
}
