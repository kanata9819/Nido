// The effects that keep an explorer's listings current: watching the shown folders,
// reloading after the window returns, revealing the current file and loading shown folders.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { FileEntry } from '../../../shared/types';
import { explorerFilePath } from './explorerState';
import { mergeListings } from './explorerListings';
import type { DirectoryRequest, DirectoryRequests } from './useDirectoryRequests';

/** Whether the window is visible. */
export function usePageVisible(): boolean {
	const [pageVisible, setPageVisible] = useState(() => !document.hidden);
	useEffect(() => {
		const visibility = (): void => setPageVisible(!document.hidden);
		document.addEventListener('visibilitychange', visibility);
		return () => document.removeEventListener('visibilitychange', visibility);
	}, []);
	return pageVisible;
}

/**
 * Watch `watchedDirectories` (a JSON list) while the workspace is active and the window is
 * visible; watch nothing otherwise.
 */
export function useDirectoryWatch(
	workspaceId: string,
	active: boolean,
	pageVisible: boolean,
	watchedDirectories: string,
	onError: (message: string) => void
): void {
	useEffect(() => {
		let cancelled = false;
		const paths: string[] = active && pageVisible ? JSON.parse(watchedDirectories) : [];
		void window.nido.watchDirectories(workspaceId, paths).catch((error) => {
			if (!cancelled && paths.length) {
				onError(String(error));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, active, pageVisible, watchedDirectories, onError]);
}

/**
 * Reload when the tree is shown again or the window regains focus, to catch changes that no
 * notification reported.
 */
export function useReloadOnReturn(
	shown: boolean,
	any: () => boolean,
	invalidate: () => void
): void {
	useEffect(() => {
		if (!shown) {
			return;
		}
		// Catch changes made while this tree was hidden or native notifications were unavailable.
		if (any()) {
			invalidate();
		}
		const focus = (): void => invalidate();
		window.addEventListener('focus', focus);
		return () => window.removeEventListener('focus', focus);
	}, [shown, any, invalidate]);
}

/** Read a folder's listing, again while a newer request supersedes the one awaited. */
async function currentListing(
	listings: Pick<DirectoryRequests, 'request' | 'isCurrent' | 'forget'>,
	directory: string,
	cancelled: () => boolean
): Promise<FileEntry[] | undefined> {
	let request: DirectoryRequest;
	let files: FileEntry[];
	do {
		request = listings.request(directory);
		try {
			files = await request.files;
		} catch (error) {
			listings.forget(directory, request);
			throw error;
		}
		if (cancelled()) {
			return undefined;
		}
		// Watchers and manual refreshes can supersede an in-flight directory read.
	} while (!listings.isCurrent(directory, request));
	return files;
}

/** Reveal the current file while the tree is active: expand its parent folders and select it. */
export function useRevealFile({
	root,
	active,
	currentFile,
	request,
	isCurrent,
	forget,
	invalidate,
	onError,
	setExpanded,
	setSelected,
	setReveal
}: Pick<DirectoryRequests, 'request' | 'isCurrent' | 'forget' | 'invalidate'> & {
	root: string;
	active: boolean;
	currentFile: string;
	onError: (message: string) => void;
	setExpanded: Dispatch<SetStateAction<Set<string>>>;
	setSelected: Dispatch<SetStateAction<string>>;
	setReveal: Dispatch<SetStateAction<number>>;
}): void {
	useEffect(() => {
		const path = explorerFilePath(root, currentFile);
		if (!active || !path) {
			return;
		}
		let cancelled = false;
		const listings = { request, isCurrent, forget };
		const revealFile = async (): Promise<void> => {
			const parts = path.split(/[\\/]/);
			const parents: string[] = [];
			let directory = '';
			for (const [index, part] of parts.entries()) {
				const files = await currentListing(listings, directory, () => cancelled);
				if (!files) {
					return;
				}
				const entry = files.find((entry) => {
					const relative = explorerFilePath(root, `${root}/${entry.path}`);
					return relative.split(/[\\/]/)[index] === part;
				});
				if (!entry) {
					return;
				}
				if (!entry.directory) {
					if (index !== parts.length - 1) {
						return;
					}
					setExpanded((old) => new Set([...old, ...parents]));
					setSelected(entry.path);
					setReveal((value) => value + 1);
					invalidate([]);
					return;
				}
				directory = entry.path;
				parents.push(directory);
			}
		};
		void revealFile().catch((error) => {
			if (!cancelled && !String(error).includes('ENOENT')) {
				onError(String(error));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [
		root,
		active,
		currentFile,
		request,
		isCurrent,
		forget,
		invalidate,
		onError,
		setExpanded,
		setSelected,
		setReveal
	]);
}

/** How many folders load at once when the whole tree reloads. */
const parallelLoads = 4;

/**
 * Load every shown folder when the tree becomes visible or after an invalidation, at most four
 * at a time. A hidden workspace's tree keeps its state but loads only when shown again.
 */
export function useShownDirectories({
	shown,
	directories,
	revision,
	generation,
	request,
	isCurrent,
	forget,
	onError,
	setEntries,
	setReady
}: Pick<DirectoryRequests, 'revision' | 'generation' | 'request' | 'isCurrent' | 'forget'> & {
	shown: boolean;
	directories: string[];
	onError: (message: string) => void;
	setEntries: Dispatch<SetStateAction<Record<string, FileEntry[]>>>;
	setReady: (ready: boolean) => void;
}): void {
	// The last revision loaded.
	const loadedRevision = useRef(-1);
	useEffect(() => {
		if (!shown || loadedRevision.current === revision) {
			return;
		}
		let cancelled = false;
		const started = generation();
		const current = (): boolean => !cancelled && started === generation();
		const paths = directories;
		const loaded: [string, FileEntry[], DirectoryRequest][] = [];
		let nextPath = 0;
		const worker = async (): Promise<void> => {
			while (current() && nextPath < paths.length) {
				const path = paths[nextPath++];
				const listing = request(path);
				try {
					loaded.push([path, await listing.files, listing]);
				} catch (error) {
					if (!current() || !isCurrent(path, listing)) {
						continue;
					}
					if (!path || !String(error).includes('ENOENT')) {
						forget(path, listing);
						throw error;
					}
					loaded.push([path, [], listing]);
				}
			}
		};
		// Bound automatic reloads instead of launching one Git/filesystem request per open folder.
		Promise.all(Array.from({ length: Math.min(parallelLoads, paths.length) }, worker))
			.then(() => {
				if (current()) {
					loadedRevision.current = revision;
					setEntries((old) =>
						mergeListings(
							old,
							loaded.map(([path, entries, listing]) => ({
								path,
								entries,
								current: isCurrent(path, listing)
							}))
						)
					);
					setReady(true);
				}
			})
			.catch((error) => {
				if (current()) {
					cancelled = true;
					onError(String(error));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		shown,
		onError,
		revision,
		directories,
		generation,
		request,
		isCurrent,
		forget,
		setEntries,
		setReady
	]);
}
