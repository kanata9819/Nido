import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FavoriteWorkspace, SavedWorkspace } from '../shared/types';

// Reading and writing the JSON files that Nido keeps in its user data folder: the workspace
// layout (restored on the next launch) and the favorite workspaces. Every file is validated
// when read, and written through a temporary file so an interrupted write leaves the old file.

/** The saved window and workspaces, in workspaces.json. `active` indexes `workspaces`. */
export interface SavedLayout {
	version: 1;
	window?: { width: number; height: number; maximized: boolean };
	workspaces: SavedWorkspace[];
	active: number;
}

/** Read the layout, falling back to its backup (.bak) when the file is missing or damaged. */
export async function readLayout(path: string): Promise<SavedLayout> {
	try {
		return parseLayout(await readFile(path, 'utf8'));
	} catch (error) {
		// Keep a last-known-good layout available after interrupted or corrupt writes.
		try {
			return parseLayout(await readFile(`${path}.bak`, 'utf8'));
		} catch (backupError) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') {
					return { version: 1, workspaces: [], active: 0 };
				}
				throw backupError;
			}
			throw error;
		}
	}
}

// Limits for untitled buffers kept in the layout, matching untitledRecoveryLimitMessage.
const maxUntitledBuffers = 100;
const maxUntitledBytes = 8 * 1024 * 1024;
const maxTotalUntitledBytes = 16 * 1024 * 1024;

type SavedDraft = NonNullable<SavedWorkspace['untitled']>[number];

/** Bytes of a draft's lines, counting a newline after each line. */
function draftBytes(draft: SavedDraft): number {
	return draft.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
}

/** Whether a saved untitled buffer is well formed and within its size limit. */
function validDraft(draft: SavedDraft): boolean {
	return (
		!!draft &&
		(draft.id === undefined ||
			(typeof draft.id === 'string' && /^[a-f0-9-]{36}:\d+$/.test(draft.id))) &&
		(draft.index === undefined || (Number.isSafeInteger(draft.index) && draft.index > 0)) &&
		Array.isArray(draft.lines) &&
		draft.lines.length > 0 &&
		draft.lines.every((line) => typeof line === 'string' && !line.includes('\n')) &&
		draftBytes(draft) <= maxUntitledBytes + 1 &&
		typeof draft.endOfLine === 'boolean' &&
		['unix', 'dos', 'mac'].includes(draft.fileformat) &&
		Number.isSafeInteger(draft.line) &&
		draft.line > 0 &&
		Number.isSafeInteger(draft.column) &&
		draft.column >= 0
	);
}

/** Whether a workspace's untitled buffers are valid and together within the total limit. */
function validDrafts(drafts: SavedWorkspace['untitled']): boolean {
	return (
		drafts === undefined ||
		(Array.isArray(drafts) &&
			drafts.length <= maxUntitledBuffers &&
			drafts.every(validDraft) &&
			drafts.reduce((bytes, draft) => bytes + draftBytes(draft), 0) <=
				maxTotalUntitledBytes + drafts.length)
	);
}

/** Whether an open file entry has an absolute path and a valid cursor. */
function validFile(file: SavedWorkspace['files'][number]): boolean {
	return (
		!!file &&
		typeof file.path === 'string' &&
		isAbsolute(file.path) &&
		Number.isSafeInteger(file.line) &&
		file.line > 0 &&
		Number.isSafeInteger(file.column) &&
		file.column >= 0
	);
}

/** Whether a saved workspace is well formed. */
function validWorkspace(w: SavedWorkspace): boolean {
	return (
		!!w &&
		(w.kind === undefined || w.kind === 'editor' || w.kind === 'terminal') &&
		(w.terminal === undefined || typeof w.terminal === 'boolean') &&
		typeof w.root === 'string' &&
		isAbsolute(w.root) &&
		typeof w.current === 'string' &&
		validDrafts(w.untitled) &&
		(w.currentUntitled === undefined ||
			(Number.isSafeInteger(w.currentUntitled) &&
				w.currentUntitled >= 0 &&
				w.currentUntitled < (w.untitled?.length ?? 0))) &&
		Array.isArray(w.files) &&
		w.files.every(validFile)
	);
}

