import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { DebugAction, SessionState, TerminalShell, Workspace } from '../../../shared/types';

interface Options {
    active: string;
    workspace?: Workspace;
    state: SessionState;
    terminalShell: TerminalShell;
    setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
    focusEditor: () => void;
    dismissLeader: () => void;
    closeOverlay: () => void;
    run: (promise: Promise<unknown>) => void;
}

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
    dismissLeader,
    closeOverlay,
    run
}: Options): BottomPanels {
    const [debugVisible, setDebugVisible] = useState(false);
    const [debugFocusTick, setDebugFocusTick] = useState(0);
    const [referencesVisible, setReferencesVisible] = useState(false);
    const [referencesFocusTick, setReferencesFocusTick] = useState(0);
    const [bottomPanel, setBottomPanel] = useState<'debug' | 'references' | 'terminal'>('debug');
    const [terminalVisible, setTerminalVisible] = useState(false);
    const [terminalFocusTick, setTerminalFocusTick] = useState(0);
    const hasDebugger = !!state.debug;
    const referenceVersion = state.references?.search ?? state.references?.version;
    const debugStatus = state.debug?.status;
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
            setBottomPanel('references');
            setReferencesVisible(true);
            setReferencesFocusTick((value) => value + 1);
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

    const closeReferences = (): void => {
        setReferencesVisible(false);
        focusEditor();
    };
    const closeDebugger = (): void => {
        setDebugVisible(false);
        focusEditor();
    };
    const closeTerminal = (): void => {
        setTerminalVisible(false);
        focusEditor();
    };
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
            setBottomPanel('terminal');
            setTerminalVisible(true);
            setTerminalFocusTick((value) => value + 1);
            return;
        }
        const owner = active;
        run(
            window.nido.openTerminal(owner, terminalShell).then((terminal) => {
                setWorkspaces((old) =>
                    old.map((w) => (w.id === owner ? { ...w, terminalId: terminal.id } : w))
                );
                setBottomPanel('terminal');
                setTerminalVisible(true);
                setTerminalFocusTick((value) => value + 1);
            })
        );
    };
    const toggleTerminal = (): void => {
        if (terminalVisible && bottomPanel === 'terminal' && workspace?.kind !== 'terminal') {
            closeTerminal();
        } else {
            showTerminal();
        }
    };
    const restartShell = useCallback(
        (id: string): void => {
            run(
                window.nido.restartTerminal(id, terminalShell).then(() => {
                    if (id === active) {
                        focusEditor();
                    } else {
                        setTerminalFocusTick((value) => value + 1);
                    }
                })
            );
        },
        [run, terminalShell, active, focusEditor]
    );
    const openDebugger = (): void => {
        closeOverlay();
        setBottomPanel('debug');
        setDebugVisible(true);
        setDebugFocusTick((value) => value + 1);
    };
    const showDebugger = (): void => {
        dismissLeader();
        if (
            bottomPanel === 'terminal' ||
            workspace?.kind === 'terminal' ||
            (workspace?.terminalId && !state.debug && !state.references)
        ) {
            showTerminal();
        } else if (bottomPanel === 'references' && state.references) {
            setReferencesVisible(true);
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
        setReferencesVisible(bottomPanel !== 'references' || !referencesVisible);
        setReferencesFocusTick((value) => value + 1);
    };
    const openReference = (index: number): void => {
        run(window.nido.openReference(active, index, state.references!.version).then(focusEditor));
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
        openDebugger,
        showDebugger,
        toggleDebugger,
        toggleReferences,
        openReference,
        debug
    };
}
