import { onNidoEvent } from '../nidoEvents';
import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type Dispatch,
	type SetStateAction,
	type RefObject
} from 'react';
import {
	terminalShells,
	type TerminalShell,
	type SessionState,
	type Workspace
} from '../../../shared/types';
import type { WorkspacePosition, WorkspaceState } from '../types';

/** The open workspaces, the selected one, and each workspace's session state. */
interface WorkspaceSessions {
	workspaces: Workspace[];
	setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
	active: string;
	setActive: Dispatch<SetStateAction<string>>;
	states: Record<string, WorkspaceState>;
	positions: WorkspacePositions;
	/** Each workspace's Neovim mode as last reported, read by the keyboard shortcuts. */
	mode: RefObject<Record<string, string>>;
	restoring: boolean;
}

/** The state of a workspace before Neovim has reported any. */
export const initialSessionState: WorkspaceState = {
	buffers: [],
	current: 0,
	mode: 'n',
	filetype: ''
};

const initialPosition: WorkspacePosition = { line: 1, column: 1 };

export interface WorkspacePositions {
	get: (id: string) => WorkspacePosition;
	subscribe: (listener: () => void) => () => void;
}

function createWorkspacePositions(): WorkspacePositions & {
	set: (id: string, position: WorkspacePosition) => void;
	remove: (id: string) => void;
} {
	const positions = new Map<string, WorkspacePosition>();
	const listeners = new Set<() => void>();
	const get = (id: string): WorkspacePosition => positions.get(id) ?? initialPosition;
	const notify = (): void => listeners.forEach((listener) => listener());
	return {
		get,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(id, position) {
			const previous = get(id);
			if (
				previous.line !== position.line ||
				previous.column !== position.column ||
				previous.scrollPercent !== position.scrollPercent
			) {
				positions.set(id, position);
				notify();
			}
		},
		remove(id) {
			if (positions.delete(id)) {
				notify();
			}
		}
	};
}

export function useWorkspacePosition(positions: WorkspacePositions, id: string): WorkspacePosition {
	return useSyncExternalStore(positions.subscribe, () => positions.get(id));
}

/**
 * The workspaces and their session state, restored at startup and kept up to date from the
 * main process's events.
 */
export function useWorkspaceSessions(report: (message: string) => void): WorkspaceSessions {
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [selectedWorkspace, setActive] = useState('');
	const [states, setStates] = useState<Record<string, WorkspaceState>>({});
	const [positions] = useState(createWorkspacePositions);
	const [restoring, setRestoring] = useState(true);
	const mode = useRef<Record<string, string>>({});
	// The selected workspace, or the first one when it closed.
	const active = workspaces.some((w) => w.id === selectedWorkspace)
		? selectedWorkspace
		: workspaces[0]?.id || '';
	// Exit events arrive outside render; they read the tab order from here.
	const latestWorkspaces = useRef(workspaces);
	useEffect(() => {
		latestWorkspaces.current = workspaces;
	});

	// Apply session events: state (batched to one render per frame), errors and exits.
	useEffect(() => {
		const pendingStates = new Map<string, Partial<SessionState>>();
		let frame = 0;
		const unsubscribe = onNidoEvent((event) => {
			switch (event.type) {
				case 'state':
				case 'statePatch': {
					// Scrolling can deliver several states before a paint. Render the shell once.
					pendingStates.set(event.id, { ...pendingStates.get(event.id), ...event.state });
					if (!frame) {
						frame = requestAnimationFrame(() => {
							frame = 0;
							const updates: [string, Partial<WorkspaceState>][] = [];
							for (const [id, update] of pendingStates) {
								const { line, column, scrollPercent, ...state } = update;
								const previous = positions.get(id);
								positions.set(id, {
									line: line ?? previous.line,
									column: column ?? previous.column,
									scrollPercent:
										'scrollPercent' in update
											? scrollPercent
											: previous.scrollPercent
								});
								if (Object.keys(state).length) {
									updates.push([id, state]);
								}
							}
							pendingStates.clear();
							if (updates.length) {
								setStates((old) => {
									const next = { ...old };
									for (const [id, update] of updates) {
										next[id] = {
											...(old[id] || initialSessionState),
											...update
										};
									}
									return next;
								});
							}
						});
					}
					break;
				}
				case 'redraw': {
					for (const [name, ...calls] of event.events) {
						if (name === 'mode_change') {
							mode.current[event.id] = String(calls.at(-1)?.[0]);
						}
					}
					break;
				}
				case 'error': {
					report(event.message);
					break;
				}
				case 'exit': {
					pendingStates.delete(event.id);
					positions.remove(event.id);
					const list = latestWorkspaces.current;
					const index = list.findIndex((w) => w.id === event.id);
					if (index >= 0) {
						const remaining = list.filter((w) => w.id !== event.id);
						// Several exits can arrive before the next render.
						latestWorkspaces.current = remaining;
						// Closing the selected tab selects the one that takes its place, as
						// browsers do, rather than the first tab, which may be asleep.
						setActive((selected) => {
							const shown = list.some((w) => w.id === selected)
								? selected
								: list[0]?.id;
							return shown === event.id
								? (remaining[Math.min(index, remaining.length - 1)]?.id ?? '')
								: selected;
						});
					}
					setWorkspaces((old) =>
						old
							.filter((w) => w.id !== event.id)
							.map((w) =>
								w.terminalId === event.id ? { ...w, terminalId: undefined } : w
							)
					);
					setStates((old) => {
						const next = { ...old };
						delete next[event.id];
						return next;
					});
					break;
				}
			}
		});
		return () => {
			unsubscribe();
			cancelAnimationFrame(frame);
		};
	}, [report, positions]);

	// Restore the workspaces of the last run, with the saved terminal shell.
	useEffect(() => {
		let cancelled = false;
		void window.nido
			.restoreWorkspaces(
				terminalShells.find(
					(shell) => shell === localStorage.getItem('nido.terminalShell')
				) as TerminalShell | undefined
			)
			.then((result) => {
				if (cancelled) {
					return;
				}
				setWorkspaces(result.workspaces);
				setActive(result.active);
				if (result.errors.length) {
					report(result.errors.join('\n'));
				}
			})
			.catch((e) => {
				if (!cancelled) {
					report(String(e));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setRestoring(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [report]);

	// Tell the main process the tab order and the selected workspace, to save them.
	useEffect(() => {
		if (!restoring) {
			void window.nido
				.workspaceLayout(
					workspaces.map((w) => w.id),
					active
				)
				.catch((e) => report(String(e)));
		}
	}, [workspaces, active, restoring, report]);

	return { workspaces, setWorkspaces, active, setActive, states, positions, mode, restoring };
}