/** Parse and validate a layout file; throws on anything malformed. */
function parseLayout(content: string): SavedLayout {
	const data: SavedLayout = JSON.parse(content);
	if (
		!data ||
		data.version !== 1 ||
		!Number.isInteger(data.active) ||
		!Array.isArray(data.workspaces) ||
		!data.workspaces.every(validWorkspace)
	) {
		throw new Error('Invalid saved workspace data.');
	}
	return data;
}

/**
 * Write the layout. The previous valid layout is kept as a backup first, so a crash during the
 * write can still restore it. `replaceBackup` writes the new layout to both files instead.
 */
export async function writeLayout(
	path: string,
	data: SavedLayout,
	options: { replaceBackup?: boolean } = {}
): Promise<void> {
	parseLayout(JSON.stringify(data));
	let previous: SavedLayout | undefined;
	try {
		previous = parseLayout(await readFile(path, 'utf8'));
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== 'ENOENT' &&
			!(error instanceof SyntaxError) &&
			!(error instanceof Error && error.message === 'Invalid saved workspace data.')
		) {
			throw error;
		}
	}
	// A damaged primary file must never replace a valid backup.
	if (!options.replaceBackup && previous && JSON.stringify(previous) !== JSON.stringify(data)) {
		await writeJson(`${path}.bak`, retainExistingDrafts(previous, data));
	}
	await writeJson(path, data);
	if (options.replaceBackup) {
		await writeJson(`${path}.bak`, data);
	}
}

/** A backup must not resurrect drafts that have since been saved or discarded. */
function retainExistingDrafts(previous: SavedLayout, current: SavedLayout): SavedLayout {
	const ids = new Set(
		current.workspaces.flatMap((workspace) =>
			(workspace.untitled || []).flatMap((draft) => (draft.id ? [draft.id] : []))
		)
	);
	return {
		...previous,
		workspaces: previous.workspaces.map((workspace) => {
			if (!workspace.untitled) {
				return workspace;
			}
			const retained = workspace.untitled.filter((draft) => draft.id && ids.has(draft.id));
			const active =
				workspace.currentUntitled === undefined
					? undefined
					: workspace.untitled[workspace.currentUntitled];
			const currentUntitled = active ? retained.indexOf(active) : -1;
			const removedPositions = workspace.untitled.flatMap((draft) =>
				!retained.includes(draft) && draft.index !== undefined ? [draft.index] : []
			);
			const rest = { ...workspace };
			delete rest.untitled;
			delete rest.currentUntitled;
			return {
				...rest,
				...(retained.length
					? {
							untitled: retained.map((draft) => {
								const index = draft.index;
								return index === undefined
									? draft
									: {
											...draft,
											index:
												index -
												removedPositions.filter(
													(position) => position < index
												).length
										};
							})
						}
					: {}),
				...(currentUntitled >= 0 ? { currentUntitled } : {})
			};
		})
	};
}

/**
 * Favorites have no backup, so damaged data would make every later read and change fail until
 * the file was deleted by hand. It is moved aside to `favorites.json.invalid`, where it can
 * still be recovered, and the list starts empty.
 */
export async function readFavorites(path: string): Promise<FavoriteWorkspace[]> {
	let content: string;
	try {
		content = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	try {
		return parseFavorites(content);
	} catch {
		try {
			await rename(path, `${path}.invalid`);
		} catch (error) {
			// A simultaneous read may have moved it already.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		return [];
	}
}

function parseFavorites(content: string): FavoriteWorkspace[] {
	const data: unknown = JSON.parse(content);
	if (
		!Array.isArray(data) ||
		!data.every(
			(w) =>
				w &&
				typeof w.root === 'string' &&
				isAbsolute(w.root) &&
				typeof w.name === 'string' &&
				(w.kind === 'editor' || w.kind === 'terminal')
		)
	) {
		throw new Error('Invalid favorite workspace data.');
	}
	return data;
}

export async function writeFavorites(path: string, data: FavoriteWorkspace[]): Promise<void> {
	await writeJson(path, data);
}

/** Write JSON atomically: to a temporary file first, then renamed over the target. */
async function writeJson(path: string, data: unknown): Promise<void> {
	await writeFile(`${path}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
	await rename(`${path}.tmp`, path);
}
