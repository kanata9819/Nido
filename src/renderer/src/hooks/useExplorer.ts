import { useEffect, useRef, useState } from 'react';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { FileRequest } from '../components/ExplorerCommands';
import { getVisibleEntries } from '../sidebarTree';

export function useExplorer({
    workspace,
    onError
}: {
    workspace: Workspace;
    onError: (message: string) => void;
}) {
    const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState('');
    const [revision, setRevision] = useState(0);
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

    const onDone = (path: string): void => {
        setRevision((value) => value + 1);
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
            operation?.request?.action === 'rename' &&
            operation?.request.path === clipboard.path
        )
            setClipboard(undefined);
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
        onDone
    };
}
