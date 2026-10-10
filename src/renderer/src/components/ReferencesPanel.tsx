import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { createPortal } from 'react-dom';
import type { ReferenceList, ReferencePreview } from '../../../shared/types';
import FileIcon from './FileIcon';
import styles from '../assets/ReferencesPanel.module.css';
import OverlayPresence from './OverlayPresence';

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

const rowHeight = 30;
const overscan = 8;

function ReferencePreviewContent({
    item,
    data,
    error
}: Omit<PreviewContent, 'key' | 'index'>): React.JSX.Element {
    const t = useI18n();
    return (
        <>
            <header>
                <FileIcon path={item.path} />
                <strong title={item.path}>{item.path.replaceAll('\\', '/')}</strong>
                <span>{t('Ln {line} · Enter to jump', { line: item.line })}</span>
            </header>
            <div className={styles.referencePreviewCode}>
                {data ? (
                    data.lines.map((spans, index) => (
                        <div key={index} data-current={data.first + index === data.line}>
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
                    <p>{error || t('Loading preview…')}</p>
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
    const t = useI18n();
    const list = useRef<HTMLDivElement>(null);
    const [selected, setSelected] = useState(0);
    const [focused, setFocused] = useState(false);
    const [preview, setPreview] = useState<PreviewContent>();
    const selectionKey = `${workspaceId}:${state.version}`;
    const [viewport, setViewport] = useState({ key: selectionKey, top: 0 });
    const [height, setHeight] = useState(200);
    const top = viewport.key === selectionKey ? viewport.top : 0;
    const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const last = Math.min(state.items.length, Math.ceil((top + height) / rowHeight) + overscan);
    const indices = Array.from({ length: last - first }, (_, index) => first + index);
    if (state.items[selected] && (selected < first || selected >= last)) {
        indices.push(selected);
    }
    const [previousSelectionKey, setPreviousSelectionKey] = useState(selectionKey);
    if (selectionKey !== previousSelectionKey) {
        setPreviousSelectionKey(selectionKey);
        setSelected(0);
    }
    const currentContent = useRef<HTMLDivElement>(null);
    const displayedContent = useRef<PreviewContent | undefined>(undefined);
    const closePrefix = useRef(false);
    const item = state.items[selected];
    const previewKey = `${state.version}:${selected}`;
    const previewHost = document.getElementById('editor-preview-host');
    const previewEnabled = visible && focused && !!item;
    const [previousPreviewEnabled, setPreviousPreviewEnabled] = useState(previewEnabled);
    if (previewEnabled !== previousPreviewEnabled) {
        setPreviousPreviewEnabled(previewEnabled);
        if (!previewEnabled) {
            setPreview(undefined);
        }
    }
    useEffect(() => {
        if (!visible || !focused || !item) {
            return;
        }
        let cancelled = false;
        const show = (data?: ReferencePreview, error?: string): void => {
            if (cancelled) {
                return;
            }
            // Keep the old preview (including its header) until the next result is ready.
            setPreview({ key: previewKey, index: selected, item, data, error });
        };
        const timer = window.setTimeout(
            () =>
                void window.nido.previewReference(workspaceId, selected + 1, state.version).then(
                    (result) => show(result),
                    (error) => show(undefined, String(error))
                ),
            75
        );
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [workspaceId, selected, previewKey, state.version, state.loading, visible, focused, item]);
    useLayoutEffect(() => {
        const previous = displayedContent.current;
        displayedContent.current = preview;
        if (!preview || !previous || preview.key === previous.key || !currentContent.current) {
            return;
        }
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (!animations || reducedMotion.matches) {
            return;
        }
        const direction = preview.index >= previous.index ? 1 : -1;
        // Animate only the new content; overlapping old text creates visible ghosting.
        const incoming = currentContent.current.animate(
            [
                { opacity: 0.7, transform: `translateY(${direction * 4}px)` },
                { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: 150, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
        const finish = (): void => {
            incoming.cancel();
        };
        reducedMotion.addEventListener('change', finish);
        return () => {
            incoming.cancel();
            reducedMotion.removeEventListener('change', finish);
        };
    }, [preview, animations]);
    useEffect(() => {
        if (visible) {
            list.current?.focus();
        }
    }, [focusTick, visible]);
    useLayoutEffect(() => {
        const node = list.current;
        if (!node || !visible) {
            return;
        }
        const top = selected * rowHeight + 5;
        if (top < node.scrollTop) {
            node.scrollTop = top;
        } else if (top + rowHeight > node.scrollTop + node.clientHeight) {
            node.scrollTop = top + rowHeight - node.clientHeight;
        }
        setViewport({ key: selectionKey, top: node.scrollTop });
    }, [selected, selectionKey, visible]);
    useEffect(() => {
        const node = list.current;
        if (!node) {
            return;
        }
        const observer = new ResizeObserver(() => setHeight(node.clientHeight));
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <section
            className={styles.referencesPanel}
            data-references-panel
            aria-label={t('References')}
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
            {previewHost &&
                createPortal(
                    <OverlayPresence>
                        {previewEnabled ? (
                            <section
                                className={styles.referencePreview}
                                aria-label={t('Reference preview')}
                                aria-busy={preview?.key !== previewKey}
                            >
                                <div
                                    ref={currentContent}
                                    className={styles.referencePreviewContent}
                                >
                                    <ReferencePreviewContent {...(preview ?? { item })} />
                                </div>
                            </section>
                        ) : null}
                    </OverlayPresence>,
                    previewHost
                )}
            <div className={styles.referencesToolbar}>
                <strong>
                    {t('References')}{' '}
                    <span>{state.loading ? t('Searching…') : state.items.length}</span>
                </strong>
                <span>{t('j/k Select · Enter Jump · Ctrl+J Return · Esc / Space d Close')}</span>
                <button aria-label={t('Hide references')} onClick={onClose}>
                    ×
                </button>
            </div>
            <div
                ref={list}
                className={styles.referencesList}
                role="listbox"
                aria-label={t('Reference results')}
                data-reference-version={state.version}
                tabIndex={0}
                aria-busy={state.loading}
                onScroll={(event) =>
                    setViewport({ key: selectionKey, top: event.currentTarget.scrollTop })
                }
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
                <div style={{ height: state.items.length * rowHeight, position: 'relative' }}>
                    {indices.map((index) => {
                        const item = state.items[index];
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
                                aria-posinset={index + 1}
                                aria-setsize={state.items.length}
                                style={{
                                    position: 'absolute',
                                    top: index * rowHeight,
                                    left: 0,
                                    right: 0
                                }}
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
                </div>
                {state.error && <p role="alert">{state.error}</p>}
                {!state.loading && !state.error && !state.items.length && (
                    <p>{t('No references found.')}</p>
                )}
            </div>
        </section>
    );
}
