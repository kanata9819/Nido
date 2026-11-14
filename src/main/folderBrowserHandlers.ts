import { app } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { parseWslPath } from '../shared/wsl';
import { resolveWslFolder, wslDistributions } from './wsl';

/** Whether a drive root can be listed. A disconnected network drive can take long to fail. */
async function readableDrive(root: string): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			stat(root).then((info) => info.isDirectory()),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 2000);
			})
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** The roots of the drives that this Windows computer can open, such as C:\ and D:\. */
export async function windowsDrives(
	platform = process.platform,
	readable: (root: string) => Promise<boolean> = readableDrive
): Promise<string[]> {
	if (platform !== 'win32') {
		return [];
	}
	const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
	const found = await Promise.all(roots.map((root) => readable(root).catch(() => false)));
	return roots.filter((_, index) => found[index]);
}

/** IPC handlers for the folder picker that opens a workspace, including folders in WSL. */
export function registerFolderBrowserHandlers({
	handle,
	text
}: {
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	text: (value: unknown) => string;
}): void {
	handle('wslDistributions', () => wslDistributions());
	handle('windowsDrives', () => windowsDrives());
	// List the subfolders of a folder. Without a path this starts at the home folder; with a
	// `distribution` the path is a Linux path inside that WSL distribution.
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
