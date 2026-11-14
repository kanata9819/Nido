// Types and limits for Time Machine, the local history that keeps earlier versions of each
// file. Shared by the main process (which stores versions) and the renderer (which lists them).

/** Size limits for local history: per file, per history file, and for the whole store. */
export const historyLimits = {
	/** Largest file whose versions are recorded. */
	fileBytes: 4 * 1024 * 1024,
	/** Most lines a recorded file may have. */
	lines: 100000,
	/** Versions kept per file; older ones are dropped first. */
	versions: 20,
	/** Largest history file (all versions of one file) on disk. */
	historyBytes: 32 * 1024 * 1024,
	/** Disk space for all history files together. */
	totalBytes: 128 * 1024 * 1024,
	/** Number of files that keep a history. */
	files: 200
} as const;

/** Text of a version, with the line-ending details needed to restore it exactly. */
export interface HistoryContent {
	text: string;
	endOfLine: boolean;
	fileformat: 'unix' | 'dos' | 'mac';
}

/** One stored version as listed in Time Machine. */
export interface HistoryVersion {
	id: string;
	timestamp: number;
	/** saved: written to disk, draft: unsaved buffer contents, restored: written by a restore. */
	kind: 'saved' | 'draft' | 'restored';
	bytes: number;
	lines: number;
}

/** The current contents of an open buffer, captured from Neovim. */
export interface HistorySnapshot extends HistoryContent {
	path: string;
	buffer: number;
	/** Neovim's changedtick, which grows with every change to the buffer. */
	tick: number;
	modified: boolean;
}

/**
 * What was last captured from a buffer. Neovim skips buffers whose token still matches, so
 * unchanged buffers are not sent again.
 */
export type HistoryToken = [buffer: number, tick: number, fileformat: string, endOfLine: boolean];

/** The versions stored for one file. */
export interface HistoryList {
	path: string;
	versions: HistoryVersion[];
}

/** A diff between a stored version and the current buffer, shown before restoring. */
export interface HistoryPreview {
	path: string;
	version: HistoryVersion;
	/** Identifies the buffer contents the diff was made against; restoring checks it still matches. */
	token: string;
	diff: string;
	identical: boolean;
}
