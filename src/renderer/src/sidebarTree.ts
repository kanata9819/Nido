import type { FileEntry } from '../../shared/types';

export function getVisibleEntries(
    entries: Record<string, FileEntry[]>,
    expanded: Set<string>
): (FileEntry & { depth: number })[] {
    const visible: (FileEntry & { depth: number })[] = [];
    function visit(path: string, depth: number): void {
        for (const entry of entries[path] || []) {
            visible.push({ ...entry, depth });
            if (entry.directory && expanded.has(entry.path)) {
                visit(entry.path, depth + 1);
            }
        }
    }
    visit('', 0);
    return visible;
}
