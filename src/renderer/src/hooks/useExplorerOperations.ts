import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Workspace } from '../../../shared/types';
import type { FileRequest } from '../components/ExplorerCommands';
import type { getVisibleEntries } from '../sidebarTree';

type ExplorerEntry = ReturnType<typeof getVisibleEntries>[number];

export function useExplorerOperations({
	workspace,
	selectedEntry,
	tree,
	invalidate,
	setSelected,
	setExpanded
}: {
	workspace: Workspace;
	selectedEntry: ExplorerEntry | undefined;
	tree: RefObject<HTMLDivElement | null>;
	invalidate: () => void;
	setSelected: Dispatch<SetStateAction<string>>;
	setExpanded: Dispatch<SetStateAction<Set<string>>>;
}): {
	operation: { request?: FileRequest } | undefined;
	setOperation: Dispatch<SetStateAction<{ request?: FileRequest } | undefined>>;
	clipboard: { path: string; name: string; cut: boolean } | undefined;
	commands: { title: string; key: string; disabled?: boolean; run: () => void }[];
	closeOperation: () => void;
	onDone: (path: string) => void;
} {
	const [operation, setOperation] = useState<{ request?: FileRequest }>();
	const [clipboard, setClipboard] = useState<{ path: string; name: string; cut: boolean }>();
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
		invalidate();
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
		operation,
		setOperation,
		clipboard,
		commands,
		closeOperation,
		onDone: finishFileOperation
	};
}
