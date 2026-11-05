import { isAbsolute, sep } from 'node:path';
import type { FileAction, NidoEvent } from '../shared/types';
import type { SearchOptions } from '../shared/search';
import type { Session } from './session';
import { workspaceRelative as relative } from './workspacePaths';

export function registerFileHandlers({
	handle,
	session,
	text,
	integer,
	sessions,
	send,
	trash
}: {
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	session: (id: unknown) => Session;
	text: (value: unknown) => string;
	integer: (value: unknown, max?: number) => number;
	sessions: Map<string, Session>;
	send: (event: NidoEvent) => void;
	trash: (path: string) => Promise<void>;
}): void {
	handle('files', (id, path) => session(id).files(text(path)));
	handle('watchDirectories', (id, paths) => {
		if (
			!Array.isArray(paths) ||
			paths.some((path) => typeof path !== 'string' || path.length > 4096)
		) {
			throw new Error('Invalid directory selection.');
		}
		return session(id).watchDirectories(paths);
	});
	handle('findFiles', (id, query) =>
		session(id).findFiles(query === undefined ? '' : text(query))
	);
	handle('cancelFindFiles', (id) => session(id).cancelFindFiles());
	handle('searchText', (id, query, options) => {
		if (
			options !== undefined &&
			(!options || typeof options !== 'object' || Array.isArray(options))
		) {
			throw new Error('Invalid search options.');
		}
		return session(id).searchText(text(query), options as SearchOptions | undefined);
	});
	handle('previewReplacement', (id, token, replacement, selected) => {
		if (!Array.isArray(selected)) {
			throw new Error('Choose matching lines to replace.');
		}
		return session(id).previewReplacement(text(token), text(replacement), selected);
	});
	handle('applyReplacement', (id, token) => session(id).applyReplacement(text(token)));
	handle('openFile', (id, path, line, column) =>
		session(id).openFile(
			text(path),
			line === undefined ? undefined : integer(line, 2_000_000),
			column === undefined ? undefined : integer(column, 2_000_000)
		)
	);
	handle('fileAction', async (id, action, path, target) => {
		if (
			typeof action !== 'string' ||
			!['createFile', 'createDirectory', 'rename', 'copy', 'delete'].includes(action)
		) {
			throw new Error('Invalid file action.');
		}
		const current = session(id);
		if (action === 'rename' || action === 'delete' || action === 'copy') {
			const source = await current.path(text(path));
			for (const open of sessions.values()) {
				if (open === current) {
					continue;
				}
				if (
					open.state.buffers.some((buffer) => {
						if (!buffer.name) {
							return false;
						}
						const child = relative(source, buffer.name);
						return (
							child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
						);
					})
				) {
					throw new Error(
						'Close this file or folder in the other workspace session first.'
					);
				}
			}
		}
		await current.fileAction(
			action as FileAction,
			text(path),
			target === undefined ? '' : text(target),
			trash
		);
		for (const open of sessions.values()) {
			if (open.workspace.root === current.workspace.root) {
				send({ type: 'filesChanged', id: open.workspace.id });
			}
		}
	});
}
