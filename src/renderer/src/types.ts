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
	/** Identifies a command across languages and states, to list recently run ones first. */
	id?: string;
	/** Whether the command ran recently, which the palette marks. */
	recent?: boolean;
	/** In the workspace list: the selected workspace, or one that is asleep. */
	status?: 'current' | 'sleeping';
	/** In the workspace list: put this workspace to sleep (Ctrl+S); absent when it cannot. */
	sleep?: () => void;
	/** The tab represented by a row in one of the tab lists. */
	tab?: { id: string | number; moveTo: (target: string | number) => void | Promise<void> };
}
