import { useEffect, useRef, useState } from 'react';
import type { SessionState, Workspace } from '../../../shared/types';

export function useWorkspaceSessions(report: (message: string) => void) {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [selectedWorkspace, setActive] = useState('');
    const [states, setStates] = useState<Record<string, SessionState>>({});
    const [restoring, setRestoring] = useState(true);
    const mode = useRef<Record<string, string>>({});
    const active = workspaces.some((w) => w.id === selectedWorkspace)
        ? selectedWorkspace
        : workspaces[0]?.id || '';

    useEffect(
        () =>
            window.nido.onEvent((event) => {
                switch (event.type) {
                    case 'state': {
                        setStates((old) => ({ ...old, [event.id]: event.state }));
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
            }),
        [report]
    );

    useEffect(() => {
        let cancelled = false;
        void window.nido
            .restoreWorkspaces()
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
