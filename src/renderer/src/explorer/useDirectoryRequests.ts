import { useCallback, useEffect, useRef, useState } from 'react';
import { onNidoEvent } from '../nidoEvents';
import type { FileEntry } from '../../../shared/types';

/**
 * A folder listing being loaded or loaded. `dirty` marks a listing whose folder changed while
 * it was loading, so it is read once more afterwards.
 */
export interface DirectoryRequest {
	files: Promise<FileEntry[]>;
	pending: boolean;
	dirty: boolean;
}

/** The explorer's folder listings in flight or loaded, and when they must be read again. */
export interface DirectoryRequests {
	/** Grows when listings must be reloaded. */
	revision: number;
	/** Grows when every request is invalidated, so a reload started earlier is dropped. */
	generation: () => number;
	/** Whether `request` is still the latest listing of `path`. */
	isCurrent: (path: string, request: DirectoryRequest) => boolean;
	/** Forget a listing that failed, unless a newer one replaced it. */
	forget: (path: string, request: DirectoryRequest) => void;
	/** Whether any folder was listed. */
	any: () => boolean;
	/** Reload some folders (`paths`) or all of them. */
	invalidate: (paths?: string[]) => void;
	/** The listing of a folder, reusing a request in progress unless `replace` is set. */
	request: (path: string, replace?: boolean) => DirectoryRequest;
}

/**
 * The folder listings of a workspace's explorer. Changes reported by the main process
 * invalidate them, and closing the workspace stops watching its folders.
 */
export function useDirectoryRequests(workspaceId: string): DirectoryRequests {
	const [revision, setRevision] = useState(0);
	const requests = useRef(new Map<string, DirectoryRequest>());
	const requestGeneration = useRef(0);

	const invalidate = useCallback((paths?: string[]): void => {
		requestGeneration.current++;
		if (paths) {
			for (const path of paths) {
				requests.current.delete(path);
			}
		} else {
			requests.current.clear();
		}
		setRevision((value) => value + 1);
	}, []);

	// Reload folders when files change, or only the folders a watcher reported.
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (
					(event.type === 'filesChanged' || event.type === 'exit') &&
					event.id === workspaceId
				) {
					if (event.type === 'filesChanged') {
						invalidate();
					} else {
						requestGeneration.current++;
						requests.current.clear();
					}
				} else if (event.type === 'directoryChanged' && event.id === workspaceId) {
					const paths: string[] = [];
					for (const path of event.paths) {
						const request = requests.current.get(path);
						if (!request) {
							continue;
						}
						if (request.pending) {
							// Follow a slow read with one fresh read, even after many notifications.
							request.dirty = true;
						} else {
							paths.push(path);
						}
					}
					if (paths.length) {
						invalidate(paths);
					}
				}
			}),
		[workspaceId, invalidate]
	);
	// Stop watching when the workspace closes.
	useEffect(
		() => () => {
			requestGeneration.current++;
			requests.current.clear();
			void window.nido.watchDirectories(workspaceId, []).catch(() => {});
		},
		[workspaceId]
	);

	const request = useCallback(
		(path: string, replace = false): DirectoryRequest => {
			let current = requests.current.get(path);
			if (!current || replace) {
				const next: DirectoryRequest = {
					files: window.nido.files(workspaceId, path),
					pending: true,
					dirty: false
				};
				next.files = next.files.finally(() => {
					next.pending = false;
					if (next.dirty && requests.current.get(path) === next) {
						invalidate([path]);
					}
				});
				current = next;
				requests.current.set(path, current);
			}
			return current;
		},
		[workspaceId, invalidate]
	);

	const isCurrent = useCallback(
		(path: string, candidate: DirectoryRequest): boolean =>
			requests.current.get(path) === candidate,
		[]
	);
	const forget = useCallback((path: string, candidate: DirectoryRequest): void => {
		if (requests.current.get(path) === candidate) {
			requests.current.delete(path);
		}
	}, []);
	const generation = useCallback(() => requestGeneration.current, []);
	const any = useCallback(() => requests.current.size > 0, []);

	return { revision, generation, isCurrent, forget, any, invalidate, request };
}
