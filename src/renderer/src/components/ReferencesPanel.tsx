import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReferenceList, ReferencePreview } from '../../../shared/types';
import FileIcon from './FileIcon';
import styles from '../assets/Nido.module.css';

interface Props {
    workspaceId: string;
    state: ReferenceList;
    root: string;
    visible: boolean;
    focusTick: number;
    animations: boolean;
    onClose: () => void;
    onOpen: (index: number) => void;
}

interface PreviewContent {
    key: string;
    index: number;
    item: ReferenceList['items'][number];
    data?: ReferencePreview;
    error?: string;
}

function ReferencePreviewContent({
    item,
    data,
    error,
    previous = false
}: Omit<PreviewContent, 'key' | 'index'> & { previous?: boolean }): React.JSX.Element {
    return (
        <>
            <header>
                <FileIcon path={item.path} />
                <strong title={item.path}>{item.path.replaceAll('\\', '/')}</strong>
                <span>Ln {item.line} · Enter to jump</span>
            </header>
            <div className={styles.referencePreviewCode}>
                {data ? (
                    data.lines.map((spans, index) => (
                        <div
                            key={index}
                            data-current={!previous && data.first + index === data.line}
                            data-highlight={data.first + index === data.line}
                        >
                            <span aria-hidden="true">{data.first + index}</span>
                            <code>
                                {spans.map((span, part) => (
                                    <span key={part} style={{ color: span.color }}>
                                        {span.text || ' '}
                                    </span>
                                ))}
                            </code>
                        </div>
                    ))
                ) : (
                    <p>{error || 'Loading preview…'}</p>
                )}
            </div>
        </>
    );
}

