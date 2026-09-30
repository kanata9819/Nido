import type { FileEntry } from '../../shared/types';
import { toggle } from './sidebarToggle';

interface ExplorerKeyboardOptions {
    visible: (FileEntry & { depth: number })[];
    selected: string;
    expanded: Set<string>;
    setSelected: (path: string) => void;
    setExpanded: (next: Set<string>) => void;
    load: (path: string) => Promise<void>;
    onOpen: (path: string) => void;
    workspaceId: string;
}

export function createExplorerKeyHandler({
    visible,
    selected,
    expanded,
    setSelected,
    setExpanded,
    load,
    onOpen,
    workspaceId
}: ExplorerKeyboardOptions): (event: React.KeyboardEvent) => void {
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
        const isHalfPage = event.ctrlKey && !event.shiftKey && ['d', 'u'].includes(key);
        const isFullPage =
            (event.ctrlKey && !event.shiftKey && ['f', 'b'].includes(key)) ||
            (!event.ctrlKey && ['PageDown', 'PageUp'].includes(event.key));
        if (event.ctrlKey && !isHalfPage && !isFullPage) {
            return;
        }
        const selectedIndex = visible.findIndex((entry) => entry.path === selected);
        const selectedEntry = visible[Math.max(0, selectedIndex)];
        if (
            isHalfPage ||
            isFullPage ||
            ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'G'].includes(event.key)
        ) {
            event.preventDefault();
            event.stopPropagation();
            const tree = event.currentTarget;
            const rowHeight =
                tree.querySelector('[role="treeitem"]')?.getBoundingClientRect().height || 31;
            let rowsToMove = 1;
            if (isHalfPage || isFullPage) {
                const pageHeight = isHalfPage ? tree.clientHeight / 2 : tree.clientHeight;
                rowsToMove = Math.max(1, Math.floor(pageHeight / rowHeight));
            }

            let nextIndex: number;
            if (navigationKey === 'Home' || navigationKey === 'g') {
                nextIndex = 0;
            } else if (navigationKey === 'End' || navigationKey === 'G') {
                nextIndex = visible.length - 1;
            } else {
                const movingDown =
                    ['j', 'ArrowDown', 'PageDown'].includes(event.key) ||
                    (event.ctrlKey && ['d', 'f'].includes(key));
                // Page movement starts at the first row when nothing is selected yet.
                const startingIndex =
                    isHalfPage || isFullPage ? Math.max(0, selectedIndex) : selectedIndex;
                const direction = movingDown ? 1 : -1;
                nextIndex = startingIndex + direction * rowsToMove;
                nextIndex = Math.max(0, Math.min(visible.length - 1, nextIndex));
            }

            const nextEntry = visible[nextIndex];
            if (nextEntry) {
                setSelected(nextEntry.path);
                document
                    .getElementById(`file-${workspaceId}-${nextEntry.path}`)
                    ?.scrollIntoView({ block: 'nearest' });
            }
        } else if (selectedEntry && ['Enter', 'l', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            if (
                !selectedEntry.directory ||
                !expanded.has(selectedEntry.path) ||
                event.key === 'Enter'
            ) {
                toggle({ entry: selectedEntry, expanded, setExpanded, setSelected, onOpen, load });
            }
        } else if (selectedEntry && ['h', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault();
            if (expanded.has(selectedEntry.path)) {
                const next = new Set(expanded);
                next.delete(selectedEntry.path);
                setExpanded(next);
            } else {
                const parent = selectedEntry.path.replace(/[\\/][^\\/]+$/, '');
                if (parent !== selectedEntry.path) {
                    setSelected(parent);
                }
            }
        }
    };
}
