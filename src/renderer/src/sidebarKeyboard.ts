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
  workspaceId,
}: KeyboardDeps): (event: React.KeyboardEvent) => void {
  return (event: React.KeyboardEvent): void => {
    const index = visible.findIndex((entry) => entry.path === selected),
      item = visible[Math.max(0, index)];
    if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? visible.length - 1
            : Math.min(
                visible.length - 1,
                Math.max(0, index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1))
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
      } else if (['h', 'ArrowLeft'].includes(event.key)) {
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
    }
  };
}
