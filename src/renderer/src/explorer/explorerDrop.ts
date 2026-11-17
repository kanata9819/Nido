import { useState, type DragEvent } from 'react';
import type { Workspace } from '../../../shared/types';

/** A row of the tree, as far as a drop needs it. */
interface DropEntry {
	path: string;
	directory: boolean;
}

/**
 * The folder that files dropped on `entry` go into: a folder itself, the folder holding a file,
 * or the workspace (`''`) for the tree's empty space.
 */
export function dropDirectory(entry: DropEntry | undefined): string {
	if (!entry) {
		return '';
	}
	return entry.directory ? entry.path : entry.path.replace(/[\\/]?[^\\/]+$/, '');
}

/**
 * Whether the row at `path` is the drop folder or inside it, so it is highlighted with it. For
 * the workspace (`''`) the whole tree is highlighted instead of its rows.
 */
export function insideDropDirectory(path: string, directory: string | undefined): boolean {
	if (!directory) {
		return false;
	}
	return (
		path === directory ||
		(path.startsWith(directory) && /[\\/]/.test(path.charAt(directory.length)))
	);
}

/** Whether a drag carries files from the operating system, rather than text or a tab. */
function carriesFiles(event: DragEvent): boolean {
	return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Copying files and folders dragged from the operating system into the explorer. While a drag
 * is over the tree, `dropTarget` is the folder they would go into; `''` is the workspace.
 */
export function useExplorerDrop({
	workspace,
	entryAt,
	onDone,
	onError
}: {
	workspace: Workspace;
	/** The row with this element id, if any. */
	entryAt: (id: string) => DropEntry | undefined;
	onDone: (path: string) => void;
	onError: (message: string) => void;
}): {
	dropTarget: string | undefined;
	dropHandlers: {
		onDragOver: (event: DragEvent<HTMLElement>) => void;
		onDragLeave: (event: DragEvent<HTMLElement>) => void;
		onDrop: (event: DragEvent<HTMLElement>) => void;
	};
} {
	const [dropTarget, setDropTarget] = useState<string>();
	const directoryAt = (event: DragEvent): string => {
		const row = (event.target as Element).closest?.('[role="treeitem"]');
		return dropDirectory(row ? entryAt(row.id) : undefined);
	};
	return {
		dropTarget,
		dropHandlers: {
			onDragOver: (event) => {
				if (!carriesFiles(event)) {
					return;
				}
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
				const directory = directoryAt(event);
				setDropTarget((old) => (old === directory ? old : directory));
			},
			onDragLeave: (event) => {
				// Moving between rows leaves one row for another inside the tree.
				const next = event.relatedTarget as Node | null;
				if (!next || !event.currentTarget.contains(next)) {
					setDropTarget(undefined);
				}
			},
			onDrop: (event) => {
				setDropTarget(undefined);
				if (!carriesFiles(event)) {
					return;
				}
				event.preventDefault();
				const directory = directoryAt(event);
				const sources = Array.from(event.dataTransfer.files)
					.map((file) => window.nido.pathForFile(file))
					.filter(Boolean);
				if (!sources.length) {
					return;
				}
				window.nido.importFiles(workspace.id, sources, directory).then(
					(copied) => {
						if (copied.length) {
							onDone(copied[0]);
						}
					},
					(error: unknown) => onError(String(error))
				);
			}
		}
	};
}
