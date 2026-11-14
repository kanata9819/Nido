import sharedStyles from '../assets/Nido.module.css';
import { useErrorMessage, useI18n } from '../i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Star, X } from 'lucide-react';
import type { FavoriteWorkspace, FileEntry } from '../../../shared/types';
import styles from '../assets/Palette.module.css';
import { parseWslPath, wslHostPath } from '../../../shared/wsl';

/**
 * The folder picker for opening a workspace: browse local folders, drives or a WSL
 * distribution's folders, or pick a favorite (Ctrl+F). Ctrl+L edits the path and Ctrl+Enter
 * opens the folder shown.
 */
export default function FolderPicker({
	initialPath,
	initialFavorites = false,
	favorites,
	favoriteBusy,
	onOpenFavorite,
	onRemoveFavorite,
	busy,
	onOpen
}: {
	initialPath: string;
	/** Start on the favorites view instead of the folder browser. */
	initialFavorites?: boolean;
	favorites: FavoriteWorkspace[];
	favoriteBusy: boolean;
	onOpenFavorite: (favorite: FavoriteWorkspace) => void;
	onRemoveFavorite: (favorite: FavoriteWorkspace) => void;
	busy: boolean;
	onOpen: (path: string) => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	// The connection (a WSL distribution, or '' for this computer) and where it started.
	const [location, setLocation] = useState(() => ({
		distribution: parseWslPath(initialPath)?.distribution || '',
		initialPath
	}));
	const distribution = location.distribution;
	const [distributions, setDistributions] = useState<string[]>([]);
	const [wslError, setWslError] = useState('');
	// The path in the address field; a Linux path for a WSL connection.
	const [path, setPath] = useState(parseWslPath(initialPath)?.path || initialPath);
	const [directory, setDirectory] = useState('');
	const [parent, setParent] = useState('');
	const [folders, setFolders] = useState<FileEntry[]>([]);
	const [selected, setSelected] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const list = useRef<HTMLDivElement>(null);
	const address = useRef<HTMLInputElement>(null);
	// Grows with every listing request, so only the latest one is shown.
	const request = useRef({ id: 0 });
	// Favorites stay out of the way until requested (Ctrl+F or the Favorites button).
	const [showFavorites, setShowFavorites] = useState(initialFavorites);
	// Bumped per listing so the folder list starts at its top after each move.
	const [listing, setListing] = useState(0);
	const choiceCount = showFavorites ? favorites.length : folders.length;
	// Keep the selection in range when the list gets shorter.
	const [previousChoiceCount, setPreviousChoiceCount] = useState(choiceCount);
	if (choiceCount !== previousChoiceCount) {
		setPreviousChoiceCount(choiceCount);
		setSelected((value) => Math.max(0, Math.min(value, choiceCount - 1)));
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
	/** Show a folder listing. */
	const applyFolders = useCallback(
		(result: Awaited<ReturnType<typeof window.nido.browseFolders>>): void => {
			setPath(parseWslPath(result.path)?.path || result.path);
			setDirectory(result.path);
			setParent(result.parent);
			setFolders(result.folders);
			setSelected(0);
			setListing((value) => value + 1);
		},
		[]
	);
	/** List a folder; a path in another WSL distribution switches the connection first. */
	async function browse(next: string): Promise<void> {
		const remote = parseWslPath(next);
		if (remote && remote.distribution !== distribution) {
			changeConnection(remote.distribution, next);
			return;
		}
		const id = ++request.current.id;
		const focused = document.activeElement;
		setLoading(true);
		setError('');
		try {
			const result = await window.nido.browseFolders(next, distribution || undefined);
			if (id !== request.current.id) {
				return;
			}
			applyFolders(result);
			requestAnimationFrame(() => {
				if (
					id === request.current.id &&
					(document.activeElement === focused || document.activeElement === document.body)
				) {
					list.current?.focus();
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
	// Above a Windows drive root, the picker lists the drives, so another one can be opened.
	const atDriveRoot = !distribution && /^[a-z]:[\\/]$/i.test(directory);
	/** List the drives of this computer, as the level above a drive root. */
	async function browseDrives(): Promise<void> {
		const id = ++request.current.id;
		setLoading(true);
		setError('');
		try {
			const drives = await window.nido.windowsDrives();
			if (id !== request.current.id) {
				return;
			}
			applyFolders({
				path: '',
				parent: '',
				folders: drives.map((root) => ({
					name: root.replace(/[\\/]$/, ''),
					path: root,
					directory: true
				}))
			});
			requestAnimationFrame(() => {
				if (id === request.current.id) {
					list.current?.focus();
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
	/** Go up one folder. */
	function browseParent(): void {
		void (atDriveRoot ? browseDrives() : browse(parent));
	}
	useEffect(() => {
		list.current?.focus();
	}, []);
	// Load the WSL distributions for the connection list.
	useEffect(() => {
		let cancelled = false;
		void window.nido.wslDistributions().then(
			(names) => {
				if (!cancelled) {
					setDistributions(Array.isArray(names) ? names : []);
				}
			},
			(error) => {
				if (!cancelled) {
					setWslError(String(error));
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, []);
	// List the starting folder whenever the connection changes.
	useEffect(() => {
		const counter = request.current;
		const id = ++counter.id;
		void window.nido
			.browseFolders(location.initialPath, location.distribution || undefined)
			.then(
				(result) => {
					if (id !== counter.id) {
						return;
					}
					applyFolders(result);
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
	useLayoutEffect(() => {
		if (list.current) {
			list.current.scrollTop = 0;
		}
	}, [listing, showFavorites]);
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selected, showFavorites]);
	/** Switch between the folder list and the favorites. */
	function toggleFavorites(): void {
		setShowFavorites((value) => !value);
		setSelected(0);
		list.current?.focus();
	}
	return (
		<div
			className={styles.folderPicker}
			onKeyDown={(event) => {
				if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
					event.preventDefault();
					toggleFavorites();
				}
				if (event.ctrlKey && event.key.toLowerCase() === 'l') {
					event.preventDefault();
					address.current?.focus();
					address.current?.select();
				}
				if (event.ctrlKey && event.key === 'Enter' && !busy && !loading) {
					event.preventDefault();
					if (distribution && !parseWslPath(path) && !path.startsWith('/')) {
						setError(t('Enter an absolute Linux folder path.'));
						return;
					}
					onOpen(
						distribution && !parseWslPath(path) ? wslHostPath(distribution, path) : path
					);
				}
			}}
		>
			<div className={styles.folderActions}>
				<label>
					{t('Connection')}{' '}
					<select
						aria-label={t('Connection')}
						value={distribution}
						disabled={busy}
						onChange={(event) => changeConnection(event.target.value)}
					>
						<option value="">{t('This computer')}</option>
						{[
							...new Set([...(distribution ? [distribution] : []), ...distributions])
						].map((name) => (
							<option key={name} value={name}>
								WSL: {name}
							</option>
						))}
					</select>
				</label>
				{wslError && (
					<small role="status">
						{t('WSL unavailable')} · {errorMessage(wslError)}
					</small>
				)}
				{!wslError && !distributions.length && (
					<small>{t('Install a WSL distribution to connect.')}</small>
				)}
			</div>
			<input
				ref={address}
				className={`${styles.paletteInput} ${styles.folderPath}`}
				aria-label={t('Folder path')}
				value={path}
				disabled={busy}
				onChange={(event) => setPath(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && !event.ctrlKey) {
						event.preventDefault();
						void browse(path);
					}
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						list.current?.focus();
					}
				}}
			/>
			<div className={styles.folderActions}>
				{/* Loading keeps these enabled; toggling their state on every move made them flash. */}
				<button
					disabled={busy || (parent === directory && !atDriveRoot)}
					onClick={browseParent}
				>
					{t('↑ Parent')}
				</button>
				<button
					disabled={busy || !directory}
					onClick={() => {
						if (!loading) {
							onOpen(directory);
						}
					}}
				>
					{busy ? t('Opening…') : t('Open current folder')}
				</button>
				<button aria-pressed={showFavorites} onClick={toggleFavorites}>
					<Star size={13} className={sharedStyles.favoriteStar} /> {t('Favorites')}
				</button>
			</div>
			{distribution && (
				<p className={styles.folderActions} role="status">
					{busy
						? t('Connecting to WSL… Initial setup may take a few minutes.')
						: t('Files, terminal and language tools run in this WSL distribution.')}
				</p>
			)}
			{error && <p role="alert">{errorMessage(error)}</p>}
			<div
				ref={list}
				role="listbox"
				aria-label={t('Folders')}
				tabIndex={0}
				aria-busy={loading || busy}
				aria-activedescendant={
					selected < choiceCount ? `folder-choice-${selected}` : undefined
				}
				className={styles.paletteItems}
				onKeyDown={(event) => {
					if (
						event.ctrlKey ||
						event.altKey ||
						event.metaKey ||
						event.nativeEvent.isComposing ||
						busy ||
						(event.target as HTMLElement).closest('button')
					) {
						return;
					}
					const key = event.key;
					if (
						![
							'j',
							'k',
							'h',
							'l',
							'ArrowDown',
							'ArrowUp',
							'ArrowLeft',
							'ArrowRight',
							'Enter',
							'Backspace'
						].includes(key)
					) {
						return;
					}
					event.preventDefault();
					switch (key) {
						case 'j':
						case 'ArrowDown': {
							setSelected((value) =>
								Math.max(0, Math.min(choiceCount - 1, value + 1))
							);
							break;
						}
						case 'k':
						case 'ArrowUp': {
							setSelected((value) => Math.max(0, value - 1));
							break;
						}
						case 'h':
						case 'ArrowLeft':
						case 'Backspace': {
							if (showFavorites) {
								toggleFavorites();
							} else if (!loading && (parent !== directory || atDriveRoot)) {
								browseParent();
							}
							break;
						}
						default: {
							const favorite = showFavorites ? favorites[selected] : undefined;
							const folder = showFavorites ? undefined : folders[selected];
							if (favorite) {
								onOpenFavorite(favorite);
							} else if (!loading && folder) {
								if (key === 'Enter') {
									onOpen(folder.path);
								} else {
									void browse(folder.path);
								}
							}
							break;
						}
					}
				}}
			>
				{showFavorites ? (
					<>
						<p className={styles.folderSection}>{t('Favorites')}</p>
						{favorites.map((favorite, index) => (
							<div
								key={`${favorite.root}:${favorite.kind}`}
								id={`folder-choice-${index}`}
								role="option"
								aria-label={t('Favorite {name} ({kind})', {
									name: favorite.name,
									kind: t(favorite.kind)
								})}
								aria-selected={index === selected}
								className={`${styles.folderChoice} ${styles.favoriteChoice} ${index === selected ? styles.selectedItem : ''}`}
								onClick={() => {
									if (!busy) {
										onOpenFavorite(favorite);
									}
								}}
								title={favorite.root}
							>
								<Star size={16} className={sharedStyles.favoriteStar} />
								<span>
									<strong>{favorite.name}</strong>
									<small>
										{favorite.root} · {t(favorite.kind)}
									</small>
								</span>
								<button
									aria-label={t('Remove favorite {name} ({kind})', {
										name: favorite.name,
										kind: t(favorite.kind)
									})}
									title={t('Remove favorite')}
									disabled={favoriteBusy || busy}
									onClick={(event) => {
										event.stopPropagation();
										onRemoveFavorite(favorite);
										list.current?.focus();
									}}
								>
									<X size={14} />
								</button>
							</div>
						))}
						{!favorites.length && <p>{t('No favorites yet.')}</p>}
					</>
				) : !folders.length && loading ? (
					// Keep the previous listing on screen while the next one loads; replacing it
					// with a placeholder for a frame made every move flicker.
					<p>{t('Loading folders…')}</p>
				) : (
					<>
						{folders.map((folder, index) => (
							<div
								key={folder.path}
								id={`folder-choice-${index}`}
								role="option"
								aria-selected={index === selected}
								className={`${styles.folderChoice} ${index === selected ? styles.selectedItem : ''}`}
								onClick={() => {
									setSelected(index);
									list.current?.focus();
								}}
								onDoubleClick={() => {
									if (!loading) {
										void browse(folder.path);
									}
								}}
							>
								▸ {folder.name}
							</div>
						))}
						{!loading && !folders.length && (
							<p>{t('No subfolders. Open this folder with Ctrl+Enter.')}</p>
						)}
					</>
				)}
			</div>
			<p className={styles.folderActions}>
				{t(
					'Tab / Shift+Tab Move focus · j/k Select · h/l Browse · Enter Open selected · Ctrl+Enter Open current · Ctrl+L Path · Ctrl+F Favorites · Esc Cancel'
				)}
			</p>
		</div>
	);
}
