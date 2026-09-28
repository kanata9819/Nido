import SettingsPanel, { type SettingsPanelProps } from './SettingsPanel';
import type { Panel, Item } from '../types';
import { Command, X } from 'lucide-react';
import PaletteItems from './PaletteItems';
import styles from '../assets/Nido.module.css';
import FolderPicker from './FolderPicker';
import GitBrowser from './GitBrowser';

interface PanelProps {
    settings: SettingsPanelProps;
    workspaceId: string;
    initialFolder: string;
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
    if (!panel) {
        return null;
    }

    let content: React.JSX.Element;
    switch (panel) {
        case 'git':
            content = (
                <GitBrowser key={workspaceId} workspaceId={workspaceId} onClose={focusEditor} />
            );
            break;
        case 'folders':
            content = (
                <FolderPicker
                    initialPath={initialFolder}
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
        <div
            className={`${styles.scrim} ${panel === 'git' ? styles.gitScrim : ''}`}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    focusEditor();
                }
            }}
        >
            <div
                className={`${styles.palette} ${panel === 'git' ? styles.gitPalette : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={panel === 'settings' ? 'Settings' : `${panel} palette`}
                ref={modal}
            >
                <div className={styles.paletteHeading}>
                    <Command size={17} />
                    <span>{panelTitles[panel]}</span>
                    <button aria-label="Close palette" onClick={focusEditor}>
                        <X size={17} />
                    </button>
                </div>
                {content}
            </div>
        </div>
    );
}
