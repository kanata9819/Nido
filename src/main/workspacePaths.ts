import { posix, relative, sep } from 'node:path';
import { parseWslPath } from '../shared/wsl';

/**
 * `path.relative` that also works between two paths in the same WSL distribution. Those are
 * compared as Linux paths, because Linux files remain case sensitive even when Windows
 * accesses them over WSL's share.
 */
export function workspaceRelative(from: string, to: string): string {
	const source = parseWslPath(from);
	const target = parseWslPath(to);
	if (
		source &&
		target &&
		source.distribution.toLowerCase() === target.distribution.toLowerCase()
	) {
		return posix.relative(source.path, target.path).replaceAll('/', sep);
	}
	return relative(from, to);
}

/** Whether two paths refer to the same location. */
export function sameWorkspacePath(from: string, to: string): boolean {
	return workspaceRelative(from, to) === '';
}
