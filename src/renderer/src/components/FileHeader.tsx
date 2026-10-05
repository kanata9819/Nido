import { useI18n } from '../i18n';
import { useLayoutEffect, useRef } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { Workspace, SessionState } from '../../../shared/types';
import { gitFileKey, type Decoration } from '../fileDecorations';
import { filename } from '../commands';
import FileIcon from './FileIcon';
import DiagnosticBadges from './DiagnosticBadges';
import styles from '../assets/Nido.module.css';

interface FileHeaderProps {
    workspace: Workspace;
    state: SessionState;
    decorations: Record<string, Decoration>;
    focusEditor: () => void;
    restartShell: (id: string) => void;
    run: (promise: Promise<unknown>) => void;
}

export default function FileHeader({
    workspace,
    state,
    decorations,
    focusEditor,
    restartShell,
    run
}: FileHeaderProps): React.JSX.Element {
    const t = useI18n();
    const active = workspace.id;
    const current = state.buffers.find((buffer) => buffer.id === state.current);
    const selectedTab = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        selectedTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [active, current?.id]);
    return (
        <>
            {' '}
            <div
                className={styles.fileTabs}
                role="tablist"
                aria-label={t('Files')}
                hidden={workspace.kind === 'terminal'}
            >
                {state.buffers.map((buffer) => {
                    const decoration = decorations[gitFileKey(buffer.name)];
                    return (
                        <div
                            key={buffer.id}
                            ref={state.current === buffer.id ? selectedTab : undefined}
                            className={`${styles.fileTab} ${state.current === buffer.id ? styles.activeFile : ''}`}
                        >
                            <button
                                role="tab"
                                aria-selected={state.current === buffer.id}
                                title={buffer.name}
                                onClick={() => {
                                    run(window.nido.selectBuffer(active, buffer.id));
                                    focusEditor();
                                }}
                            >
                                <FileIcon path={buffer.name} />
                                <span
                                    className={styles.gitName}
                                    data-status={decoration?.code || undefined}
                                    data-diagnostic={decoration?.diagnostic}
                                >
                                    {buffer.name ? filename(buffer.name) : t('[Untitled]')}
                                </span>
                                <DiagnosticBadges decoration={decoration} />
                                {decoration?.code && (
                                    <span
                                        className={styles.gitBadge}
                                        data-status={decoration.code}
                                        title={t(decoration.title)}
                                        aria-label={t(decoration.title)}
                                    >
                                        {decoration.code}
                                    </span>
                                )}
                                {buffer.modified && (
                                    <span className={styles.unsaved} aria-label={t('Unsaved')} />
                                )}
                            </button>
                            <button
                                className={styles.tabClose}
                                aria-label={t('Close file {name}', { name: buffer.name ? filename(buffer.name) : t('[Untitled]') })}
                                onClick={() => run(window.nido.closeBuffer(active, buffer.id))}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className={styles.breadcrumb}>
                <span>{workspace.name}</span>
                <ChevronRight size={13} />
                <span>
                    {workspace.kind === 'terminal'
                        ? workspace.root
                        : current?.name
                          ? current.name
                                .replace(workspace.root, '')
                                .replace(/^[\\/]/, '')
                                .replaceAll('\\', ' / ')
                          : t('Untitled')}
                </span>
                {workspace.kind === 'terminal' ? (
                    <button
                        className={styles.restartShell}
                        title={t('Restart shell (Ctrl+Shift+R)')}
                        onClick={() => restartShell(active)}
                    >
                        {t('Restart shell')} <kbd>Ctrl Shift R</kbd>
                    </button>
                ) : (
                    <span className={styles.breadcrumbHint}>{t('SPACE for commands')}</span>
                )}
            </div>
        </>
    );
}
