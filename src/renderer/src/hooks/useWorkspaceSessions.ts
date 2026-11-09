import { onNidoEvent } from '../nidoEvents';
import {
	useEffect,
	useRef,
	useState,
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

interface WorkspaceSessions {
	workspaces: Workspace[];
	setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
	active: string;
	setActive: Dispatch<SetStateAction<string>>;
	states: Record<string, SessionState>;
	mode: RefObject<Record<string, string>>;
	restoring: boolean;
}

const initialState: SessionState = {
	buffers: [],
	current: 0,
	mode: 'n',
	line: 1,
	column: 1,
	filetype: ''
};

export function useWorkspaceSessions(report: (message: string) => void): WorkspaceSessions {
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [selectedWorkspace, setActive] = useState('');
	const [states, setStates] = useState<Record<string, SessionState>>({});
	const [restoring, setRestoring] = useState(true);
	const mode = useRef<Record<string, string>>({});
	const active = workspaces.some((w) => w.id === selectedWorkspace)
		? selectedWorkspace
		: workspaces[0]?.id || '';
	// Exit events arrive outside render; they read the tab order from here.
	const latestWorkspaces = useRef(workspaces);
	useEffect(() => {
		latestWorkspaces.current = workspaces;
	});

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
							if (pendingStates.size) {
								const updates = [...pendingStates];
								pendingStates.clear();
								setStates((old) => {
									const next = { ...old };
									for (const [id, update] of updates) {
										next[id] = {
											...(old[id] || initialState),
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
	}, [report]);

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

	return { workspaces, setWorkspaces, active, setActive, states, mode, restoring };
}
