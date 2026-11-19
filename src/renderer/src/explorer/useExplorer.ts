import {
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
	type RefObject
} from 'react';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { FileRequest } from './ExplorerCommands';
import { getVisibleEntries } from './sidebarTree';
import { useSavedExplorerState } from './useSavedExplorerState';
import { useExplorerOperations } from './useExplorerOperations';
import { sameEntries, shownDirectories } from './explorerListings';
import { useDirectoryRequests } from './useDirectoryRequests';
import {
	useDirectoryWatch,
	usePageVisible,
	useReloadOnReturn,
	useRevealFile,
	useShownDirectories
} from './useExplorerLoading';

/** The explorer tree of a workspace and the actions on it. */
interface ExplorerState {
	visible: ReturnType<typeof getVisibleEntries>;
	expanded: Set<string>;
	selected: string;
	selectedIndex: number;
	/** Grows when the selection should be scrolled into view, such as after revealing a file. */
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
	onDone: (path: string, request?: FileRequest) => void;
}

/**
 * The explorer of a workspace: loads the expanded folders, watches them for changes, and
 * reveals the current file. A hidden workspace's tree keeps its state but loads only when
 * shown again.
 */
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
	const tree = useRef<HTMLDivElement>(null);
	const visible = useMemo(
		() => getVisibleEntries(entriesByDirectory, expanded),
		[entriesByDirectory, expanded]
	);
	const directories = useMemo(() => shownDirectories(expanded), [expanded]);
	// The folders to watch, as JSON so the watch effect only runs when the list changes.
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

	// The effects below run in this order; each later one relies on the requests above.
	const listings = useDirectoryRequests(workspace.id);
	const { request, isCurrent, forget, invalidate } = listings;
	const pageVisible = usePageVisible();
	const shown = active && pageVisible;
	useDirectoryWatch(workspace.id, active, pageVisible, watchedDirectories, onError);
	useReloadOnReturn(shown, listings.any, invalidate);
	useRevealFile({
		root: workspace.root,
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
	});
	useShownDirectories({
		shown,
		directories,
		revision: listings.revision,
		generation: listings.generation,
		request,
		isCurrent,
		forget,
		onError,
		setEntries,
		setReady
	});

	/** Load a folder now, for example when it is expanded. */
	const load = async (path: string): Promise<void> => {
		// Explicit refreshes supersede old reads; automatic reloads can reuse this request.
		const listing = request(path, true);
		try {
			const files = await listing.files;
			if (isCurrent(path, listing)) {
				setEntries((old) =>
					sameEntries(old[path], files) ? old : { ...old, [path]: files }
				);
			}
		} catch (error) {
			if (isCurrent(path, listing)) {
				forget(path, listing);
				onError(String(error));
			}
		}
	};

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
