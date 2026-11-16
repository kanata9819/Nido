import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction
} from 'react';
import type { DebugAction, SessionState, TerminalShell, Workspace } from '../../../shared/types';

interface Options {
	active: string;
	workspace?: Workspace;
	state: SessionState;
	terminalShell: TerminalShell;
	setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
	focusEditor: () => void;
	captureFocus: () => () => boolean;
	dismissLeader: () => void;
	closeOverlay: () => void;
	run: (promise: Promise<unknown>) => void;
}

/**
 * The panels below the editor (Run and Debug, references, terminal). Only `bottomPanel` is
 * shown at a time; each `*FocusTick` grows to ask that panel to take focus.
 */
export interface BottomPanels {
	bottomPanel: 'debug' | 'references' | 'terminal';
	debugVisible: boolean;
	debugFocusTick: number;
	referencesVisible: boolean;
	referencesFocusTick: number;
	terminalVisible: boolean;
	terminalFocusTick: number;
	closeReferences: () => void;
	closeDebugger: () => void;
	closeTerminal: () => void;
	toggleTerminal: () => void;
	restartShell: (id: string) => void;
	/** Height of the terminal panel in pixels, and whether it covers the editor. */
	terminalHeight: number;
	resizeTerminal: (height: number) => void;
	terminalMaximized: boolean;
	toggleTerminalMaximized: () => void;
	/** Start another shell in a terminal, show one by its 1-based position, or stop one. */
	addShell: (id: string) => void;
	selectShell: (id: string, position: number) => void;
	closeShell: (id: string, position: number) => void;
	openDebugger: () => void;
	showDebugger: () => void;
	toggleDebugger: () => void;
	toggleReferences: () => void;
	openReference: (index: number) => void;
	debug: (action: DebugAction, target?: number) => void;
}

