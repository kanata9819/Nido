import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
    type RefObject
} from 'react';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { FileRequest } from '../components/ExplorerCommands';
import { getVisibleEntries } from '../sidebarTree';
import { readExplorerState, writeExplorerState } from '../explorerState';

interface ExplorerState {
    visible: ReturnType<typeof getVisibleEntries>;
    expanded: Set<string>;
    selected: string;
    setSelected: Dispatch<SetStateAction<string>>;
    setExpanded: Dispatch<SetStateAction<Set<string>>>;
    load: (path: string) => Promise<void>;
    tree: RefObject<HTMLDivElement | null>;
    ready: boolean;
    initialScrollTop: number;
    rememberScroll: (top: number) => void;
    operation: { request?: FileRequest } | undefined;
    setOperation: Dispatch<SetStateAction<{ request?: FileRequest } | undefined>>;
    clipboard: { path: string; name: string; cut: boolean } | undefined;
    commands: { title: string; key: string; disabled?: boolean; run: () => void }[];
    closeOperation: () => void;
    onDone: (path: string) => void;
}

interface DirectoryRequest {
    files: Promise<FileEntry[]>;
}

export function useExplorer({
    workspace,
    active,
    onError
}: {
    workspace: Workspace;
    active: boolean;
    onError: (message: string) => void;
}): ExplorerState {
    const [entriesByDirectory, setEntries] = useState<Record<string, FileEntry[]>>({});
    const [saved] = useState(() => readExplorerState(workspace.root));
    const [expanded, setExpanded] = useState(() => new Set(saved.expanded));
    const [selected, setSelected] = useState(saved.selected);
    const [ready, setReady] = useState(false);
    const latest = useRef(saved);
    const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [revision, setRevision] = useState(0);
    const loadedRevision = useRef(-1);
    const requests = useRef(new Map<string, DirectoryRequest>());
    const requestGeneration = useRef(0);
    const tree = useRef<HTMLDivElement>(null);
    const [operation, setOperation] = useState<{ request?: FileRequest }>();
    const [clipboard, setClipboard] = useState<{ path: string; name: string; cut: boolean }>();
    useEffect(() => {
        latest.current = { ...latest.current, expanded: [...expanded], selected };
        writeExplorerState(workspace.root, latest.current);
    }, [workspace.root, expanded, selected]);
    const rememberScroll = useCallback(
        (scrollTop: number): void => {
            latest.current = { ...latest.current, scrollTop };
            clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(
                () => writeExplorerState(workspace.root, latest.current),
                150
            );
        },
        [workspace.root]
    );
    useEffect(() => {
        const save = (): void => {
            clearTimeout(scrollTimer.current);
            writeExplorerState(workspace.root, latest.current);
        };
        window.addEventListener('pagehide', save);
        window.addEventListener('beforeunload', save);
        return () => {
            window.removeEventListener('pagehide', save);
            window.removeEventListener('beforeunload', save);
            save();
        };
    }, [workspace.root]);
    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (
                    (event.type === 'filesChanged' || event.type === 'exit') &&
                    event.id === workspace.id
                ) {
                    requestGeneration.current++;
                    requests.current.clear();
                    if (event.type === 'filesChanged') {
                        setRevision((value) => value + 1);
                    }
                }
            }),
        [workspace.id]
    );
    useEffect(
        () => () => {
            requestGeneration.current++;
            requests.current.clear();
        },
        [workspace.id]
    );
    const requestDirectory = useCallback(
        (path: string, replace = false): DirectoryRequest => {
            let request = requests.current.get(path);
            if (!request || replace) {
                request = { files: window.nido.files(workspace.id, path) };
                requests.current.set(path, request);
            }
            return request;
        },
        [workspace.id]
    );
    const load = async (path: string): Promise<void> => {
        // Explicit refreshes supersede old reads; automatic reloads can reuse this request.
        const request = requestDirectory(path, true);
        try {
            const files = await request.files;
            if (requests.current.get(path) === request) {
                setEntries((old) => ({ ...old, [path]: files }));
            }
        } catch (error) {
            if (requests.current.get(path) === request) {
                requests.current.delete(path);
                onError(String(error));
            }
        }
    };

    useEffect(() => {
        // Keep each tree's state, but load hidden workspaces only when first activated or changed.
        if (!active || loadedRevision.current === revision) {
            return;
        }
        let cancelled = false;
        const generation = requestGeneration.current;
        const current = (): boolean => !cancelled && generation === requestGeneration.current;
        const paths = ['', ...expanded];
        const files: [string, FileEntry[], DirectoryRequest][] = [];
        let nextPath = 0;
        // Bound automatic reloads instead of launching one Git/filesystem request per open folder.
        Promise.all(
            Array.from({ length: Math.min(4, paths.length) }, async () => {
                while (current() && nextPath < paths.length) {
                    const path = paths[nextPath++];
                    const request = requestDirectory(path);
                    try {
                        files.push([path, await request.files, request]);
                    } catch (error) {
                        if (!current() || requests.current.get(path) !== request) {
                            continue;
                        }
                        if (!path || !String(error).includes('ENOENT')) {
                            requests.current.delete(path);
                            throw error;
                        }
                        files.push([path, [], request]);
                    }
                }
            })
        )
            .then(() => {
                if (current()) {
                    loadedRevision.current = revision;
                    setEntries((old) =>
                        Object.fromEntries(
                            files.map(([path, entries, request]) => [
                                path,
                                requests.current.get(path) === request ? entries : old[path] || []
                            ])
                        )
                    );
                    setReady(true);
                }
            })
            .catch((error) => {
                if (current()) {
                    cancelled = true;
                    onError(String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workspace.id, active, onError, revision, expanded, requestDirectory]);

    const visible = useMemo(
        () => getVisibleEntries(entriesByDirectory, expanded),
        [entriesByDirectory, expanded]
    );
    const selectedEntry = visible.find((entry) => entry.path === selected);
    let targetDirectory = '';
    if (selectedEntry?.directory) {
        targetDirectory = selectedEntry.path;
    } else if (selectedEntry) {
        targetDirectory = selectedEntry.path.replace(/[\\/]?[^\\/]+$/, '');
    }
    const pathInTargetDirectory = (name: string): string =>
        targetDirectory ? `${targetDirectory}/${name}` : name;
    const toTreePath = (path: string): string =>
        path.replace(/[\\/]/g, workspace.root.includes('\\') ? '\\' : '/');
    const closeOperation = (): void => {
        setOperation(undefined);
        requestAnimationFrame(() => tree.current?.focus());
    };
    const requestFileOperation = (
        action: FileRequest['action'],
        title: string,
        value: string,
        path = selectedEntry?.path || ''
    ): void => setOperation({ request: { action, title, value, path } });
    const copySelectedEntry = (cut: boolean): void => {
        if (!selectedEntry) {
            return;
        }
        setClipboard({ path: selectedEntry.path, name: selectedEntry.name, cut });
        closeOperation();
    };
    const pasteClipboard = (): void => {
        if (!clipboard) {
            return;
        }
        const destination = pathInTargetDirectory(clipboard.name);
        const sourcePath = clipboard.path.replace(/\\/g, '/');
        const destinationPath = destination.replace(/\\/g, '/');
        let destinationName = destination;
        if (sourcePath === destinationPath) {
            // Pasting beside the original must suggest a new name instead of overwriting it.
            const copyName = clipboard.name.replace(/(\.[^.]*)?$/, ' copy$1');
            destinationName = pathInTargetDirectory(copyName);
        }
        requestFileOperation(
            clipboard.cut ? 'rename' : 'copy',
            clipboard.cut ? 'Move here' : 'Paste copy',
            destinationName,
            clipboard.path
        );
    };
    const commands = [
        {
            title: 'New file',
            key: 'a',
            run: () => requestFileOperation('createFile', 'New file', pathInTargetDirectory(''))
        },
        {
            title: 'New folder',
            key: 'A',
            run: () =>
                requestFileOperation('createDirectory', 'New folder', pathInTargetDirectory(''))
        },
        {
            title: 'Rename',
            key: 'r',
            disabled: !selectedEntry,
            run: () => requestFileOperation('rename', 'Rename', selectedEntry!.name)
        },
        {
            title: 'Move to…',
            key: 'm',
            disabled: !selectedEntry,
            run: () => requestFileOperation('rename', 'Move to…', selectedEntry!.path)
        },
        { title: 'Copy', key: 'c', disabled: !selectedEntry, run: () => copySelectedEntry(false) },
        { title: 'Cut', key: 'x', disabled: !selectedEntry, run: () => copySelectedEntry(true) },
        { title: 'Paste', key: 'p', disabled: !clipboard, run: pasteClipboard },
        {
            title: 'Delete',
            key: 'd',
            disabled: !selectedEntry,
            run: () => requestFileOperation('delete', 'Delete', '', selectedEntry!.path)
        }
    ];

    const finishFileOperation = (path: string): void => {
        requestGeneration.current++;
        requests.current.clear();
        setRevision((value) => value + 1);
        setSelected(toTreePath(path));
        setExpanded((old) => {
            const next = new Set(old);
            const ancestorSegments = path.split(/[\\/]/);
            ancestorSegments.pop();
            while (ancestorSegments.length) {
                next.add(toTreePath(ancestorSegments.join('/')));
                ancestorSegments.pop();
            }
            return next;
        });
        if (
            clipboard?.cut &&
            operation?.request?.action === 'rename' &&
            operation?.request.path === clipboard.path
        ) {
            setClipboard(undefined);
        }
    };

    return {
        visible,
        expanded,
        selected,
        setSelected,
        setExpanded,
        load,
        tree,
        ready,
        initialScrollTop: saved.scrollTop,
        rememberScroll,
        operation,
        setOperation,
        clipboard,
        commands,
        closeOperation,
        onDone: finishFileOperation
    };
}
