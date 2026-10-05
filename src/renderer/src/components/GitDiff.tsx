import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReferencePreview } from '../../../shared/types';
import { splitDiff } from '../gitDiff';
import styles from '../assets/GitPanel.module.css';

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
    const rows = useMemo(() => splitDiff(diff), [diff]);
    const changes = rows.flatMap((row, index) =>
        (row.before?.changed || row.after?.changed) &&
        !(rows[index - 1]?.before?.changed || rows[index - 1]?.after?.changed)
            ? [index]
            : []
    );
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
        let cancelled = false;
        if (!path || !rows.some((row) => row.before || row.after)) {
            return;
        }
        const sources = (['before', 'after'] as const).map((side) =>
            rows.flatMap((row) => (row[side] ? [row[side].text] : [])).join('\n')
        );
        void window.nido.highlightSources(workspaceId, path, sources[0], sources[1]).then(
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
    }, [workspaceId, path, diff, rows]);
    return (
        <div className={styles.splitDiff}>
            {(['before', 'after'] as const).map((side) => (
                <div key={side} className={styles.diffPane}>
                    <div className={styles.diffHeading}>
                        <strong>{side === 'before' ? 'Before' : 'After'}</strong>
                        <span>{side === 'before' ? beforeLabel : afterLabel}</span>
                        {side === 'after' && changes.length > 0 && (
                            <span>
                                {activeChange < 0
                                    ? `${changes.length} changes`
                                    : `Change ${activeChange + 1} / ${changes.length}`}{' '}
                                · n / N
                            </span>
                        )}
                        {side === 'after' && error && <span role="status">{error}</span>}
                    </div>
                    <pre
                        ref={side === 'before' ? before : after}
                        tabIndex={0}
                        aria-label={side === 'before' ? `${label} original` : label}
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
                            const preview = event.currentTarget;
                            const target = preview.children[row] as HTMLElement;
                            const top =
                                target.getBoundingClientRect().top -
                                preview.getBoundingClientRect().top +
                                preview.scrollTop;
                            for (const pane of [before.current, after.current]) {
                                pane?.scrollTo({ top, behavior: 'instant' });
                            }
                        }}
                        onScroll={(event) => {
                            const other = side === 'before' ? after.current : before.current;
                            if (
                                other &&
                                Math.abs(other.scrollTop - event.currentTarget.scrollTop) > 1
                            ) {
                                other.scrollTop = event.currentTarget.scrollTop;
                            }
                        }}
                    >
                        {rows.map((row, index) => (
                            <div
                                key={index}
                                data-diff-active={
                                    selectedChange?.diff === diff && selectedChange.row === index
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
                                        ? currentHighlight.lines[side === 'before' ? 0 : 1][
                                              row[side].number - 1
                                          ]?.map((span, column) => (
                                              <span key={column} style={{ color: span.color }}>
                                                  {span.text || ' '}
                                              </span>
                                          )) ||
                                          row[side].text ||
                                          ' '
                                        : row.heading || row[side]?.text || ' '}
                                </code>
                            </div>
                        ))}
                    </pre>
                </div>
            ))}
        </div>
    );
}
