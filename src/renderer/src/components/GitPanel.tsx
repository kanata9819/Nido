import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitChange, GitStatus } from '../../../shared/types';
import styles from '../assets/GitPanel.module.css';
import GitDiff from './GitDiff';

const key = (change: GitChange): string => `${change.staged}:${change.path}`;

export default function GitPanel({
    workspaceId,
    onBusyChange,
    message,
    setMessage
}: {
    workspaceId: string;
    onBusyChange?: (busy: boolean) => void;
    message: string;
    setMessage: (message: string) => void;
}): React.JSX.Element {
    const [status, setStatus] = useState<GitStatus>();
    const [selected, setSelected] = useState('');
    const [diffResult, setDiffResult] = useState<{
        workspaceId: string;
        change: GitChange;
        status: GitStatus | undefined;
        value: string;
    }>();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(true);
    const list = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const locked = useRef(false);
    const changes = [...(status?.changes || [])].sort(
        (a, b) => Number(b.staged) - Number(a.staged)
    );
    const current = changes.find((change) => key(change) === selected);

    const applyStatus = useCallback((next: GitStatus): void => {
        setStatus(next);
        setSelected((previous) => {
            if (next.changes.some((change) => key(change) === previous)) {
                return previous;
            }
            const first = next.changes[0];
            if (first) {
                return key(first);
            }
            return '';
        });
    }, []);

    async function refresh(): Promise<void> {
        applyStatus(await window.nido.gitStatus(workspaceId));
    }

    async function run(action: () => Promise<unknown>): Promise<void> {
        if (locked.current) {
            return;
        }
        locked.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await action();
            await refresh();
        } catch (failure) {
            setError(
                String(failure).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
            );
        } finally {
            locked.current = false;
            setBusy(false);
        }
    }

    useEffect(() => {
        onBusyChange?.(busy);
    }, [busy, onBusyChange]);

    useEffect(() => {
        let cancelled = false;
        locked.current = true;
        void window.nido
            .gitStatus(workspaceId)
            .then(
                (next) => {
                    if (!cancelled) {
                        applyStatus(next);
                    }
                },
                (failure) => {
                    if (!cancelled) {
                        setError(
                            String(failure).replace(
                                /^Error: Error invoking remote method '[^']+': Error: /,
                                ''
                            )
                        );
                    }
                }
            )
            .finally(() => {
                if (!cancelled) {
                    locked.current = false;
                    setBusy(false);
                }
            });
        list.current?.focus();
        return () => {
            cancelled = true;
        };
    }, [workspaceId, applyStatus]);

    const diff = !current
        ? 'Select a change to preview its diff.'
        : diffResult?.workspaceId === workspaceId &&
            diffResult.change === current &&
            diffResult.status === status
          ? diffResult.value
          : 'Loading diff…';
    useEffect(() => {
        let cancelled = false;
        if (current) {
            window.nido
                .gitDiff(workspaceId, current.path, current.staged)
                .then((value) => {
                    if (!cancelled) {
                        setDiffResult({
                            workspaceId,
                            change: current,
                            status,
                            value:
                                value ||
                                'No textual diff (the file may have a mode change or be empty).'
                        });
                    }
                })
                .catch((failure) => {
                    if (!cancelled) {
                        setDiffResult({
                            workspaceId,
                            change: current,
                            status,
                            value: String(failure)
                        });
                    }
                });
        }
        return () => {
            cancelled = true;
        };
    }, [workspaceId, current, status]);

    function stage(): void {
        if (current) {
            void run(() => window.nido.gitStage(workspaceId, current.path, current.staged));
        }
    }

    function commit(): void {
        if (!message.trim() || !changes.some((change) => change.staged)) {
            return;
        }
        void run(async () => {
            const result = await window.nido.gitCommit(workspaceId, message);
            setMessage('');
            setNotice(result);
        });
    }

    function stageAll(): void {
        if (changes.some((change) => !change.staged)) {
            void run(() => window.nido.gitStageAll(workspaceId));
        }
    }

    return (
        <section
            className={styles.panel}
            aria-label="Git changes"
            aria-busy={busy}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                    return;
                }
                if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }
            }}
        >
            <div className={styles.toolbar}>
                <strong>{status?.branch || 'Source control'}</strong>
                <span title={status?.root}>{status?.root}</span>
                <button
                    disabled={busy || !changes.some((change) => !change.staged)}
                    onClick={stageAll}
                >
                    Stage all (S)
                </button>
                <button disabled={busy} onClick={() => void run(async () => {})}>
                    Refresh
                </button>
            </div>
            <div className={styles.content}>
                <div
                    ref={list}
                    className={styles.list}
                    role="listbox"
                    aria-label="Changed files"
                    tabIndex={0}
                    aria-activedescendant={
                        current ? `git-change-${changes.indexOf(current)}` : undefined
                    }
                    onKeyDown={(event) => {
                        if (
                            event.ctrlKey ||
                            event.altKey ||
                            event.metaKey ||
                            event.nativeEvent.isComposing
                        ) {
                            return;
                        }
                        const index = changes.findIndex((change) => key(change) === selected);
                        const commandKey = event.shiftKey && event.key === 's' ? 'S' : event.key;
                        switch (commandKey) {
                            case 'S': {
                                event.preventDefault();
                                stageAll();
                                break;
                            }
                            case 'j':
                            case 'k':
                            case 'ArrowDown':
                            case 'ArrowUp':
                            case 'Home':
                            case 'End': {
                                event.preventDefault();
                                const next =
                                    event.key === 'Home'
                                        ? 0
                                        : event.key === 'End'
                                          ? changes.length - 1
                                          : Math.max(
                                                0,
                                                Math.min(
                                                    changes.length - 1,
                                                    index +
                                                        (['j', 'ArrowDown'].includes(event.key)
                                                            ? 1
                                                            : -1)
                                                )
                                            );
                                if (changes[next]) {
                                    setSelected(key(changes[next]));
                                }
                                break;
                            }
                            case 's':
                            case 'u': {
                                event.preventDefault();
                                if (current && current.staged === (event.key === 'u')) {
                                    stage();
                                }
                                break;
                            }
                            case 'r': {
                                event.preventDefault();
                                void run(async () => {});
                                break;
                            }
                            case 'c': {
                                event.preventDefault();
                                input.current?.focus();
                                break;
                            }
                        }
                    }}
                >
                    {changes.map((change, index) => (
                        <div key={key(change)}>
                            {(index === 0 || changes[index - 1].staged !== change.staged) && (
                                <h3>{change.staged ? 'Staged changes' : 'Changes'}</h3>
                            )}
                            <div
                                id={`git-change-${index}`}
                                role="option"
                                aria-selected={key(change) === selected}
                                className={styles.change}
                                title={
                                    change.original
                                        ? `${change.original} → ${change.path}`
                                        : change.path
                                }
                                ref={(node) => {
                                    if (node && key(change) === selected) {
                                        node.scrollIntoView({ block: 'nearest' });
                                    }
                                }}
                                onClick={() => {
                                    setSelected(key(change));
                                    list.current?.focus();
                                }}
                            >
                                <b>{change.status}</b>
                                <span>{change.path}</span>
                            </div>
                        </div>
                    ))}
                    {status && !changes.length && <p>Working tree clean.</p>}
                </div>
                <div className={styles.preview} data-git-preview>
                    <div className={styles.toolbar}>
                        <span>
                            {current
                                ? `${current.staged ? 'Staged' : 'Working tree'} · ${current.path}`
                                : 'Diff'}
                        </span>
                        <button disabled={busy || !current} onClick={stage}>
                            {current?.staged ? 'Unstage (u)' : 'Stage (s)'}
                        </button>
                    </div>
                    <GitDiff
                        key={selected}
                        workspaceId={workspaceId}
                        path={current?.path || ''}
                        diff={diff}
                        label="Git diff"
                        beforeLabel={current?.staged ? 'HEAD' : 'Index'}
                        afterLabel={current?.staged ? 'Index · Staged' : 'Working tree'}
                    />
                </div>
            </div>
            <div className={styles.commit}>
                <textarea
                    ref={input}
                    aria-label="Commit message"
                    placeholder="Commit message"
                    maxLength={10000}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                />
                <button
                    disabled={busy || !message.trim() || !changes.some((change) => change.staged)}
                    onClick={commit}
                >
                    Commit staged
                    <br />
                    <small>Ctrl+Enter</small>
                </button>
            </div>
            {error && (
                <p className={styles.error} role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <pre className={styles.notice} role="status">
                    {notice}
                </pre>
            )}
            <footer>
                {busy
                    ? 'Working…'
                    : 'j/k Select · s Stage · S Stage all · u Unstage · r Refresh · c Message · Esc Close'}
                <br />
                Ctrl+H/L List / Diff · j/k Scroll diff · Ctrl+D/U Half page · Ctrl+F/B Page · g/G
                Top / Bottom · n/N Next / Previous change
                <br />
                Saved files only · Changes cover the entire repository.
            </footer>
        </section>
    );
}
