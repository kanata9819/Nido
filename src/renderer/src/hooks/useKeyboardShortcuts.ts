import type { Panel, Item } from '../types';
import type { DebugAction, Workspace } from '../../../shared/types';
import { isAltGraph } from '../grid';
import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

const needsMode = (event: KeyboardEvent): boolean =>
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === ' ' || (event.shiftKey && ['H', 'L'].includes(event.key)));

interface UseKeyboardShortcutsParams {
    save: () => void;
    panel: Panel;
    leader: boolean;
    error: string;
    setError: (value: string) => void;
    setFocusTick: React.Dispatch<React.SetStateAction<number>>;
    focusEditor: () => void;
    modal: React.RefObject<HTMLDivElement | null>;
    mode: React.MutableRefObject<Record<string, string>>;
    active: string;
    workspaces: Workspace[];
    nextWorkspace: (offset: number) => void;
    showExplorer: () => void;
    showDebugger: () => void;
    closeReferences: () => void;
    toggleTerminal: () => void;
    restartShell: () => void;
    create: () => Promise<void>;
    showPanel: (value: Panel) => void;
    commands: Item[];
    state: { buffers: { id: number }[]; current: number; filetype: string };
    run: (promise: Promise<unknown>) => void;
    setLeader: (value: boolean) => void;
    activate: (id: string) => void;
}

