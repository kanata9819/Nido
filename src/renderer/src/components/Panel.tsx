import { useI18n } from '../i18n';
import SettingsPanel, { type SettingsPanelProps } from './SettingsPanel';
import type { Panel, Item } from '../types';
import { Command, X } from 'lucide-react';
import PaletteItems from './PaletteItems';
import styles from '../assets/Palette.module.css';
import FolderPicker from './FolderPicker';
import GitBrowser from './GitBrowser';
import TimeMachine from './TimeMachine';
import type { FavoriteWorkspace } from '../../../shared/types';
import OverlayPresence from './OverlayPresence';
import { useState } from 'react';

interface PanelProps {
    settings: SettingsPanelProps;
    workspaceId: string;
    initialFolder: string;
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
}

const panelTitles = {
    history: 'Time Machine',
    markdown: 'Markdown preview',
    problems: 'Problems',
    git: 'Source control',
    folders: 'Open a workspace',
    files: 'Find a file',
    workspaces: 'Your workspaces',
    buffers: 'Open files',
    settings: 'Settings',
    commands: 'All commands'
};

export function Panel({
    settings,
    workspaceId,
    initialFolder,
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
    setSelection
}: PanelProps): React.JSX.Element | null {
    const t = useI18n();
    const [opening, setOpening] = useState({ panel, generation: 0 });
    if (opening.panel !== panel) {
        // A fading panel is a visual snapshot, not the next opening's live state.
        setOpening({ panel, generation: opening.generation + Number(!!panel) });
    }
    if (!panel || panel === 'features' || panel === 'markdown') {
        return <OverlayPresence>{null}</OverlayPresence>;
    }

    let content: React.JSX.Element;
    switch (panel) {
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
                    favorites={favorites}
                    favoriteBusy={favoriteBusy}
                    onOpenFavorite={(favorite) => void openFavorite(favorite)}
                    onRemoveFavorite={removeFavorite}
                    busy={creating}
                    onOpen={(path, kind) => void openWorkspace(path, kind)}
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
                />
            );
    }

    return (
        <OverlayPresence>
            <div
                key={opening.generation}
                className={`${styles.scrim} ${['git', 'history'].includes(panel) ? styles.gitScrim : ''}`}
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                        focusEditor();
                    }
                }}
            >
                <div
                    className={`${styles.palette} ${['git', 'history'].includes(panel) ? styles.gitPalette : ''}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label={panel === 'settings' ? t('Settings') : t(`${panel} palette`)}
                    data-panel={panel}
                    ref={modal}
                >
                    <div className={styles.paletteHeading}>
                        <Command size={17} />
                        <span>{t(panelTitles[panel])}</span>
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
