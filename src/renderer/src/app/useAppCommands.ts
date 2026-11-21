import { useCallback, useMemo } from 'react';
import { useI18n } from '../i18n';
import { buildItems, buildProblemItems, filterItems } from '../palette/commands';
import type { CommandsCallbacks } from '../palette/commandItems';
import type { FileEntry, Workspace } from '../../../shared/types';
import type { Item, Panel, WorkspaceState } from '../types';

type Callbacks = CommandsCallbacks & { reorderWorkspace: (id: string, target: string) => void };

/**
 * Every command, and the items of the open palette filtered by its query. The Problems list
 * is built only while its palette is open.
 */
export function useAppCommands({
	active,
	panel,
	workspaces,
	fileList,
	state,
	query,
	runThenFocus,
	callbacks
}: {
	active: string;
	panel: Panel;
	workspaces: Workspace[];
	fileList: FileEntry[];
	state: WorkspaceState;
	query: string;
	/** Runs a session request, then returns focus to the editor if nothing stole it. */
	runThenFocus: (request: () => Promise<unknown>) => void;
	callbacks: Callbacks;
}): { commands: Item[]; filtered: Item[] } {
	const t = useI18n();
	const openProblem = useCallback(
		(index: number): void =>
			runThenFocus(() =>
				window.nido.openProblem(active, index + 1, state.diagnosticsVersion!)
			),
		[active, state.diagnosticsVersion, runThenFocus]
	);
	const problemItems = useMemo(
		() => (panel === 'problems' ? buildProblemItems(state.problems, openProblem, t) : []),
		[panel, state.problems, openProblem, t]
	);
	const filteredProblems = useMemo(() => filterItems(problemItems, query), [problemItems, query]);
	const { commands, filtered } = buildItems(
		active,
		panel,
		workspaces,
		fileList,
		state,
		query,
		callbacks,
		t,
		{ items: problemItems, filtered: filteredProblems }
	);
	return { commands, filtered };
}
