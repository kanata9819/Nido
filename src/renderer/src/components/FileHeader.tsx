import { ChevronRight, X } from 'lucide-react';
import type { Workspace, SessionState } from '../../../shared/types';
import { gitFileKey, type Decoration } from '../fileDecorations';
import { filename } from '../commands';
import FileIcon from './FileIcon';
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
    const active = workspace.id;
    const current = state.buffers.find((buffer) => buffer.id === state.current);
    return (
        <>
            {' '}
            <div
                className={styles.fileTabs}
                role="tablist"
                aria-label="Files"
                hidden={workspace.kind === 'terminal'}
            >
                {state.buffers.map((buffer) => {
                    const decoration = decorations[gitFileKey(buffer.name)];
                    return (
                        <div
                            key={buffer.id}
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
                                    {filename(buffer.name)}
                                </span>
                                {decoration?.diagnostic && (
                                    <span
                                        className={styles.gitBadge}
                                        data-diagnostic={decoration.diagnostic}
                                        title={`Diagnostics: ${decoration.diagnostic}`}
                                        aria-label={`Diagnostics: ${decoration.diagnostic}`}
                                    >
                                        !
                                    </span>
                                )}
                                {decoration?.code && (
                                    <span
                                        className={styles.gitBadge}
                                        data-status={decoration.code}
                                        title={decoration.title}
                                        aria-label={decoration.title}
                                    >
                                        {decoration.code}
                                    </span>
                                )}
                                {buffer.modified && (
                                    <span className={styles.unsaved} aria-label="Unsaved" />
                                )}
                            </button>
                            <button
                                className={styles.tabClose}
                                aria-label={`Close file ${filename(buffer.name)}`}
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
                          : 'Untitled'}
                </span>
                {workspace.kind === 'terminal' ? (
                    <button
                        className={styles.restartShell}
                        title="Restart shell (Ctrl+Shift+R)"
                        onClick={() => restartShell(active)}
                    >
                        Restart shell <kbd>Ctrl Shift R</kbd>
                    </button>
                ) : (
                    <span className={styles.breadcrumbHint}>SPACE for commands</span>
                )}
            </div>
        </>
    );
}
