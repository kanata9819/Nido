import type { FileEntry } from '../../shared/types';
import { toggle } from './sidebarToggle';

interface KeyboardDeps {
    visible: (FileEntry & { depth: number })[];
    selected: string;
    expanded: Set<string>;
    setSelected: (path: string) => void;
    setExpanded: (next: Set<string>) => void;
    load: (path: string) => Promise<void>;
    onOpen: (path: string) => void;
    workspaceId: string;
}

export function createOnKeyDown({
    visible,
    selected,
    expanded,
    setSelected,
    setExpanded,
    load,
    onOpen,
    workspaceId
}: KeyboardDeps): (event: React.KeyboardEvent) => void {
    return (event: React.KeyboardEvent): void => {
        if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.metaKey
        ) {
            return;
        }
        const key = event.key.toLowerCase();
        const navigationKey = event.key === 'g' && event.shiftKey ? 'G' : event.key;
        const halfPage = event.ctrlKey && !event.shiftKey && ['d', 'u'].includes(key);
        const fullPage =
            (event.ctrlKey && !event.shiftKey && ['f', 'b'].includes(key)) ||
            (!event.ctrlKey && ['PageDown', 'PageUp'].includes(event.key));
        if (event.ctrlKey && !halfPage && !fullPage) {
            return;
        }
        const index = visible.findIndex((entry) => entry.path === selected);
        const item = visible[Math.max(0, index)];
        if (
            halfPage ||
            fullPage ||
            ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'G'].includes(event.key)
        ) {
            event.preventDefault();
            event.stopPropagation();
            const tree = event.currentTarget;
            const rowHeight =
                tree.querySelector('[role="treeitem"]')?.getBoundingClientRect().height || 31;
            const step =
                halfPage || fullPage
                    ? Math.max(1, Math.floor(tree.clientHeight / rowHeight / (halfPage ? 2 : 1)))
                    : 1;
            const next = ['Home', 'g'].includes(navigationKey)
                ? 0
                : ['End', 'G'].includes(navigationKey)
                  ? visible.length - 1
                  : Math.min(
                        visible.length - 1,
                        Math.max(
                            0,
                            (halfPage || fullPage ? Math.max(0, index) : index) +
                                (['j', 'ArrowDown', 'PageDown'].includes(event.key) ||
                                (event.ctrlKey && ['d', 'f'].includes(key))
                                    ? step
                                    : -step)
                        )
                    );
            if (visible[next]) {
                setSelected(visible[next].path);
                document
                    .getElementById(`file-${workspaceId}-${visible[next].path}`)
                    ?.scrollIntoView({ block: 'nearest' });
            }
        } else if (item && ['Enter', 'l', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            if (!item.directory || !expanded.has(item.path) || event.key === 'Enter') {
                toggle({ entry: item, expanded, setExpanded, setSelected, onOpen, load });
            }
        } else if (item && ['h', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault();
            if (expanded.has(item.path)) {
                const next = new Set(expanded);
                next.delete(item.path);
                setExpanded(next);
            } else {
                const parent = item.path.replace(/[\\/][^\\/]+$/, '');
                if (parent !== item.path) {
                    setSelected(parent);
                }
            }
        }
    };
}
