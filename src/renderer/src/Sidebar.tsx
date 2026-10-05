import { useI18n } from './i18n';
import { memo, useRef, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Command } from 'lucide-react';
import ExplorerCommands from './components/ExplorerCommands';
import FileIcon from './components/FileIcon';
import DiagnosticBadges from './components/DiagnosticBadges';
import type { Workspace } from '../../shared/types';
import { useExplorer } from './hooks/useExplorer';
import { toggle } from './sidebarToggle';
import { createExplorerKeyHandler } from './sidebarKeyboard';
import styles from './assets/Nido.module.css';
import { gitFileKey, type Decoration } from './hooks/useGitFileStatus';

interface Props {
    gitFiles: Record<string, Decoration>;
    width: number;
    onResize: (width: number) => void;
    workspace: Workspace;
    active: boolean;
    currentFile: string;
    onOpen: (path: string) => void;
    onError: (message: string) => void;
}

// Hidden trees keep their DOM and local state; refresh parent props when activated.
export default memo(
    Sidebar,
    (previous, next) => !previous.active && !next.active && previous.workspace === next.workspace
);

function Sidebar({
    gitFiles,
    workspace,
    active,
    currentFile,
    onOpen,
    onError,
    width,
    onResize
}: Props): React.JSX.Element {
    const t = useI18n();
    const drag = useRef<{ x: number; width: number } | null>(null);
    const centerPrefix = useRef(false);
    const {
        visible,
        expanded,
        selected,
        setSelected,
        setExpanded,
        load,
        tree,
        operation,
        setOperation,
        clipboard,
        commands,
        closeOperation,
        onDone
    } = useExplorer({ workspace, active, onError });
    const rootDecoration = gitFiles[gitFileKey(workspace.root).replace(/\/$/, '')];

    return (
        <aside
            className={styles.sidebar}
            aria-label={t('File explorer')}
            hidden={!active}
            style={{ width }}
            onKeyDownCapture={(event) => {
                if (
                    (event.target as Element).closest('[data-explorer-commands]') ||
                    event.nativeEvent.isComposing ||
                    event.ctrlKey ||
                    event.altKey ||
                    event.metaKey
                ) {
                    return;
                }
                if (event.shiftKey && ['H', 'L'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    onResize(width + (event.key === 'H' ? -20 : 20));
                }
            }}
        >
            <div
                className={styles.sidebarResize}
                role="separator"
                aria-label={t('Explorer width')}
                aria-orientation="vertical"
                aria-valuemin={160}
                aria-valuemax={480}
                aria-valuenow={width}
                tabIndex={0}
                title={t('Drag to resize · Shift+H / L')}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        onResize(width + (event.key === 'ArrowLeft' ? -20 : 20));
                    }
                }}
                onPointerDown={(event) => {
                    if (event.button !== 0) {
                        return;
                    }
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { x: event.clientX, width };
                }}
                onPointerMove={(event) => {
                    if (drag.current) {
                        onResize(drag.current.width + event.clientX - drag.current.x);
                    }
                }}
                onPointerUp={(event) => {
                    drag.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                }}
                onLostPointerCapture={() => {
                    drag.current = null;
                }}
                onPointerCancel={() => {
                    drag.current = null;
                }}
            />
            <div className={styles.sidebarHeading}>
                <span
                    className={styles.gitName}
                    data-status={rootDecoration?.code || undefined}
                    data-diagnostic={rootDecoration?.diagnostic}
                >
                    {workspace.name}
                </span>
                <button
                    title={t('Explorer commands (:)')}
                    aria-label={t('Explorer commands')}
                    onClick={() => setOperation({})}
                >
                    <Command size={14} />
                </button>
                <button
                    title={t('Refresh files')}
                    aria-label={t('Refresh files')}
                    onClick={() => void load('')}
                >
                    <RefreshCw size={14} />
                </button>
            </div>
            <div
                ref={tree}
                className={styles.tree}
                role="tree"
                tabIndex={0}
                aria-label={t('Project files')}
                title={t(
                    'j/k Select · zz Center selection · : Commands · a/A New file/folder · F2 Rename · Ctrl+C/X/V Copy/Cut/Paste · Delete'
                )}
                aria-activedescendant={selected ? `file-${workspace.id}-${selected}` : undefined}
                onBlur={() => {
                    centerPrefix.current = false;
                }}
                onKeyDown={(event) => {
                    const pending = centerPrefix.current;
                    centerPrefix.current = false;
                    if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
                        return;
                    }
                    if (event.key === 'z' && !event.ctrlKey && !event.shiftKey && !event.repeat) {
                        event.preventDefault();
                        event.stopPropagation();
                        centerPrefix.current = !pending;
                        if (pending) {
                            const row = document.getElementById(`file-${workspace.id}-${selected}`);
                            if (row) {
                                const viewport = event.currentTarget;
                                const bounds = viewport.getBoundingClientRect();
                                const target = row.getBoundingClientRect();
                                viewport.scrollTop +=
                                    target.top +
                                    target.height / 2 -
                                    bounds.top -
                                    viewport.clientHeight / 2;
                            }
                        }
                        return;
                    }
                    if (
                        event.key === ':' ||
                        event.key === 'ContextMenu' ||
                        (event.shiftKey && event.key === 'F10')
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        setOperation({});
                        return;
                    }
                    const key = event.ctrlKey
                        ? ({ c: 'c', x: 'x', v: 'p' } as Record<string, string>)[
                              event.key.toLowerCase()
                          ]
                        : event.key === 'F2'
                          ? 'r'
                          : event.key === 'Delete'
                            ? 'd'
                            : event.key;
                    const command = commands.find((command) => command.key === key);
                    if (command) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!command.disabled) {
                            command.run();
                        }
                        return;
                    }
                    createExplorerKeyHandler({
                        visible,
                        selected,
                        expanded,
                        setSelected,
                        setExpanded,
                        load,
                        onOpen,
                        workspaceId: workspace.id
                    })(event);
                }}
            >
                {visible.map((entry) => {
                    const decoration = gitFiles[gitFileKey(`${workspace.root}/${entry.path}`)];
                    return (
                        <div
                            key={entry.path}
                            id={`file-${workspace.id}-${entry.path}`}
                            role="treeitem"
                            aria-level={entry.depth + 1}
                            aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
                            aria-selected={selected === entry.path}
                            data-ignored={entry.ignored || undefined}
                            className={`${styles.treeItem} ${selected === entry.path ? styles.treeSelected : ''} ${currentFile.endsWith(entry.path) ? styles.currentFile : ''}`}
                            style={{ '--tree-depth': entry.depth } as CSSProperties}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setSelected(entry.path);
                                setOperation({});
                            }}
                            onClick={() =>
                                toggle({ entry, expanded, setExpanded, setSelected, onOpen, load })
                            }
                        >
                            {entry.directory ? (
                                expanded.has(entry.path) ? (
                                    <ChevronDown size={13} />
                                ) : (
                                    <ChevronRight size={13} />
                                )
                            ) : (
                                <span className={styles.treeSpacer} />
                            )}
                            {entry.directory ? (
                                expanded.has(entry.path) ? (
                                    <FolderOpen size={15} />
                                ) : (
                                    <Folder size={15} />
                                )
                            ) : (
                                <FileIcon path={entry.path} className={styles.fileIcon} />
                            )}
                            <span
                                className={`${styles.treeName} ${styles.gitName}`}
                                data-status={decoration?.code || undefined}
                                data-diagnostic={decoration?.diagnostic}
                            >
                                {entry.name}
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
                        </div>
                    );
                })}
                {!visible.length && (
                    <p className={styles.emptyTree}>
                        {t('No files yet.')}
                        <br />
                        {t('Press')} <kbd>a</kbd> {t('for a file or')} <kbd>A</kbd>{' '}
                        {t('for a folder.')}
                    </p>
                )}
            </div>
            <div className={styles.sidebarFooter}>
                <span className={styles.liveDot} />{' '}
                {clipboard
                    ? `${clipboard.cut ? t('Cut') : t('Copied')}: ${clipboard.name}`
                    : t('File commands')}{' '}
                <kbd>:</kbd>
            </div>
            {operation && (
                <ExplorerCommands
                    workspaceId={workspace.id}
                    request={operation.request}
                    commands={commands}
                    onClose={closeOperation}
                    onDone={onDone}
                />
            )}
        </aside>
    );
}
