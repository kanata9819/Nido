import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import type { HistoryList, HistoryPreview } from '../../../shared/history';
import { useI18n } from '../i18n';
import { filename } from '../commands';
import GitDiff from './GitDiff';
import styles from '../assets/TimeMachine.module.css';

const message = (error: unknown): string =>
    String(error).replace(/^Error: (?:Error invoking remote method '[^']+': Error: )?/, '');

export default function TimeMachine({
    workspaceId,
    onClose
}: {
    workspaceId: string;
    onClose: () => void;
}): React.JSX.Element {
    const t = useI18n();
    const [data, setData] = useState<HistoryList>();
    const [selected, setSelected] = useState('');
    const [preview, setPreview] = useState<{
        list: HistoryList;
        id: string;
        value?: HistoryPreview;
        error?: string;
    }>();
    const [busy, setBusy] = useState<'list' | 'restore' | null>('list');
    const [error, setError] = useState('');
    const alive = useRef(false);
    const request = useRef(0);
    const list = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const current =
        preview && preview.list === data && preview.id === selected ? preview : undefined;
    const value = current?.value;
    const requestHistory = useCallback(
        async (generation: number): Promise<void> => {
            try {
                const result = await window.nido.history(workspaceId);
                if (!alive.current || request.current !== generation) {
                    return;
                }
                setData(result);
                // Start on the previous draft so the first view shows an actual change.
                setSelected((old) =>
                    result.versions.some((version) => version.id === old)
                        ? old
                        : result.versions[1]?.id || result.versions[0]?.id || ''
                );
            } catch (failure) {
                if (alive.current && request.current === generation) {
                    setError(message(failure));
                }
            } finally {
                if (alive.current && request.current === generation) {
                    setBusy(null);
                }
            }
        },
        [workspaceId]
    );
    const refresh = (): void => {
        setBusy('list');
        setError('');
        void requestHistory(++request.current);
    };
    useEffect(() => {
        alive.current = true;
        list.current?.focus();
        void requestHistory(++request.current);
        return () => {
            alive.current = false;
        };
    }, [requestHistory]);
    useEffect(() => {
        if (!data || !selected) {
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(
            () =>
                void window.nido.historyPreview(workspaceId, data.path, selected).then(
                    (value) => {
                        if (!cancelled) {
                            setPreview({ list: data, id: selected, value });
                        }
                    },
                    (failure) => {
                        if (!cancelled) {
                            setPreview({ list: data, id: selected, error: message(failure) });
                        }
                    }
                ),
            75
        );
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [workspaceId, data, selected]);

    const restore = async (): Promise<void> => {
        if (busy || !value || value.identical) {
            return;
        }
        setBusy('restore');
        setError('');
        try {
            await window.nido.historyRestore(
                workspaceId,
                value.path,
                value.version.id,
                value.token
            );
            if (alive.current) {
                onClose();
            }
        } catch (failure) {
            if (alive.current) {
                setError(message(failure));
            }
        } finally {
            if (alive.current) {
                setBusy(null);
            }
        }
    };
    const time = (timestamp: number): string =>
        new Date(timestamp).toLocaleString(document.documentElement.lang, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    return (
        <section
            className={styles.panel}
            ref={content}
            aria-busy={!!busy}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
                    return;
                }
                if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    void restore();
                    return;
                }
                if (event.ctrlKey && ['h', 'l'].includes(event.key.toLowerCase())) {
                    event.preventDefault();
                    if (event.key.toLowerCase() === 'h') {
                        list.current?.focus();
                    } else {
                        content.current
                            ?.querySelector<HTMLElement>('[data-git-scroll="after"]')
                            ?.focus();
                    }
                    return;
                }
                if ((event.target as HTMLElement).hasAttribute('data-git-scroll')) {
                    const pane = event.target as HTMLElement;
                    const key = event.key.toLowerCase();
                    const offset =
                        event.ctrlKey && ['d', 'u'].includes(key)
                            ? (pane.clientHeight / 2) * (key === 'd' ? 1 : -1)
                            : !event.ctrlKey && ['j', 'k'].includes(key)
                              ? 66 * (key === 'j' ? 1 : -1)
                              : 0;
                    if (offset) {
                        event.preventDefault();
                        pane.scrollBy({ top: offset, behavior: 'instant' });
                    }
                }
            }}
        >
            <header className={styles.toolbar}>
                <div>
                    <Clock3 size={18} />
                    <strong>{data ? filename(data.path) : t('Recent edits')}</strong>
                    {data && <span>{t('{count} versions', { count: data.versions.length })}</span>}
                </div>
                <button
                    onClick={() => void refresh()}
                    disabled={!!busy}
                    aria-label={t('Refresh Time Machine')}
                >
                    <RefreshCw size={15} />
                    {t('Refresh')}
                </button>
                <button
                    className={styles.restore}
                    onClick={() => void restore()}
                    disabled={!!busy || !value || value.identical}
                >
                    <RotateCcw size={15} />
                    {t('Restore to editor')}
                    <kbd>Ctrl+Enter</kbd>
                </button>
            </header>
            <div className={styles.reassurance}>
                <ShieldCheck size={15} />
                {t('Your current edits are kept before restoring. Save when ready.')}
            </div>
            {(error || current?.error) && (
                <p role="alert" className={styles.error}>
                    {t(error || current?.error || '')}
                </p>
            )}
            <div className={styles.body}>
                <div
                    className={styles.timeline}
                    role="listbox"
                    aria-label={t('Edit history')}
                    tabIndex={0}
                    aria-activedescendant={selected ? `history-${selected}` : undefined}
                    ref={list}
                    onKeyDown={(event) => {
                        if (
                            event.ctrlKey ||
                            event.altKey ||
                            event.metaKey ||
                            event.nativeEvent.isComposing ||
                            !data
                        ) {
                            return;
                        }
                        const index = data.versions.findIndex((version) => version.id === selected);
                        let next = index;
                        if (['ArrowDown', 'j'].includes(event.key)) {
                            next = Math.min(index + 1, data.versions.length - 1);
                        } else if (['ArrowUp', 'k'].includes(event.key)) {
                            next = Math.max(index - 1, 0);
                        } else if (event.key === 'Home' || event.key === 'g') {
                            next = 0;
                        } else if (event.key === 'End' || event.key === 'G') {
                            next = data.versions.length - 1;
                        } else if (event.key === 'Enter') {
                            event.preventDefault();
                            content.current
                                ?.querySelector<HTMLElement>('[data-git-scroll="after"]')
                                ?.focus();
                            return;
                        } else {
                            return;
                        }
                        event.preventDefault();
                        if (!busy && data.versions[next]) {
                            setSelected(data.versions[next].id);
                        }
                    }}
                >
                    {data?.versions.map((version, index) => (
                        <div
                            key={version.id}
                            id={`history-${version.id}`}
                            role="option"
                            aria-selected={version.id === selected}
                            data-history-version={version.id}
                            className={styles.version}
                            onClick={() => {
                                if (!busy) {
                                    setSelected(version.id);
                                }
                                list.current?.focus();
                            }}
                        >
                            <span className={styles.dot} />
                            <div>
                                <strong>
                                    {t(
                                        version.kind === 'draft'
                                            ? 'Unsaved draft'
                                            : version.kind === 'restored'
                                              ? 'Restored edit'
                                              : 'Saved content'
                                    )}
                                </strong>
                                <time dateTime={new Date(version.timestamp).toISOString()}>
                                    {time(version.timestamp)}
                                </time>
                                <small>
                                    #{data.versions.length - index} ·{' '}
                                    {t('{count} lines', { count: version.lines })} ·{' '}
                                    {(version.bytes / 1024).toFixed(1)} KB
                                </small>
                            </div>
                        </div>
                    ))}
                    {busy === 'list' && !data && <p role="status">{t('Loading history…')}</p>}
                </div>
                <div className={styles.preview}>
                    {value && !busy ? (
                        <>
                            {value.identical && (
                                <div className={styles.same}>
                                    {t('This version matches your current edits.')}
                                </div>
                            )}
                            <GitDiff
                                key={value.version.id}
                                workspaceId={workspaceId}
                                path={value.path}
                                diff={value.diff}
                                label={t('Time Machine diff')}
                                beforeLabel={time(value.version.timestamp)}
                                afterLabel={t('Current edits')}
                            />
                        </>
                    ) : (
                        <div className={styles.empty} role="status">
                            <Clock3 size={36} />
                            <p>
                                {error || current?.error
                                    ? t('Your history is still here. Refresh to try again.')
                                    : busy === 'list' || (selected && !current)
                                      ? t('Loading history…')
                                      : t(
                                            'Select a version to compare it with your current edits.'
                                        )}
                            </p>
                        </div>
                    )}
                </div>
            </div>
            <footer>
                {t(
                    'j/k Versions · Enter Preview · Ctrl+H/L History / Diff · n/N Changes · Ctrl+Enter Restore · Esc Close'
                )}
            </footer>
        </section>
    );
}
