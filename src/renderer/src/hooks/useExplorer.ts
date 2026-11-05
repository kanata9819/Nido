import { onNidoEvent } from '../nidoEvents';
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
	type RefObject
} from 'react';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { FileRequest } from '../components/ExplorerCommands';
import { getVisibleEntries } from '../sidebarTree';
import { explorerFilePath } from '../explorerState';
import { useSavedExplorerState } from './useSavedExplorerState';
import { useExplorerOperations } from './useExplorerOperations';

interface ExplorerState {
	visible: ReturnType<typeof getVisibleEntries>;
	expanded: Set<string>;
	selected: string;
	selectedIndex: number;
	reveal: number;
	setSelected: Dispatch<SetStateAction<string>>;
	setExpanded: Dispatch<SetStateAction<Set<string>>>;
	load: (path: string) => Promise<void>;
	tree: RefObject<HTMLDivElement | null>;
	ready: boolean;
	initialScrollTop: number;
	rememberScroll: (top: number) => void;
	operation: { request?: FileRequest } | undefined;
	setOperation: Dispatch<SetStateAction<{ request?: FileRequest } | undefined>>;
	clipboard: { path: string; name: string; cut: boolean } | undefined;
	commands: { title: string; key: string; disabled?: boolean; run: () => void }[];
	closeOperation: () => void;
	onDone: (path: string) => void;
}

interface DirectoryRequest {
	files: Promise<FileEntry[]>;
	pending: boolean;
	dirty: boolean;
}