/** Own bottom-panel visibility, session signals and explicit focus requests. */
export function useBottomPanels({
	active,
	workspace,
	state,
	terminalShell,
	setWorkspaces,
	focusEditor,
	captureFocus,
	dismissLeader,
	closeOverlay,
	run
}: Options): BottomPanels {
	const [debugVisible, setDebugVisible] = useState(false);
	const [debugFocusTick, setDebugFocusTick] = useState(0);
	const [referencesVisible, setReferencesVisible] = useState(false);
	// Per workspace, the references search the user closed, so it does not reopen by itself.
	const [dismissedReferences, setDismissedReferences] = useState<Record<string, number>>({});
	const [referencesFocusTick, setReferencesFocusTick] = useState(0);
	const [bottomPanel, setBottomPanel] = useState<'debug' | 'references' | 'terminal'>('debug');
	const [terminalVisible, setTerminalVisible] = useState(false);
	const [terminalFocusTick, setTerminalFocusTick] = useState(0);
	const [terminalHeight, setTerminalHeight] = useState(storedTerminalHeight);
	const [terminalMaximized, setTerminalMaximized] = useState(false);
	// Terminals being started per workspace, and whether to show them once they are running.
	const startingTerminals = useRef(new Map<string, { show: boolean; canFocus: () => boolean }>());
	const terminalId = workspace?.terminalId;
	const previousTerminal = useRef({ active, terminalId });
	// When a workspace's terminal goes away (its shell exited), hide the panel.
	useEffect(() => {
		const previous = previousTerminal.current;
		previousTerminal.current = { active, terminalId };
		if (previous.active === active && previous.terminalId && !terminalId) {
			setTerminalVisible(false);
			if (
				terminalVisible &&
				bottomPanel === 'terminal' &&
				document.activeElement === document.body
			) {
				focusEditor();
			}
		}
	}, [active, terminalId, terminalVisible, bottomPanel, focusEditor]);
	const hasDebugger = !!state.debug;
	const referenceVersion = state.references?.search ?? state.references?.version;
	const latestReferenceSearch = useRef({ active, referenceVersion });
	useLayoutEffect(() => {
		latestReferenceSearch.current = { active, referenceVersion };
	}, [active, referenceVersion]);
	const debugStatus = state.debug?.status;
	// Open panels when the session reports something new: references results, a debugger, or a
	// build or run starting.
	const [previous, setPrevious] = useState({
		active,
		referenceVersion,
		hasDebugger,
		debugStatus
	});
	const workspaceChanged = previous.active !== active;
	const referencesChanged = workspaceChanged || previous.referenceVersion !== referenceVersion;
	const debuggerChanged = workspaceChanged || previous.hasDebugger !== hasDebugger;
	const debugStatusChanged = workspaceChanged || previous.debugStatus !== debugStatus;
	// Apply new session signals before committing UI, while preserving a user-closed panel.
	if (referencesChanged || debuggerChanged || debugStatusChanged) {
		setPrevious({ active, referenceVersion, hasDebugger, debugStatus });
		if (referencesChanged && state.references) {
			const visible = dismissedReferences[active] !== referenceVersion;
			setReferencesVisible(visible);
			if (visible) {
				setBottomPanel('references');
				setReferencesFocusTick((value) => value + 1);
			}
		}
		if (debuggerChanged && hasDebugger) {
			setDebugVisible(true);
		}
		if (
			debugStatusChanged &&
			(debugStatus === 'building' ||
				(debugStatus === 'running' &&
					(workspaceChanged || previous.debugStatus !== 'paused')))
		) {
			setBottomPanel('debug');
			setDebugVisible(true);
		}
	}

	// Show or hide the references, remembering a closed search so it stays closed.
	const setReferencesOpen = (visible: boolean): void => {
		setReferencesVisible(visible);
		setDismissedReferences((old) => {
			if (visible) {
				if (old[active] === undefined) {
					return old;
				}
				const next = { ...old };
				delete next[active];
				return next;
			}
			if (referenceVersion === undefined || old[active] === referenceVersion) {
				return old;
			}
			return { ...old, [active]: referenceVersion };
		});
	};
	const closeReferences = (): void => {
		setReferencesOpen(false);
		focusEditor();
	};
	const closeDebugger = (): void => {
		setDebugVisible(false);
		focusEditor();
	};
	const closeTerminal = (): void => {
		const starting = startingTerminals.current.get(active);
		if (starting) {
			starting.show = false;
		}
		setTerminalVisible(false);
		setTerminalMaximized(false);
		focusEditor();
	};
	const resizeTerminal = useCallback((height: number): void => {
		const next = clampTerminalHeight(height);
		setTerminalHeight(next);
		try {
			localStorage.setItem(terminalHeightKey, String(next));
		} catch {
			// Without storage the height lasts until Nido closes.
		}
	}, []);
	const toggleTerminalMaximized = (): void => {
		if (terminalVisible && bottomPanel === 'terminal') {
			setTerminalMaximized((value) => !value);
			setTerminalFocusTick((value) => value + 1);
		}
	};
	/** Run a shell action of a terminal, then give the terminal focus again. */
	const shellAction = useCallback(
		(action: Promise<void>): void => {
			const canFocus = captureFocus();
			run(
				action.then(() => {
					if (canFocus()) {
						setTerminalFocusTick((value) => value + 1);
					}
				})
			);
		},
		[run, captureFocus]
	);
	const addShell = useCallback(
		(id: string): void => shellAction(window.nido.addTerminalShell(id, terminalShell)),
		[shellAction, terminalShell]
	);
	const selectShell = useCallback(
		(id: string, position: number): void =>
			shellAction(window.nido.selectTerminalShell(id, position)),
		[shellAction]
	);
	const closeShell = useCallback(
		(id: string, position: number): void =>
			shellAction(window.nido.closeTerminalShell(id, position)),
		[shellAction]
	);
	/** Show the terminal panel and focus it. */
	const revealTerminal = (): void => {
		setBottomPanel('terminal');
		setTerminalVisible(true);
		setTerminalFocusTick((value) => value + 1);
	};
	// Show the workspace's terminal, starting it first when it has none. A terminal workspace
	// is a terminal itself, so it only gets focus.
	const showTerminal = (): void => {
		if (!active) {
			return;
		}
		if (workspace?.kind === 'terminal') {
			focusEditor();
			return;
		}
		dismissLeader();
		if (workspace?.terminalId) {
			revealTerminal();
			return;
		}
		const owner = active;
		const pending = startingTerminals.current.get(owner);
		if (pending) {
			pending.show = true;
			pending.canFocus = captureFocus();
			return;
		}
		const request = { show: true, canFocus: captureFocus() };
		startingTerminals.current.set(owner, request);
		run(
			window.nido
				.openTerminal(owner, terminalShell)
				.then((terminal) => {
					setWorkspaces((old) =>
						old.map((w) => (w.id === owner ? { ...w, terminalId: terminal.id } : w))
					);
					if (request.show && request.canFocus()) {
						revealTerminal();
					}
				})
				.finally(() => {
					startingTerminals.current.delete(owner);
				})
		);
	};
	/** Ctrl+@: show or hide the terminal. While it starts, this toggles whether it will be shown. */
	const toggleTerminal = (): void => {
		const starting = startingTerminals.current.get(active);
		if (starting) {
			starting.show = !starting.show;
			starting.canFocus = captureFocus();
			return;
		}
		if (terminalVisible && bottomPanel === 'terminal' && workspace?.terminalId) {
			closeTerminal();
		} else {
			showTerminal();
		}
	};
	/** Restart a terminal's shell, then focus it again. */
	const restartShell = useCallback(
		(id: string): void => {
			const canFocus = captureFocus();
			run(
				window.nido.restartTerminal(id, terminalShell).then(() => {
					if (!canFocus()) {
						return;
					}
					if (id === active) {
						focusEditor();
					} else {
						setTerminalFocusTick((value) => value + 1);
					}
				})
			);
		},
		[run, terminalShell, active, focusEditor, captureFocus]
	);
	/** Show and focus the Run and Debug panel. */
	const openDebugger = (): void => {
		closeOverlay();
		setBottomPanel('debug');
		setDebugVisible(true);
		setDebugFocusTick((value) => value + 1);
	};
	/** Focus the bottom panel that is most relevant now: terminal, references or Run and Debug. */
	const showDebugger = (): void => {
		dismissLeader();
		if (
			bottomPanel === 'terminal' ||
			workspace?.kind === 'terminal' ||
			(workspace?.terminalId && !state.debug && !state.references)
		) {
			showTerminal();
		} else if (bottomPanel === 'references' && state.references) {
			setReferencesOpen(true);
			setReferencesFocusTick((value) => value + 1);
		} else {
			openDebugger();
		}
	};
	const toggleDebugger = (): void => {
		setBottomPanel('debug');
		setDebugVisible(bottomPanel !== 'debug' || !debugVisible);
	};
	const toggleReferences = (): void => {
		setBottomPanel('references');
		setReferencesOpen(bottomPanel !== 'references' || !referencesVisible);
		setReferencesFocusTick((value) => value + 1);
	};
	/** Open a reference and close its result list after the jump succeeds. */
	const openReference = (index: number): void => {
		const canFocus = captureFocus();
		run(
			window.nido.openReference(active, index, state.references!.version).then(() => {
				const latest = latestReferenceSearch.current;
				if (latest.active !== active || latest.referenceVersion !== referenceVersion) {
					return;
				}
				setReferencesOpen(false);
				if (canFocus()) {
					focusEditor();
				}
			})
		);
	};
	const debug = (action: DebugAction, target?: number): void => {
		run(window.nido.debug(active, action, target));
	};

	return {
		bottomPanel,
		debugVisible,
		debugFocusTick,
		referencesVisible,
		referencesFocusTick,
		terminalVisible,
		terminalFocusTick,
		closeReferences,
		closeDebugger,
		closeTerminal,
		toggleTerminal,
		restartShell,
		terminalHeight,
		resizeTerminal,
		terminalMaximized,
		toggleTerminalMaximized,
		addShell,
		selectShell,
		closeShell,
		openDebugger,
		showDebugger,
		toggleDebugger,
		toggleReferences,
		openReference,
		debug
	};
}

const terminalHeightKey = 'nido.terminalHeight';
const defaultTerminalHeight = 280;

/** Keep the terminal between a few rows and most of the window. */
export function clampTerminalHeight(height: number): number {
	const max = Math.max(160, (typeof window === 'undefined' ? 900 : window.innerHeight) - 200);
	return Math.round(Math.max(120, Math.min(max, height)));
}

function storedTerminalHeight(): number {
	try {
		const saved = Number(localStorage.getItem(terminalHeightKey));
		return saved > 0 ? clampTerminalHeight(saved) : defaultTerminalHeight;
	} catch {
		return defaultTerminalHeight;
	}
}
