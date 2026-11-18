import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction
} from 'react';
import type { FileEntry } from '../../../../shared/types';
import { parseWslPath } from '../../../../shared/wsl';

type Listing = Awaited<ReturnType<typeof window.nido.browseFolders>>;

/** Let a completed browse focus the list if the user stayed in the same control. */
function captureBrowseFocus(): () => boolean {
	const focused = document.activeElement;
	return () => document.activeElement === focused || document.activeElement === document.body;
}

/** The folder browser's state and navigation, as FolderPicker shows it. */
export interface FolderBrowser {
	/** The connection: a WSL distribution, or '' for this computer. */
	distribution: string;
	/** The path in the address field; a Linux path for a WSL connection. */
	path: string;
	setPath: (path: string) => void;
	/** The folder listed, and the one above it. */
	directory: string;
	parent: string;
	folders: FileEntry[];
	loading: boolean;
	error: string;
	setError: (error: string) => void;
	/** Grows with every listing, so the list can scroll back to its top. */
	listing: number;
	/** Whether the folder listed is a Windows drive root; above it, the drives are listed. */
	atDriveRoot: boolean;
	/** Whether there is a level above the folder listed. */
	canBrowseParent: boolean;
	changeConnection: (distribution: string, initial?: string) => void;
	browse: (path: string) => Promise<void>;
	browseParent: () => void;
}

/**
 * Browse the folders of this computer or of a WSL distribution. Only the latest listing
 * request is shown; each listing resets the selection with `setSelected(0)`. `focusList`
 * moves focus to the list once a listing the user asked for arrives.
 */
export function useFolderBrowser(
	initialPath: string,
	setSelected: Dispatch<SetStateAction<number>>,
	focusList: () => void
): FolderBrowser {
	// The connection and where it started.
	const [location, setLocation] = useState(() => ({
		distribution: parseWslPath(initialPath)?.distribution || '',
		initialPath
	}));
	const distribution = location.distribution;
	const [path, setPath] = useState(parseWslPath(initialPath)?.path || initialPath);
	const [directory, setDirectory] = useState('');
	const [parent, setParent] = useState('');
	const [folders, setFolders] = useState<FileEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [listing, setListing] = useState(0);
	// Grows with every listing request, so only the latest one is shown.
	const request = useRef({ id: 0 });

	/** Show a folder listing. */
	const applyFolders = useCallback(
		(result: Listing): void => {
			setPath(parseWslPath(result.path)?.path || result.path);
			setDirectory(result.path);
			setParent(result.parent);
			setFolders(result.folders);
			setSelected(0);
			setListing((value) => value + 1);
		},
		[setSelected]
	);

	/**
	 * Run a listing request. Its result is shown only while no later request started, and
	 * `focus` decides then whether the list takes focus.
	 */
	async function list(load: () => Promise<Listing>, focus: () => boolean): Promise<void> {
		const id = ++request.current.id;
		setLoading(true);
		setError('');
		try {
			const result = await load();
			if (id !== request.current.id) {
				return;
			}
			applyFolders(result);
			requestAnimationFrame(() => {
				if (id === request.current.id && focus()) {
					focusList();
				}
			});
		} catch (error) {
			if (id === request.current.id) {
				setError(String(error));
			}
		} finally {
			if (id === request.current.id) {
				setLoading(false);
			}
		}
	}

	/** Switch to another connection, starting at `initial` (its home folder when empty). */
	function changeConnection(next: string, initial = ''): void {
		request.current.id++;
		setLoading(true);
		setError('');
		setDirectory('');
		setFolders([]);
		setPath(parseWslPath(initial)?.path || initial);
		setLocation({ distribution: next, initialPath: initial });
	}

	/** List a folder; a path in another WSL distribution switches the connection first. */
	async function browse(next: string): Promise<void> {
		const remote = parseWslPath(next);
		if (remote && remote.distribution !== distribution) {
			changeConnection(remote.distribution, next);
			return;
		}
		await list(
			() => window.nido.browseFolders(next, distribution || undefined),
			captureBrowseFocus()
		);
	}

	/** List the drives of this computer, as the level above a drive root. */
	function browseDrives(): Promise<void> {
		return list(
			async () => ({
				path: '',
				parent: '',
				folders: (await window.nido.windowsDrives()).map((root) => ({
					name: root.replace(/[\\/]$/, ''),
					path: root,
					directory: true
				}))
			}),
			captureBrowseFocus()
		);
	}

	const atDriveRoot = !distribution && /^[a-z]:[\\/]$/i.test(directory);

	// List the starting folder whenever the connection changes.
	useEffect(() => {
		const counter = request.current;
		const id = ++counter.id;
		void window.nido
			.browseFolders(location.initialPath, location.distribution || undefined)
			.then(
				(result) => {
					if (id === counter.id) {
						applyFolders(result);
					}
				},
				(error) => {
					if (id === counter.id) {
						setError(String(error));
					}
				}
			)
			.finally(() => {
				if (id === counter.id) {
					setLoading(false);
				}
			});
		return () => {
			counter.id++;
		};
	}, [location, applyFolders]);

	return {
		distribution,
		path,
		setPath,
		directory,
		parent,
		folders,
		loading,
		error,
		setError,
		listing,
		atDriveRoot,
		canBrowseParent: parent !== directory || atDriveRoot,
		changeConnection,
		browse,
		browseParent: () => void (atDriveRoot ? browseDrives() : browse(parent))
	};
}

/** The WSL distributions to connect to, or why they could not be listed. */
export function useWslDistributions(): { distributions: string[]; error: string } {
	const [distributions, setDistributions] = useState<string[]>([]);
	const [error, setError] = useState('');
	useEffect(() => {
		let cancelled = false;
		void window.nido.wslDistributions().then(
			(names) => {
				if (!cancelled) {
					setDistributions(Array.isArray(names) ? names : []);
				}
			},
			(reason) => {
				if (!cancelled) {
					setError(String(reason));
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, []);
	return { distributions, error };
}