function sameEntries(previous: FileEntry[] | undefined, next: FileEntry[]): boolean {
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

export function useExplorer({
	workspace,
	active,
	currentFile,
	onError
}: {
	workspace: Workspace;
	active: boolean;
	currentFile: string;
	onError: (message: string) => void;
}): ExplorerState {
	const [entriesByDirectory, setEntries] = useState<Record<string, FileEntry[]>>({});
	const { expanded, setExpanded, selected, setSelected, initialScrollTop, rememberScroll } =
		useSavedExplorerState(workspace.root);
	const [reveal, setReveal] = useState(0);
	const [ready, setReady] = useState(false);
	const [pageVisible, setPageVisible] = useState(() => !document.hidden);
	const [revision, setRevision] = useState(0);
	const loadedRevision = useRef(-1);
	const requests = useRef(new Map<string, DirectoryRequest>());
	const requestGeneration = useRef(0);
	const tree = useRef<HTMLDivElement>(null);
	const visible = useMemo(
		() => getVisibleEntries(entriesByDirectory, expanded),
		[entriesByDirectory, expanded]
	);
	const directories = useMemo(
		() =>
			['', ...expanded].filter((path) => {
				let parent = path.replace(/[\\/]?[^\\/]+$/, '');
				while (parent) {
					if (!expanded.has(parent)) {
						return false;
					}
					parent = parent.replace(/[\\/]?[^\\/]+$/, '');
				}
				return true;
			}),
		[expanded]
	);
	const watchedDirectories = useMemo(
		() =>
			JSON.stringify(
				ready
					? [
							'',
							...visible
								.filter((entry) => entry.directory && expanded.has(entry.path))
								.map(({ path }) => path)
						]
					: directories
			),
		[ready, visible, expanded, directories]
	);
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
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (
					(event.type === 'filesChanged' || event.type === 'exit') &&
					event.id === workspace.id
				) {
					if (event.type === 'filesChanged') {
						invalidate();
					} else {
						requestGeneration.current++;
						requests.current.clear();
					}
				} else if (event.type === 'directoryChanged' && event.id === workspace.id) {
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
		[workspace.id, invalidate]
	);
	useEffect(
		() => () => {
			requestGeneration.current++;
			requests.current.clear();
			void window.nido.watchDirectories(workspace.id, []).catch(() => {});
		},
		[workspace.id]
	);
	useEffect(() => {
		const visibility = (): void => setPageVisible(!document.hidden);
		document.addEventListener('visibilitychange', visibility);
		return () => document.removeEventListener('visibilitychange', visibility);
	}, []);
	useEffect(() => {
		let cancelled = false;
		const paths: string[] = active && pageVisible ? JSON.parse(watchedDirectories) : [];
		void window.nido.watchDirectories(workspace.id, paths).catch((error) => {
			if (!cancelled && paths.length) {
				onError(String(error));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [workspace.id, active, pageVisible, watchedDirectories, onError]);
	useEffect(() => {
		if (!active || !pageVisible) {
			return;
		}
		// Catch changes made while this tree was hidden or native notifications were unavailable.
		if (requests.current.size) {
			invalidate();
		}
		const focus = (): void => invalidate();
		window.addEventListener('focus', focus);
		return () => window.removeEventListener('focus', focus);
	}, [active, pageVisible, invalidate]);
	const requestDirectory = useCallback(
		(path: string, replace = false): DirectoryRequest => {
			let request = requests.current.get(path);
			if (!request || replace) {
				const next: DirectoryRequest = {
					files: window.nido.files(workspace.id, path),
					pending: true,
					dirty: false
				};
				next.files = next.files.finally(() => {
					next.pending = false;
					if (next.dirty && requests.current.get(path) === next) {
						invalidate([path]);
					}
				});
				request = next;
				requests.current.set(path, request);
			}
			return request;
		},
		[workspace.id, invalidate]
	);
	const load = async (path: string): Promise<void> => {
		// Explicit refreshes supersede old reads; automatic reloads can reuse this request.
		const request = requestDirectory(path, true);
		try {
			const files = await request.files;
			if (requests.current.get(path) === request) {
				setEntries((old) =>
					sameEntries(old[path], files) ? old : { ...old, [path]: files }
				);
			}
		} catch (error) {
			if (requests.current.get(path) === request) {
				requests.current.delete(path);
				onError(String(error));
			}
		}
	};

	useEffect(() => {
		const path = explorerFilePath(workspace.root, currentFile);
		if (!active || !path) {
			return;
		}
		let cancelled = false;
		const revealFile = async (): Promise<void> => {
			const parts = path.split(/[\\/]/);
			const parents: string[] = [];
			let directory = '';
			for (const [index, part] of parts.entries()) {
				let request: DirectoryRequest;
				let files: FileEntry[];
				do {
					request = requestDirectory(directory);
					try {
						files = await request.files;
					} catch (error) {
						if (requests.current.get(directory) === request) {
							requests.current.delete(directory);
						}
						throw error;
					}
					if (cancelled) {
						return;
					}
					// Watchers and manual refreshes can supersede an in-flight directory read.
				} while (requests.current.get(directory) !== request);
				const entry = files.find((entry) => {
					const relative = explorerFilePath(
						workspace.root,
						`${workspace.root}/${entry.path}`
					);
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
		workspace.root,
		active,
		currentFile,
		requestDirectory,
		invalidate,
		onError,
		setExpanded,
		setSelected
	]);

	useEffect(() => {
		// Keep each tree's state, but load hidden workspaces only when first activated or changed.
		if (!active || !pageVisible || loadedRevision.current === revision) {
			return;
		}
		let cancelled = false;
		const generation = requestGeneration.current;
		const current = (): boolean => !cancelled && generation === requestGeneration.current;
		const paths = directories;
		const files: [string, FileEntry[], DirectoryRequest][] = [];
		let nextPath = 0;
		// Bound automatic reloads instead of launching one Git/filesystem request per open folder.
		Promise.all(
			Array.from({ length: Math.min(4, paths.length) }, async () => {
				while (current() && nextPath < paths.length) {
					const path = paths[nextPath++];
					const request = requestDirectory(path);
					try {
						files.push([path, await request.files, request]);
					} catch (error) {
						if (!current() || requests.current.get(path) !== request) {
							continue;
						}
						if (!path || !String(error).includes('ENOENT')) {
							requests.current.delete(path);
							throw error;
						}
						files.push([path, [], request]);
					}
				}
			})
		)
			.then(() => {
				if (current()) {
					loadedRevision.current = revision;
					setEntries((old) => {
						const next = Object.fromEntries(
							files.map(([path, entries, request]) => {
								const current =
									requests.current.get(path) === request
										? entries
										: old[path] || [];
								return [
									path,
									sameEntries(old[path], current) ? old[path] : current
								];
							})
						);
						return Object.keys(old).length === files.length &&
							files.every(([path]) => old[path] === next[path])
							? old
							: next;
					});
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
	}, [workspace.id, active, pageVisible, onError, revision, directories, requestDirectory]);
	const indexByPath = useMemo(
		() => new Map(visible.map((entry, index) => [entry.path, index])),
		[visible]
	);
	const selectedIndex = indexByPath.get(selected) ?? -1;
	const selectedEntry = visible[selectedIndex];
	const { operation, setOperation, clipboard, commands, closeOperation, onDone } =
		useExplorerOperations({
			workspace,
			selectedEntry,
			tree,
			invalidate,
			setSelected,
			setExpanded
		});

	return {
		visible,
		expanded,
		selected,
		selectedIndex,
		reveal,
		setSelected,
		setExpanded,
		load,
		tree,
		ready,
		initialScrollTop,
		rememberScroll,
		operation,
		setOperation,
		clipboard,
		commands,
		closeOperation,
		onDone
	};
}
