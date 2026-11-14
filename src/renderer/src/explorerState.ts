import { parseWslPath } from '../../shared/wsl';

// The explorer's state per workspace folder, saved in localStorage.

/** Paths are relative to the workspace folder. */
export interface SavedExplorerState {
	expanded: string[];
	selected: string;
	scrollTop: number;
}

/** A folder path normalized for use as a key: Windows paths compare case-insensitively. */
function pathKey(root: string): string {
	const remote = parseWslPath(root);
	const path = remote
		? `//wsl.localhost/${remote.distribution.toLowerCase()}${remote.path}`
		: /^[a-z]:|^[\\/]{2}/i.test(root)
			? root.replaceAll('\\', '/').toLowerCase()
			: root;
	return path.replace(/\/+$/, '');
}

function storageKey(root: string): string {
	return `nido.explorer.${pathKey(root)}`;
}

/** The path of `file` relative to `root`, with the root's separator; empty when outside it. */
export function explorerFilePath(root: string, file: string): string {
	const prefix = `${pathKey(root)}/`;
	const path = pathKey(file);
	const relative = path.startsWith(prefix) ? path.slice(prefix.length) : '';
	return relativePath(relative) ? relative.replaceAll('/', root.includes('\\') ? '\\' : '/') : '';
}

/** Whether a saved value is a safe relative path (no absolute path, `.` or `..`). */
function relativePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4000 &&
		!/^[\\/]|^[a-z]:|\0/i.test(value) &&
		value.split(/[\\/]/).every((part) => !!part && part !== '.' && part !== '..')
	);
}

/** The saved state of a workspace folder; anything invalid is dropped. */
export function readExplorerState(root: string): SavedExplorerState {
	const empty = { expanded: [], selected: '', scrollTop: 0 };
	try {
		const value = JSON.parse(localStorage.getItem(storageKey(root)) || 'null');
		if (!value || value.version !== 1) {
			return empty;
		}
		return {
			expanded: Array.isArray(value.expanded)
				? [...new Set<string>(value.expanded.filter(relativePath))]
				: [],
			selected: relativePath(value.selected) ? value.selected : '',
			scrollTop:
				typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop)
					? Math.max(0, value.scrollTop)
					: 0
		};
	} catch {
		return empty;
	}
}

/** Save the state of a workspace folder. */
export function writeExplorerState(root: string, state: SavedExplorerState): void {
	try {
		localStorage.setItem(storageKey(root), JSON.stringify({ version: 1, ...state }));
	} catch {
		// An unavailable or full preference store must not interrupt file navigation.
	}
}
