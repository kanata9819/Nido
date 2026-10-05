import { useI18n } from '../i18n';
import { Blocks, Files, GitBranch, Keyboard, Search, Settings2, Square } from 'lucide-react';
import type { Panel } from '../types';
import styles from '../assets/Nido.module.css';

export default function NavigationRail({
    sidebar,
    active,
    panel,
    showExplorer,
    showPanel
}: {
    sidebar: boolean;
    active: string;
    panel: Panel;
    showExplorer: () => void;
    showPanel: (panel: Panel) => void;
}): React.JSX.Element {
    const t = useI18n();
    return (
        <nav className={styles.rail} aria-label={t('Navigation')}>
            <button
                className={sidebar && panel !== 'features' ? styles.railActive : ''}
                aria-label={t('Explorer')}
                title={t('Explorer (Space e)')}
                onClick={showExplorer}
            >
                <Files size={22} />
            </button>
            <button
                aria-label={t('Find file')}
                title={t('Find file (Space f)')}
                disabled={!active}
                onClick={() => showPanel('files')}
            >
                <Search size={22} />
            </button>
            <button
                aria-label={t('Workspaces')}
                title={t('Workspaces (Space w)')}
                onClick={() => showPanel('workspaces')}
            >
                <Square size={20} />
            </button>
            <button
                aria-label={t('Source control')}
                title={t('Source control (Ctrl+Shift+G / Space g)')}
                disabled={!active}
                onClick={() => showPanel('git')}
            >
                <GitBranch size={21} />
            </button>
            <button
                className={panel === 'features' ? styles.railActive : ''}
                aria-label={t('Features')}
                aria-pressed={panel === 'features'}
                title={t('Features (Ctrl+Shift+X)')}
                data-features-trigger
                onClick={() => showPanel('features')}
            >
                <Blocks size={22} />
            </button>
            <div className={styles.railGap} />
            <button
                aria-label={t('Command palette')}
                title={t('Commands (Ctrl+Shift+P)')}
                onClick={() => showPanel('commands')}
            >
                <Keyboard size={21} />
            </button>
            <button
                aria-label={t('Settings')}
                title={t('Settings (Space ,)')}
                onClick={() => showPanel('settings')}
            >
                <Settings2 size={21} />
            </button>
        </nav>
    );
}
