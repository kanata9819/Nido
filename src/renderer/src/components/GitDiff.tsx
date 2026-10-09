import { useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReferencePreview } from '../../../shared/types';
import { splitDiff } from '../gitDiff';
import styles from '../assets/GitPanel.module.css';

const rowHeight = 22;
const overscan = 20;

export default function GitDiff({
    workspaceId,
    path,
    diff,
    label,
    beforeLabel,
    afterLabel
}: {
    workspaceId: string;
    path: string;
    diff: string;
    label: string;
    beforeLabel: string;
    afterLabel: string;
}): React.JSX.Element {
    const t = useI18n();
    const rows = useMemo(() => splitDiff(diff), [diff]);
    const sources = useMemo(
        () =>
            (['before', 'after'] as const).map((side) => {
                const lines: string[] = [];
                const positions = rows.map((row) => {
                    if (!row[side]) {
                        return -1;
                    }
                    lines.push(row[side].text);
                    return lines.length - 1;
                });
                return { text: lines.join('\n'), positions };
            }),
        [rows]
    );
    const changes = useMemo(
        () =>
            rows.flatMap((row, index) =>
                (row.before?.changed || row.after?.changed) &&
                !(rows[index - 1]?.before?.changed || rows[index - 1]?.after?.changed)
                    ? [index]
                    : []
            ),
        [rows]
    );
    const width = useMemo(
        () =>
            rows.reduce(
                (max, row) =>
                    Math.max(
                        max,
                        row.before?.text.length || 0,
                        row.after?.text.length || 0,
                        row.heading?.length || 0
                    ),
                0
            ),
        [rows]
    );
    const [viewport, setViewport] = useState({ diff, row: 0 });
    const [height, setHeight] = useState(600);
    const topRow = viewport.diff === diff ? viewport.row : 0;
    const first = Math.max(0, topRow - overscan);
    const last = Math.min(rows.length, topRow + Math.ceil(height / rowHeight) + overscan);
    const visible = rows.slice(first, last);
    const [selectedChange, setSelectedChange] = useState<{ diff: string; row: number }>();
    const activeChange = selectedChange?.diff === diff ? changes.indexOf(selectedChange.row) : -1;
    const [highlighted, setHighlighted] = useState<{
        workspaceId: string;
        path: string;
        diff: string;
        lines?: ReferencePreview['lines'][];
        error?: string;
    }>();
    const currentHighlight =
        highlighted?.workspaceId === workspaceId &&
        highlighted.path === path &&
        highlighted.diff === diff
            ? highlighted
            : undefined;
    const error = currentHighlight?.error || '';
    const before = useRef<HTMLPreElement>(null);
    const after = useRef<HTMLPreElement>(null);
    useEffect(() => {
        const pane = after.current;
        if (!pane) {
            return;
        }
        const observer = new ResizeObserver(() => setHeight(pane.clientHeight));
        observer.observe(pane);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        before.current?.scrollTo({ top: 0, left: 0 });
        after.current?.scrollTo({ top: 0, left: 0 });
    }, [diff]);
    useEffect(() => {
        let cancelled = false;
        if (!path || !rows.some((row) => row.before || row.after)) {
            return;
        }
        void window.nido.highlightSources(workspaceId, path, sources[0].text, sources[1].text).then(
            (lines) => {
                if (!cancelled) {
                    setHighlighted({ workspaceId, path, diff, lines });
                }
            },
            () => {
                if (!cancelled) {
                    setHighlighted({
                        workspaceId,
                        path,
                        diff,
                        error: 'Syntax highlighting unavailable'
                    });
                }
            }
        );
        return () => {
            cancelled = true;
        };
    }, [workspaceId, path, diff, rows, sources]);
    return (
        <div className={styles.splitDiff}>
            {(['before', 'after'] as const).map((side) => (
                <div key={side} className={styles.diffPane}>
                    <div className={styles.diffHeading}>
                        <strong>{side === 'before' ? t('Before') : t('After')}</strong>
                        <span>{side === 'before' ? beforeLabel : afterLabel}</span>
                        {side === 'after' && changes.length > 0 && (
                            <span>
                                {activeChange < 0
                                    ? t('{count} changes', { count: changes.length })
                                    : t('Change {current} / {total}', {
                                          current: activeChange + 1,
                                          total: changes.length
                                      })}{' '}
                                · n / N
                            </span>
                        )}
                        {side === 'after' && error && <span role="status">{t(error)}</span>}
                    </div>
                    <pre
                        ref={side === 'before' ? before : after}
                        tabIndex={0}
                        aria-label={side === 'before' ? t('{label} original', { label }) : label}
                        data-git-scroll={side}
                        onKeyDown={(event) => {
                            if (
                                event.ctrlKey ||
                                event.altKey ||
                                event.metaKey ||
                                event.nativeEvent.isComposing ||
                                !['n', 'N'].includes(event.key)
                            ) {
                                return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            if (!changes.length) {
                                return;
                            }
                            const direction = event.shiftKey || event.key === 'N' ? -1 : 1;
                            const next =
                                activeChange < 0
                                    ? direction === 1
                                        ? 0
                                        : changes.length - 1
                                    : (activeChange + direction + changes.length) % changes.length;
                            const row = changes[next];
                            setSelectedChange({ diff, row });
                            const top = row * rowHeight;
                            setViewport({ diff, row });
                            for (const pane of [before.current, after.current]) {
                                pane?.scrollTo({ top, behavior: 'instant' });
                            }
                        }}
                        onScroll={(event) => {
                            const row = Math.floor(event.currentTarget.scrollTop / rowHeight);
                            setViewport((old) =>
                                old.diff === diff && old.row === row ? old : { diff, row }
                            );
                            const other = side === 'before' ? after.current : before.current;
                            if (
                                other &&
                                Math.abs(other.scrollTop - event.currentTarget.scrollTop) > 1
                            ) {
                                other.scrollTop = event.currentTarget.scrollTop;
                            }
                        }}
                    >
                        <div
                            style={{
                                height: rows.length * rowHeight,
                                minWidth: `calc(${width}ch + 90px)`,
                                paddingTop: first * rowHeight
                            }}
                        >
                            {visible.map((row, offset) => {
                                const index = first + offset;
                                return (
                                    <div
                                        key={index}
                                        data-diff-row={index}
                                        data-diff-active={
                                            selectedChange?.diff === diff &&
                                            selectedChange.row === index
                                                ? 'true'
                                                : undefined
                                        }
                                        className={`${styles.diffLine} ${row.heading ? styles.hunk : row[side]?.changed ? (side === 'before' ? styles.removed : styles.added) : !row[side] ? styles.emptyLine : ''}`}
                                    >
                                        <span className={styles.lineNumber} aria-hidden="true">
                                            {row[side]?.number}
                                        </span>
                                        <code>
                                            {currentHighlight?.lines && row[side]
                                                ? currentHighlight.lines[
                                                      side === 'before' ? 0 : 1
                                                  ]?.[
                                                      sources[side === 'before' ? 0 : 1].positions[
                                                          index
                                                      ]
                                                  ]?.map((span, column) => (
                                                      <span
                                                          key={column}
                                                          style={{ color: span.color }}
                                                      >
                                                          {span.text || ' '}
                                                      </span>
                                                  )) ||
                                                  row[side].text ||
                                                  ' '
                                                : row.heading || row[side]?.text || ' '}
                                        </code>
                                    </div>
                                );
                            })}
                        </div>
                    </pre>
                </div>
            ))}
        </div>
    );
}