export default function ReferencesPanel({
    workspaceId,
    state,
    root,
    visible,
    focusTick,
    animations,
    onClose,
    onOpen
}: Props): React.JSX.Element {
    const list = useRef<HTMLDivElement>(null);
    const [selected, setSelected] = useState(0);
    const [focused, setFocused] = useState(false);
    const [preview, setPreview] = useState<{
        current: PreviewContent;
        previous?: PreviewContent;
    }>();
    const currentContent = useRef<HTMLDivElement>(null);
    const previousContent = useRef<HTMLDivElement>(null);
    const closePrefix = useRef(false);
    const item = state.items[selected];
    const previewKey = `${state.version}:${selected}`;
    const previewHost = document.getElementById('editor-preview-host');
    useEffect(() => {
        if (!visible || !focused || !item || state.loading) {
            setPreview(undefined);
            return;
        }
        let cancelled = false;
        const show = (data?: ReferencePreview, error?: string): void => {
            if (cancelled) {
                return;
            }
            // Keep the old preview (including its header) until the next result is ready.
            setPreview((old) => ({
                current: { key: previewKey, index: selected, item, data, error },
                previous: old?.current.key !== previewKey ? old?.current : undefined
            }));
        };
        void window.nido.previewReference(workspaceId, selected + 1, state.version).then(
            (result) => show(result),
            (error) => show(undefined, String(error))
        );
        return () => {
            cancelled = true;
        };
    }, [
        workspaceId,
        selected,
        previewKey,
        state.version,
        state.loading,
        visible,
        focused,
        item?.path,
        item?.line
    ]);
    useLayoutEffect(() => {
        if (!preview?.previous || !currentContent.current || !previousContent.current) {
            return;
        }
        const current = preview.current;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const settle = (): void => {
            setPreview((value) => (value?.current === current ? { current } : value));
        };
        if (!animations || reducedMotion.matches) {
            settle();
            return;
        }
        const direction = current.index >= preview.previous.index ? 1 : -1;
        const timing = {
            duration: 150,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
            fill: 'both'
        } as const;
        const incoming = currentContent.current.animate(
            [
                { opacity: 0, transform: `translateY(${direction * 6}px)` },
                { opacity: 1, transform: 'translateY(0)' }
            ],
            timing
        );
        const outgoing = previousContent.current.animate(
            [
                { opacity: 1, transform: 'translateY(0)' },
                { opacity: 0, transform: `translateY(${-direction * 6}px)` }
            ],
            timing
        );
        const finish = (): void => {
            incoming.cancel();
            outgoing.cancel();
            settle();
        };
        void incoming.finished.then(finish, () => {});
        reducedMotion.addEventListener('change', finish);
        return () => {
            incoming.cancel();
            outgoing.cancel();
            reducedMotion.removeEventListener('change', finish);
        };
    }, [preview, animations]);
    useEffect(() => {
        setSelected(0);
    }, [state.version]);
    useEffect(() => {
        if (visible) {
            list.current?.focus();
        }
    }, [focusTick, visible]);
    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selected, visible]);

    return (
        <section
            className={styles.referencesPanel}
            aria-label="References"
            hidden={!visible}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    closePrefix.current = false;
                    setFocused(false);
                }
            }}
            onKeyDown={(event) => {
                if (
                    event.nativeEvent.isComposing ||
                    event.ctrlKey ||
                    event.altKey ||
                    event.metaKey
                ) {
                    return;
                }
                const closing = closePrefix.current && event.key === 'd';
                closePrefix.current = event.key === ' ';
                if (closing || event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                } else if (event.key === ' ') {
                    event.preventDefault();
                }
            }}
        >
            {visible &&
                focused &&
                item &&
                !state.loading &&
                previewHost &&
                createPortal(
                    <section
                        className={styles.referencePreview}
                        aria-label="Reference preview"
                        aria-busy={preview?.current.key !== previewKey}
                    >
                        {preview?.previous && (
                            <div
                                key={preview.previous.key}
                                ref={previousContent}
                                className={styles.referencePreviewContent}
                                aria-hidden="true"
                            >
                                <ReferencePreviewContent {...preview.previous} previous />
                            </div>
                        )}
                        <div
                            key={preview?.current.key ?? 'loading'}
                            ref={currentContent}
                            className={styles.referencePreviewContent}
                        >
                            <ReferencePreviewContent {...(preview?.current ?? { item })} />
                        </div>
                    </section>,
                    previewHost
                )}
            <div className={styles.referencesToolbar}>
                <strong>
                    References <span>{state.loading ? 'Searching…' : state.items.length}</span>
                </strong>
                <span>j/k Select · Enter Jump · Ctrl+J Return · Esc / Space d Close</span>
                <button aria-label="Hide references" onClick={onClose}>
                    ×
                </button>
            </div>
            <div
                ref={list}
                className={styles.referencesList}
                role="listbox"
                aria-label="Reference results"
                tabIndex={0}
                aria-busy={state.loading}
                aria-activedescendant={state.items[selected] ? `reference-${selected}` : undefined}
                onKeyDown={(event) => {
                    if (
                        event.nativeEvent.isComposing ||
                        event.ctrlKey ||
                        event.altKey ||
                        event.metaKey
                    ) {
                        return;
                    }
                    if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault();
                        const last = Math.max(0, state.items.length - 1);
                        if (event.key === 'Home') {
                            setSelected(0);
                        } else if (event.key === 'End') {
                            setSelected(last);
                        } else {
                            const direction = ['j', 'ArrowDown'].includes(event.key) ? 1 : -1;
                            setSelected((index) => Math.max(0, Math.min(last, index + direction)));
                        }
                    } else if (event.key === 'Enter' && state.items[selected]) {
                        event.preventDefault();
                        onOpen(selected + 1);
                    }
                }}
            >
                {state.items.map((item, index) => {
                    const path = item.path.replaceAll('\\', '/');
                    const prefix = root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
                    const relative = path.toLowerCase().startsWith(prefix.toLowerCase())
                        ? path.slice(prefix.length)
                        : path;
                    return (
                        <div
                            key={`${item.path}:${item.line}:${item.column}`}
                            id={`reference-${index}`}
                            role="option"
                            aria-selected={selected === index}
                            className={styles.referenceRow}
                            onClick={() => {
                                setSelected(index);
                                list.current?.focus();
                            }}
                            onDoubleClick={() => onOpen(index + 1)}
                        >
                            <FileIcon path={item.path} />
                            <span className={styles.referencePath} title={item.path}>
                                {relative}
                            </span>
                            <span className={styles.referencePosition}>
                                {item.line}:{item.column}
                            </span>
                            <code>{item.text.trim()}</code>
                        </div>
                    );
                })}
                {state.error && <p role="alert">{state.error}</p>}
                {!state.loading && !state.error && !state.items.length && (
                    <p>No references found.</p>
                )}
            </div>
        </section>
    );
}
