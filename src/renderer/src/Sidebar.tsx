import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Command } from 'lucide-react';
import ExplorerCommands, { type FileRequest } from './components/ExplorerCommands';
import FileIcon from './components/FileIcon';
import DiagnosticBadges from './components/DiagnosticBadges';
import type { FileEntry, Workspace } from '../../shared/types';
import { getVisibleEntries } from './sidebarTree';
import { toggle } from './sidebarToggle';
import { createOnKeyDown } from './sidebarKeyboard';
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

export default function Sidebar({
    gitFiles,
    workspace,
    active,
    currentFile,
    onOpen,
    onError,
    width,
    onResize
}: Props): React.JSX.Element {
    const drag = useRef<{ x: number; width: number } | null>(null);
    const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState('');
    const [revision, setRevision] = useState(0);
    const tree = useRef<HTMLDivElement>(null);
    const centerPrefix = useRef(false);
    const [operation, setOperation] = useState<{ request?: FileRequest }>();
    const [clipboard, setClipboard] = useState<{ path: string; name: string; cut: boolean }>();
    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.type === 'filesChanged' && event.id === workspace.id) {
                    setRevision((value) => value + 1);
                }
            }),
        [workspace.id]
    );
    const load = async (path: string): Promise<void> => {
        try {
            const files = await window.nido.files(workspace.id, path);
            setEntries((old) => ({ ...old, [path]: files }));
        } catch (e) {
            onError(String(e));
        }
    };

    useEffect(() => {
        let cancelled = false;
        Promise.all(
            ['', ...expanded].map(async (path) => {
                try {
                    return [path, await window.nido.files(workspace.id, path)] as const;
                } catch (error) {
                    if (!path || !String(error).includes('ENOENT')) throw error;
                    return [path, []] as const;
                }
            })
        )
            .then((files) => {
                if (!cancelled) {
                    setEntries(Object.fromEntries(files));
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    onError(String(e));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workspace.id, onError, revision]);

    const visible = getVisibleEntries(entries, expanded);
    const rootDecoration = gitFiles[gitFileKey(workspace.root).replace(/\/$/, '')];
    const item = visible.find((entry) => entry.path === selected);
    const parent = item
        ? item.directory
            ? item.path
            : item.path.replace(/[\\/]?[^\\/]+$/, '')
        : '';
    const child = (name: string): string => (parent ? `${parent}/${name}` : name);
    const treePath = (path: string): string =>
        path.replace(/[\\/]/g, workspace.root.includes('\\') ? '\\' : '/');
    const closeOperation = (): void => {
        setOperation(undefined);
        requestAnimationFrame(() => tree.current?.focus());
    };
    const request = (
        action: FileRequest['action'],
        title: string,
        value: string,
        path = item?.path || ''
    ): void => setOperation({ request: { action, title, value, path } });
    const copy = (cut: boolean): void => {
        if (!item) return;
        setClipboard({ path: item.path, name: item.name, cut });
        closeOperation();
    };
    const paste = (): void => {
        if (!clipboard) return;
        const destination = child(clipboard.name);
        const value =
            destination.replace(/\\/g, '/') === clipboard.path.replace(/\\/g, '/')
                ? child(clipboard.name.replace(/(\.[^.]*)?$/, ' copy$1'))
                : destination;
        request(
            clipboard.cut ? 'rename' : 'copy',
            clipboard.cut ? 'Move here' : 'Paste copy',
            value,
            clipboard.path
        );
    };
    const commands = [
        { title: 'New file', key: 'a', run: () => request('createFile', 'New file', child('')) },
        {
            title: 'New folder',
            key: 'A',
            run: () => request('createDirectory', 'New folder', child(''))
        },
        {
            title: 'Rename',
            key: 'r',
            disabled: !item,
            run: () => request('rename', 'Rename', item!.name)
        },
        {
            title: 'Move to…',
            key: 'm',
            disabled: !item,
            run: () => request('rename', 'Move to…', item!.path)
        },
        { title: 'Copy', key: 'c', disabled: !item, run: () => copy(false) },
        { title: 'Cut', key: 'x', disabled: !item, run: () => copy(true) },
        { title: 'Paste', key: 'p', disabled: !clipboard, run: paste },
        {
            title: 'Delete',
            key: 'd',
            disabled: !item,
            run: () => request('delete', 'Delete', '', item!.path)
        }
    ];

    return (
        <aside
            className={styles.sidebar}
            aria-label="File explorer"
            hidden={!active}
            style={{ width }}
            onKeyDownCapture={(event) => {
                if (
                    (event.target as Element).closest('[data-explorer-commands]') ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229 ||
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
                aria-label="Explorer width"
                aria-orientation="vertical"
                aria-valuemin={160}
                aria-valuemax={480}
                aria-valuenow={width}
                tabIndex={0}
                title="Drag to resize · Shift+H / L"
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
                    title="Explorer commands (:)"
                    aria-label="Explorer commands"
                    onClick={() => setOperation({})}
                >
                    <Command size={14} />
                </button>
                <button
                    title="Refresh files"
                    aria-label="Refresh files"
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
                aria-label="Project files"
                title="j/k Select · zz Center selection · : Commands · a/A New file/folder · F2 Rename · Ctrl+C/X/V Copy/Cut/Paste · Delete"
                aria-activedescendant={selected ? `file-${workspace.id}-${selected}` : undefined}
                onBlur={() => { centerPrefix.current = false; }}
                onKeyDown={(event) => {
                    const pending = centerPrefix.current;
                    centerPrefix.current = false;
                    if (event.nativeEvent.isComposing || event.altKey || event.metaKey) return;
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
                                viewport.scrollTop += target.top + target.height / 2 - bounds.top - viewport.clientHeight / 2;
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
                        if (!command.disabled) command.run();
                        return;
                    }
                    createOnKeyDown({
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
                                    title={decoration.title}
                                    aria-label={decoration.title}
                                >
                                    {decoration.code}
                                </span>
                            )}
                        </div>
                    );
                })}
                {!visible.length && (
                    <p className={styles.emptyTree}>
                        No files yet.
                        <br />
                        Press <kbd>a</kbd> for a file or <kbd>A</kbd> for a folder.
                    </p>
                )}
            </div>
            <div className={styles.sidebarFooter}>
                <span className={styles.liveDot} />{' '}
                {clipboard
                    ? `${clipboard.cut ? 'Cut' : 'Copied'}: ${clipboard.name}`
                    : 'File commands'}{' '}
                <kbd>:</kbd>
            </div>
            {operation && (
                <ExplorerCommands
                    workspaceId={workspace.id}
                    request={operation.request}
                    commands={commands}
                    onClose={closeOperation}
                    onDone={(path) => {
                        setRevision(value => value + 1);
                        setSelected(treePath(path));
                        setExpanded((old) => {
                            const next = new Set(old);
                            const parts = path.split(/[\\/]/);
                            parts.pop();
                            while (parts.length) {
                                next.add(treePath(parts.join('/')));
                                parts.pop();
                            }
                            return next;
                        });
                        if (
                            clipboard?.cut &&
                            operation.request?.action === 'rename' &&
                            operation.request.path === clipboard.path
                        )
                            setClipboard(undefined);
                    }}
                />
            )}
        </aside>
    );
}
