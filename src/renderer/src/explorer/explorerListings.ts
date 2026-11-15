// Pure helpers for the explorer's folder listings.
import type { FileEntry } from '../../../shared/types';

/** The folder of a workspace-relative path; '' for the root. */
export function parentPath(path: string): string {
	return path.replace(/[\\/]?[^\\/]+$/, '');
}

/** Whether two listings of a folder are the same, so the old one can be kept. */
export function sameEntries(previous: FileEntry[] | undefined, next: FileEntry[]): boolean {
	return (
		previous === next ||
		(!!previous &&
			previous.length === next.length &&
			previous.every((entry, index) => {
				const other = next[index];
				return (
					entry.path === other.path &&
					entry.name === other.name &&
					entry.directory === other.directory &&
					entry.ignored === other.ignored
				);
			}))
	);
}

/** The folders whose contents are shown: the root and expanded folders whose parents are too. */
export function shownDirectories(expanded: Set<string>): string[] {
	return ['', ...expanded].filter((path) => {
		for (let parent = parentPath(path); parent; parent = parentPath(parent)) {
			if (!expanded.has(parent)) {
				return false;
			}
		}
		return true;
	});
}

/**
 * Listings loaded together, merged into the old ones. A listing whose request was superseded
 * meanwhile keeps the old entries; unchanged listings keep their old arrays, and when nothing
 * changed at all, `old` itself is returned so React skips the render.
 */
export function mergeListings(
	old: Record<string, FileEntry[]>,
	loaded: { path: string; entries: FileEntry[]; current: boolean }[]
): Record<string, FileEntry[]> {
	const next = Object.fromEntries(
		loaded.map(({ path, entries, current }) => {
			const listing = current ? entries : old[path] || [];
			return [path, sameEntries(old[path], listing) ? old[path] : listing];
		})
	);
	return Object.keys(old).length === loaded.length &&
		loaded.every(({ path }) => old[path] === next[path])
		? old
		: next;
}
