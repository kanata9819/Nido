import { resolve } from 'node:path';

/**
 * The Vite dev server URL for a file outside its root.
 *
 * Vite serves such files at `/@fs/` followed by the absolute path without its leading
 * slash: `/@fs/C:/repo/...` on Windows and `/@fs/home/repo/...` on POSIX. Prefixing a
 * POSIX path directly gives `/@fs//home/...`, which loads a second copy of the module,
 * so prototype patches never reach the instance the app imported.
 */
export function viteFsUrl(path: string): string {
	return `/@fs/${resolve(path).replaceAll('\\', '/').replace(/^\/+/, '')}`;
}
