import { useI18n } from '../i18n';
import SettingsPanel, { type SettingsPanelProps } from './SettingsPanel';
import type { Panel, Item } from '../types';
import { Command, X } from 'lucide-react';
import PaletteItems, { type PaletteConfirmation } from './PaletteItems';
import WorkspaceSearch from './WorkspaceSearch';
import styles from '../assets/Palette.module.css';
import FolderPicker from './FolderPicker';
import GitBrowser from './GitBrowser';
import TimeMachine from './TimeMachine';
import type { DocumentSymbolList, FavoriteWorkspace } from '../../../shared/types';
import SymbolPalette from './SymbolPalette';
import OverlayPresence from './OverlayPresence';
import { useState } from 'react';

// The modal panel over the editor that hosts the palettes, Git, Time Machine, search and settings.
interface PanelProps {
	settings: SettingsPanelProps;
	workspaceId: string;
	buffer: number;
	symbols?: DocumentSymbolList;
	initialFolder: string;
	folderKind: 'editor' | 'terminal';
	folderFavorites: boolean;
	favorites: FavoriteWorkspace[];
	favoriteBusy: boolean;
	openFavorite: (favorite: FavoriteWorkspace) => Promise<void>;
	removeFavorite: (favorite: FavoriteWorkspace) => void;
	creating: boolean;
	openWorkspace: (path: string, kind: 'editor' | 'terminal') => Promise<void>;
	panel: Panel;
	filtered: Item[];
	selection: number;
	query: string;
	loading: boolean;
	modal: React.RefObject<HTMLDivElement | null>;
	focusEditor: () => void;
	setQuery: (value: string) => void;
	setSelection: React.Dispatch<React.SetStateAction<number>>;
	/** A pending action in the workspace list that Enter confirms. */
	confirmation?: PaletteConfirmation;
}

/** The heading of each panel. */
const panelTitles = {
	history: 'Time Machine',
	markdown: 'Markdown preview',
	problems: 'Problems',
	git: 'Source control',
	folders: 'Open a workspace',
	files: 'Find a file',
	symbols: 'File symbols',
	search: 'Search in files',
	workspaces: 'Your workspaces',
	buffers: 'Open files',
	settings: 'Settings',
	commands: 'All commands'
};

/** Shows the open panel in a modal dialog; clicking outside it returns to the editor. */
export function Panel({
	settings,
	workspaceId,
	buffer,
	symbols,
	initialFolder,
	folderKind,
	folderFavorites,
	favorites,
	favoriteBusy,
	openFavorite,
	removeFavorite,
	creating,
	openWorkspace,
	panel,
	filtered,
	selection,
	query,
	loading,
	modal,
	focusEditor,
	setQuery,
	setSelection,
	confirmation
}: PanelProps): React.JSX.Element | null {
	const t = useI18n();
	// Each opening gets a new key, so a panel that is still fading out is not reused.
	const [opening, setOpening] = useState({ panel, generation: 0 });
	if (opening.panel !== panel) {
		// A fading panel is a visual snapshot, not the next opening's live state.
		setOpening({ panel, generation: opening.generation + Number(!!panel) });
	}
	if (!panel || panel === 'extensions' || panel === 'markdown') {
		return <OverlayPresence>{null}</OverlayPresence>;
	}

	// The panels with their own component; the rest are palettes listing `filtered` items.
	let content: React.JSX.Element;
	switch (panel) {
		case 'symbols':
			content = (
				<SymbolPalette
					key={`${workspaceId}:${buffer}`}
					workspaceId={workspaceId}
					buffer={buffer}
					symbols={symbols}
					focusEditor={focusEditor}
				/>
			);
			break;
		case 'search':
			content = (
				<WorkspaceSearch
					key={workspaceId}
					workspaceId={workspaceId}
					onClose={focusEditor}
				/>
			);
			break;
		case 'history':
			content = (
				<TimeMachine key={workspaceId} workspaceId={workspaceId} onClose={focusEditor} />
			);
			break;
		case 'git':
			content = (
				<GitBrowser key={workspaceId} workspaceId={workspaceId} onClose={focusEditor} />
			);
			break;
		case 'folders':
			content = (
				<FolderPicker
					initialPath={initialFolder}
					initialFavorites={folderFavorites}
					favorites={favorites.filter((favorite) => favorite.kind === folderKind)}
					favoriteBusy={favoriteBusy}
					onOpenFavorite={(favorite) => void openFavorite(favorite)}
					onRemoveFavorite={removeFavorite}
					busy={creating}
					onOpen={(path) => void openWorkspace(path, folderKind)}
				/>
			);
			break;
		case 'settings':
			content = <SettingsPanel {...settings} />;
			break;
		default:
			content = (
				<PaletteItems
					panel={panel}
					filtered={filtered}
					selection={selection}
					query={query}
					loading={loading}
					setQuery={setQuery}
					setSelection={setSelection}
					confirmation={panel === 'workspaces' ? confirmation : undefined}
				/>
			);
	}

	return (
		<OverlayPresence>
			<div
				key={opening.generation}
				className={`${styles.scrim} ${['git', 'history'].includes(panel) ? styles.gitScrim : ''} ${panel === 'search' ? styles.searchScrim : ''}`}
				onMouseDown={(event) => {
					if (event.target === event.currentTarget) {
						focusEditor();
					}
				}}
			>
				<div
					className={`${styles.palette} ${['git', 'history'].includes(panel) ? styles.gitPalette : ''} ${panel === 'search' ? styles.searchPalette : ''}`}
					role="dialog"
					aria-modal="true"
					aria-label={panel === 'settings' ? t('Settings') : t(`${panel} palette`)}
					data-panel={panel}
					ref={modal}
				>
					<div className={styles.paletteHeading}>
						<Command size={17} />
						<span>
							{t(
								panel === 'folders' && folderKind === 'terminal'
									? 'New terminal session'
									: panelTitles[panel]
							)}
						</span>
						<button aria-label={t('Close palette')} onClick={focusEditor}>
							<X size={17} />
						</button>
					</div>
					{content}
				</div>
			</div>
		</OverlayPresence>
	);
}
