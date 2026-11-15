import pickerStyles from './FolderPicker.module.css';
import { useErrorMessage, useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Star, X } from 'lucide-react';
import type { FavoriteWorkspace, FileEntry } from '../../../shared/types';
import styles from '../palette/Palette.module.css';
import { parseWslPath, wslHostPath } from '../../../shared/wsl';
import {
	useFolderBrowser,
	useWslDistributions,
	type FolderBrowser
} from './folderPicker/useFolderBrowser';

interface Props {
	initialPath: string;
	/** Start on the favorites view instead of the folder browser. */
	initialFavorites?: boolean;
	favorites: FavoriteWorkspace[];
	favoriteBusy: boolean;
	onOpenFavorite: (favorite: FavoriteWorkspace) => void;
	onRemoveFavorite: (favorite: FavoriteWorkspace) => void;
	busy: boolean;
	onOpen: (path: string) => void;
}

/** The keys the folder list handles; others reach the rest of the picker. */
const listKeys = [
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
];

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
}: Props): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const list = useRef<HTMLDivElement>(null);
	const address = useRef<HTMLInputElement>(null);
	const [selected, setSelected] = useState(0);
	// Effects run in this order: focus the list, list the WSL distributions, list the folder.
	useEffect(() => {
		list.current?.focus();
	}, []);
	const wsl = useWslDistributions();
	const browser = useFolderBrowser(initialPath, setSelected, () => list.current?.focus());
	const { distribution, path, directory, folders, loading } = browser;
	// Favorites stay out of the way until requested (Ctrl+F or the Favorites button).
	const [showFavorites, setShowFavorites] = useState(initialFavorites);
	const choiceCount = showFavorites ? favorites.length : folders.length;
	// Keep the selection in range when the list gets shorter.
	const [previousChoiceCount, setPreviousChoiceCount] = useState(choiceCount);
	if (choiceCount !== previousChoiceCount) {
		setPreviousChoiceCount(choiceCount);
		setSelected((value) => Math.max(0, Math.min(value, choiceCount - 1)));
	}
	useLayoutEffect(() => {
		if (list.current) {
			list.current.scrollTop = 0;
		}
	}, [browser.listing, showFavorites]);
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selected, showFavorites]);

	/** Switch between the folder list and the favorites. */
	function toggleFavorites(): void {
		setShowFavorites((value) => !value);
		setSelected(0);
		list.current?.focus();
	}

	/** Open the folder in the address field; a WSL connection needs an absolute Linux path. */
	function openTypedPath(): void {
		const hostPath = !!parseWslPath(path);
		if (distribution && !hostPath && !path.startsWith('/')) {
			browser.setError(t('Enter an absolute Linux folder path.'));
			return;
		}
		onOpen(distribution && !hostPath ? wslHostPath(distribution, path) : path);
	}

	function pickerKeyDown(event: React.KeyboardEvent): void {
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
			openTypedPath();
		}
	}

	/** Vim keys and arrows: move the selection, browse in and out, open. */
	function listKeyDown(event: React.KeyboardEvent): void {
		if (
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			event.nativeEvent.isComposing ||
			busy ||
			(event.target as HTMLElement).closest('button') ||
			!listKeys.includes(event.key)
		) {
			return;
		}
		event.preventDefault();
		switch (event.key) {
			case 'j':
			case 'ArrowDown':
				setSelected((value) => Math.max(0, Math.min(choiceCount - 1, value + 1)));
				break;
			case 'k':
			case 'ArrowUp':
				setSelected((value) => Math.max(0, value - 1));
				break;
			case 'h':
			case 'ArrowLeft':
			case 'Backspace':
				if (showFavorites) {
					toggleFavorites();
				} else if (!loading && browser.canBrowseParent) {
					browser.browseParent();
				}
				break;
			default:
				chooseSelected(event.key === 'Enter');
		}
	}

	/** Open the selected favorite, or open (`open`) or browse into the selected folder. */
	function chooseSelected(open: boolean): void {
		const favorite = showFavorites ? favorites[selected] : undefined;
		const folder = showFavorites ? undefined : folders[selected];
		if (favorite) {
			onOpenFavorite(favorite);
		} else if (!loading && folder) {
			if (open) {
				onOpen(folder.path);
			} else {
				void browser.browse(folder.path);
			}
		}
	}

	return (
		<div className={styles.folderPicker} onKeyDown={pickerKeyDown}>
			<ConnectionSelect browser={browser} wsl={wsl} busy={busy} />
			<input
				ref={address}
				className={`${styles.paletteInput} ${styles.folderPath}`}
				aria-label={t('Folder path')}
				value={path}
				disabled={busy}
				onChange={(event) => browser.setPath(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && !event.ctrlKey) {
						event.preventDefault();
						void browser.browse(path);
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
					disabled={busy || (browser.parent === directory && !browser.atDriveRoot)}
					onClick={browser.browseParent}
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
					<Star size={13} className={pickerStyles.favoriteStar} /> {t('Favorites')}
				</button>
			</div>
			{distribution && (
				<p className={styles.folderActions} role="status">
					{busy
						? t('Connecting to WSL… Initial setup may take a few minutes.')
						: t('Files, terminal and language tools run in this WSL distribution.')}
				</p>
			)}
			{browser.error && <p role="alert">{errorMessage(browser.error)}</p>}
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
				onKeyDown={listKeyDown}
			>
				{showFavorites ? (
					<FavoriteChoices
						favorites={favorites}
						selected={selected}
						busy={busy}
						favoriteBusy={favoriteBusy}
						onOpen={onOpenFavorite}
						onRemove={(favorite) => {
							onRemoveFavorite(favorite);
							list.current?.focus();
						}}
					/>
				) : !folders.length && loading ? (
					// Keep the previous listing on screen while the next one loads; replacing it
					// with a placeholder for a frame made every move flicker.
					<p>{t('Loading folders…')}</p>
				) : (
					<FolderChoices
						folders={folders}
						selected={selected}
						loading={loading}
						onSelect={(index) => {
							setSelected(index);
							list.current?.focus();
						}}
						onBrowse={(folder) => void browser.browse(folder.path)}
					/>
				)}
			</div>
			<KeyHints />
		</div>
	);
}

/** The connection list (this computer or a WSL distribution) and WSL's availability. */
function ConnectionSelect({
	browser,
	wsl,
	busy
}: {
	browser: FolderBrowser;
	wsl: ReturnType<typeof useWslDistributions>;
	busy: boolean;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const { distribution } = browser;
	return (
		<div className={styles.folderActions}>
			<label>
				{t('Connection')}{' '}
				<select
					aria-label={t('Connection')}
					value={distribution}
					disabled={busy}
					onChange={(event) => browser.changeConnection(event.target.value)}
				>
					<option value="">{t('This computer')}</option>
					{[
						...new Set([...(distribution ? [distribution] : []), ...wsl.distributions])
					].map((name) => (
						<option key={name} value={name}>
							WSL: {name}
						</option>
					))}
				</select>
			</label>
			{wsl.error && (
				<small role="status">
					{t('WSL unavailable')} · {errorMessage(wsl.error)}
				</small>
			)}
			{!wsl.error && !wsl.distributions.length && (
				<small>{t('Install a WSL distribution to connect.')}</small>
			)}
		</div>
	);
}

/** The favorites as list options, each with a button to remove it. */
function FavoriteChoices({
	favorites,
	selected,
	busy,
	favoriteBusy,
	onOpen,
	onRemove
}: {
	favorites: FavoriteWorkspace[];
	selected: number;
	busy: boolean;
	favoriteBusy: boolean;
	onOpen: (favorite: FavoriteWorkspace) => void;
	onRemove: (favorite: FavoriteWorkspace) => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<>
			<p className={styles.folderSection}>{t('Favorites')}</p>
			{favorites.map((favorite, index) => {
				const names = { name: favorite.name, kind: t(favorite.kind) };
				return (
					<div
						key={`${favorite.root}:${favorite.kind}`}
						id={`folder-choice-${index}`}
						role="option"
						aria-label={t('Favorite {name} ({kind})', names)}
						aria-selected={index === selected}
						className={`${styles.folderChoice} ${styles.favoriteChoice} ${index === selected ? styles.selectedItem : ''}`}
						onClick={() => {
							if (!busy) {
								onOpen(favorite);
							}
						}}
						title={favorite.root}
					>
						<Star size={16} className={pickerStyles.favoriteStar} />
						<span>
							<strong>{favorite.name}</strong>
							<small>
								{favorite.root} · {t(favorite.kind)}
							</small>
						</span>
						<button
							aria-label={t('Remove favorite {name} ({kind})', names)}
							title={t('Remove favorite')}
							disabled={favoriteBusy || busy}
							onClick={(event) => {
								event.stopPropagation();
								onRemove(favorite);
							}}
						>
							<X size={14} />
						</button>
					</div>
				);
			})}
			{!favorites.length && <p>{t('No favorites yet.')}</p>}
		</>
	);
}

/** The subfolders as list options: click selects, double-click browses into one. */
function FolderChoices({
	folders,
	selected,
	loading,
	onSelect,
	onBrowse
}: {
	folders: FileEntry[];
	selected: number;
	loading: boolean;
	onSelect: (index: number) => void;
	onBrowse: (folder: FileEntry) => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<>
			{folders.map((folder, index) => (
				<div
					key={folder.path}
					id={`folder-choice-${index}`}
					role="option"
					aria-selected={index === selected}
					className={`${styles.folderChoice} ${index === selected ? styles.selectedItem : ''}`}
					onClick={() => onSelect(index)}
					onDoubleClick={() => {
						if (!loading) {
							onBrowse(folder);
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
	);
}

/** The picker's keys; each key and what it does wraps as a unit, rather than mid-hint. */
function KeyHints(): React.JSX.Element {
	const t = useI18n();
	return (
		<p className={`${styles.folderActions} ${styles.folderKeys}`}>
			{t(
				'Tab / Shift+Tab Move focus · j/k Select · h/l Browse · Enter Open selected · Ctrl+Enter Open current · Ctrl+L Path · Ctrl+F Favorites · Esc Cancel'
			)
				.split(' · ')
				.map((hint) => (
					<span key={hint}>{hint}</span>
				))}
		</p>
	);
}
