import { useEffect, useRef, useState } from 'react';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { FileRequest } from '../components/ExplorerCommands';
import { getVisibleEntries } from '../sidebarTree';

export function useExplorer({
    workspace,
    active,
    onError
}: {
    workspace: Workspace;
    active: boolean;
    onError: (message: string) => void;
}) {
    const [entriesByDirectory, setEntries] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState('');
    const [revision, setRevision] = useState(0);
    const loadedRevision = useRef(-1);
    const tree = useRef<HTMLDivElement>(null);
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
        } catch (error) {
            onError(String(error));
        }
    };

    useEffect(() => {
        // Keep each tree's state, but load hidden workspaces only when first activated or changed.
        if (!active || loadedRevision.current === revision) {
            return;
        }
        let cancelled = false;
        Promise.all(
            ['', ...expanded].map(async (path) => {
                try {
                    return [path, await window.nido.files(workspace.id, path)] as const;
                } catch (error) {
                    if (!path || !String(error).includes('ENOENT')) {
                        throw error;
                    }
                    return [path, []] as const;
                }
            })
        )
            .then((files) => {
                if (!cancelled) {
                    loadedRevision.current = revision;
                    setEntries(Object.fromEntries(files));
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    onError(String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workspace.id, active, onError, revision]);

    const visible = getVisibleEntries(entriesByDirectory, expanded);
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
        operation,
        setOperation,
        clipboard,
        commands,
        closeOperation,
        onDone: finishFileOperation
    };
}
