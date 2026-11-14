// Types used across the renderer.

/** The views of the Git browser. */
export type GitView = 'changes' | 'history' | 'branches';

/** The palette or panel shown over the editor, or null when none is open. */
export type Panel =
	| 'commands'
	| 'workspaces'
	| 'files'
	| 'symbols'
	| 'search'
	| 'buffers'
	| 'settings'
	| 'folders'
	| 'git'
	| 'problems'
	| 'markdown'
	| 'extensions'
	| 'history'
	| null;

/** A row of a palette. `key` is shown as a shortcut or tag; `run` performs the item. */
export interface Item {
	/** Diagnostic severity, for the Problems palette. */
	severity?: number;
	key: string;
	title: string;
	detail: string;
	run: () => void;
}
