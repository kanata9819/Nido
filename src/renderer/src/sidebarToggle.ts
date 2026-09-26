import type { FileEntry } from '../../shared/types';

interface ToggleDeps {
  entry: FileEntry & { depth?: number };
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  setSelected: (path: string) => void;
  onOpen: (path: string) => void;
  load: (path: string) => Promise<void>;
}

export function toggle({
  entry,
  expanded,
  setExpanded,
  setSelected,
  onOpen,
  load,
}: ToggleDeps): void {
  setSelected(entry.path);
  if (!entry.directory) {
    onOpen(entry.path);
    return;
  }
  const next = new Set(expanded);
  if (next.has(entry.path)) {
    next.delete(entry.path);
  } else {
    next.add(entry.path);
    void load(entry.path);
  }
  setExpanded(next);
}
