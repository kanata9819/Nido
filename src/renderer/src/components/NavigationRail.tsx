import { Files, GitBranch, Keyboard, Search, Settings2, Square } from 'lucide-react';
import type { Panel } from '../types';
import styles from '../assets/Nido.module.css';

export default function NavigationRail({
    sidebar,
    active,
    showExplorer,
    showPanel
}: {
    sidebar: boolean;
    active: string;
    showExplorer: () => void;
    showPanel: (panel: Panel) => void;
}): React.JSX.Element {
    return (
        <nav className={styles.rail} aria-label="Navigation">
            <button
                className={sidebar ? styles.railActive : ''}
                aria-label="Explorer"
                title="Explorer (Space e)"
                onClick={showExplorer}
            >
                <Files size={22} />
            </button>
            <button
                aria-label="Find file"
                title="Find file (Space f)"
                disabled={!active}
                onClick={() => showPanel('files')}
            >
                <Search size={22} />
            </button>
            <button
                aria-label="Workspaces"
                title="Workspaces (Space w)"
                onClick={() => showPanel('workspaces')}
            >
                <Square size={20} />
            </button>
            <button
                aria-label="Source control"
                title="Source control (Ctrl+Shift+G / Space g)"
                disabled={!active}
                onClick={() => showPanel('git')}
            >
                <GitBranch size={21} />
            </button>
            <div className={styles.railGap} />
            <button
                aria-label="Command palette"
                title="Commands (Ctrl+Shift+P)"
                onClick={() => showPanel('commands')}
            >
                <Keyboard size={21} />
            </button>
            <button
                aria-label="Settings"
                title="Settings (Space ,)"
                onClick={() => showPanel('settings')}
            >
                <Settings2 size={21} />
            </button>
        </nav>
    );
}