export function useKeyboardShortcuts({
    save,
    panel,
    leader,
    error,
    setError,
    setFocusTick,
    focusEditor,
    modal,
    mode,
    active,
    workspaces,
    nextWorkspace,
    showExplorer,
    showDebugger,
    closeReferences,
    toggleTerminal,
    restartShell,
    create,
    showPanel,
    commands,
    state,
    run,
    setLeader,
    activate
}: UseKeyboardShortcutsParams): (event: KeyboardEvent) => void {
    const queued = useRef<KeyboardEvent[]>([]);
    const checkingMode = useRef(false);
    const replayed = useRef(new WeakSet<KeyboardEvent>());
    const current = useRef({ active, panel, leader, mode });
    useLayoutEffect(() => {
        current.current = { active, panel, leader, mode };
    }, [active, panel, leader, mode]);

    const keydown = (event: KeyboardEvent): void => {
        if (
            document.activeElement?.closest(
                '[data-type-information], [data-diagnostic-information], [data-explorer-commands]'
            )
        ) {
            return;
        }
        if (event.isComposing || event.keyCode === 229) {
            return;
        }
        if (isAltGraph(event) && !checkingMode.current) {
            return;
        }

        const consume = (): void => {
            event.preventDefault();
            event.stopPropagation();
        };
        const focusedInput = document.activeElement?.getAttribute('data-editor-input');
        const terminalFocused = focusedInput === 'terminal';
        // Redraw mode notifications can trail rapid input. Check the actual mode before
        // consuming text as a Normal-mode UI shortcut, retaining following keys in order.
        if (
            !replayed.current.has(event) &&
            (checkingMode.current ||
                (focusedInput === 'editor' && !panel && !leader && needsMode(event)))
        ) {
            consume();
            queued.current.push(
                new KeyboardEvent('keydown', {
                    key: event.key,
                    code: event.code,
                    location: event.location,
                    repeat: event.repeat,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    modifierAltGraph: isAltGraph(event),
                    bubbles: true,
                    cancelable: true
                })
            );
            if (!checkingMode.current) {
                checkingMode.current = true;
                run(
                    (async () => {
                        try {
                            while (queued.current.length) {
                                const next = queued.current.shift()!;
                                const context = current.current;
                                if (
                                    document.activeElement?.getAttribute('data-editor-input') ===
                                        'editor' &&
                                    !context.panel &&
                                    !context.leader &&
                                    needsMode(next)
                                ) {
                                    const actual = await window.nido.inputMode(context.active);
                                    context.mode.current[context.active] =
                                        actual === 'n'
                                            ? 'normal'
                                            : actual.startsWith('i')
                                              ? 'insert'
                                              : actual;
                                }
                                replayed.current.add(next);
                                // Commit a menu transition before handling the next buffered key.
                                flushSync(() => document.activeElement?.dispatchEvent(next));
                            }
                        } finally {
                            checkingMode.current = false;
                            queued.current.length = 0;
                        }
                    })()
                );
            }
            return;
        }
        if (isAltGraph(event)) {
            return;
        }
        const isNormalMode = (mode.current[active] || 'normal') === 'normal';
        if (
            focusedInput === 'editor' &&
            isNormalMode &&
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            ['*', '#'].includes(event.key)
        ) {
            consume();
            run(window.nido.input(active, event.key));
            return;
        }

        if (event.key === 'Escape') {
            if (panel === 'git') {
                return;
            }
            if (terminalFocused && !panel) {
                return;
            }
            if (document.activeElement?.closest('[data-references-panel]')) {
                consume();
                closeReferences();
                return;
            }
            if (error) {
                consume();
                setError('');
                setFocusTick((n) => n + 1);
                return;
            }

            if (panel || leader || focusedInput !== 'editor') {
                consume();
                focusEditor();
                return;
            }
        }
        if (
            active &&
            event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            event.key.toLowerCase() === 'm'
        ) {
            consume();
            if (panel === 'problems') {
                focusEditor();
            } else {
                showPanel('problems');
            }
            return;
        }
        if (
            active &&
            !terminalFocused &&
            state.filetype === 'markdown' &&
            event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            event.key.toLowerCase() === 'v' &&
            (!panel || panel === 'markdown')
        ) {
            consume();
            if (panel === 'markdown') {
                focusEditor();
            } else {
                showPanel('markdown');
            }
            return;
        }
        if (
            event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            event.key.toLowerCase() === 'x'
        ) {
            consume();
            if (!event.repeat) {
                if (panel === 'features') {
                    focusEditor();
                } else {
                    showPanel('features');
                }
            }
            return;
        }
        if (panel) {
            if (event.key === 'Tab' && modal.current) {
                const nodes = [
                    ...modal.current.querySelectorAll<HTMLElement>(
                        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
                    )
                ];
                const first = nodes[0];
                const last = nodes[nodes.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    consume();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    consume();
                    first?.focus();
                }
            }
            return;
        }
        if (
            active &&
            !terminalFocused &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            ['F5', 'F9', 'F10', 'F11'].includes(event.key)
        ) {
            consume();
            let action: DebugAction = 'start';
            if (event.key === 'F9') {
                action = 'breakpoint';
            } else if (event.key === 'F10') {
                action = 'over';
            } else if (event.key === 'F11') {
                action = event.shiftKey ? 'out' : 'into';
            } else if (event.shiftKey) {
                action = 'stop';
            }
            run(window.nido.debug(active, action));
            if (!document.activeElement?.closest('[data-debug-panel]')) {
                focusEditor();
            }
            return;
        }
        if (event.ctrlKey && event.key === 'Tab') {
            consume();
            nextWorkspace(event.shiftKey ? -1 : 1);
            return;
        }
        if (
            active &&
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            ['@', '`'].includes(event.key)
        ) {
            consume();
            toggleTerminal();
            return;
        }
        if (
            active &&
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey &&
            ['h', 'j', 'k', 'l'].includes(event.key.toLowerCase()) &&
            !(event.key.toLowerCase() === 'k' && focusedInput === 'editor')
        ) {
            consume();
            if (event.key.toLowerCase() === 'h') {
                showExplorer();
            } else if (event.key.toLowerCase() === 'j') {
                showDebugger();
            } else {
                focusEditor();
            }
            return;
        }
        if (event.altKey && /^[1-9]$/.test(event.key)) {
            consume();
            const w = workspaces[Number(event.key) - 1];
            if (w) {
                activate(w.id);
            }
            return;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'n') {
            consume();
            void create();
            return;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
            consume();
            showPanel('commands');
            return;
        }
        if (
            active &&
            event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            event.key.toLowerCase() === 'g'
        ) {
            consume();
            showPanel('git');
            return;
        }
        if (terminalFocused) {
            if (
                event.ctrlKey &&
                event.shiftKey &&
                !event.altKey &&
                !event.metaKey &&
                event.key.toLowerCase() === 'r'
            ) {
                consume();
                if (!event.repeat) {
                    restartShell();
                }
            }
            return;
        }
        if (
            event.ctrlKey &&
            event.key.toLowerCase() === 'p' &&
            active &&
            !mode.current[active]?.startsWith('insert')
        ) {
            consume();
            showPanel('files');
            return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === 's' && active) {
            consume();
            save();
            return;
        }
        if (leader) {
            consume();
            if (event.key === ' ') {
                showPanel('commands');
            } else {
                commands.find((command) => command.key === event.key)?.run();
            }
            return;
        }
        if (
            event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            ['H', 'L'].includes(event.key) &&
            focusedInput === 'editor' &&
            isNormalMode &&
            state.buffers.length > 0
        ) {
            consume();
            const index = state.buffers.findIndex((buffer) => buffer.id === state.current);
            const offset = event.key === 'H' ? -1 : 1;
            const next =
                state.buffers[(index + offset + state.buffers.length) % state.buffers.length];
            run(window.nido.selectBuffer(active, next.id));
            return;
        }
        if (
            event.key === ' ' &&
            !event.ctrlKey &&
            !event.altKey &&
            focusedInput === 'editor' &&
            isNormalMode
        ) {
            consume();
            setLeader(true);
        }
    };

    return keydown;
}
