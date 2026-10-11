import type { FileEntry } from '../../shared/types';

export function getVisibleEntries(
    entries: Record<string, FileEntry[]>,
    expanded: Set<string>
): (FileEntry & { depth: number; position: number; siblings: number })[] {
    const visible: (FileEntry & { depth: number; position: number; siblings: number })[] = [];
    function visit(path: string, depth: number): void {
        const children = entries[path] || [];
        for (const [index, entry] of children.entries()) {
            visible.push({ ...entry, depth, position: index + 1, siblings: children.length });
            if (entry.directory && expanded.has(entry.path)) {
                visit(entry.path, depth + 1);
            }
        }
    }
    visit('', 0);
    return visible;
}
