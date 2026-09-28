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
  const [highlighted, setHighlighted] = useState<{ diff: string; lines: ReferencePreview['lines'][] }>();
  const [error, setError] = useState('');
  const before = useRef<HTMLPreElement>(null);
  const after = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (!path || !rows.some((row) => row.before || row.after)) {
      return;
    }
    const sources = (['before', 'after'] as const).map((side) =>
      rows.flatMap((row) => (row[side] ? [row[side].text] : [])).join('\n')
    );
    void window.nido.highlightSources(workspaceId, path, sources[0], sources[1]).then(
      (lines) => {
        if (!cancelled) {
          setHighlighted({ diff, lines });
        }
      },
      () => {
        if (!cancelled) {
          setError('Syntax highlighting unavailable');
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
            {side === 'after' && error && <span role="status">{error}</span>}
          </div>
          <pre
            ref={side === 'before' ? before : after}
            tabIndex={0}
            aria-label={side === 'before' ? `${label} original` : label}
            data-git-scroll={side}
            onScroll={(event) => {
              const other = side === 'before' ? after.current : before.current;
              if (other && Math.abs(other.scrollTop - event.currentTarget.scrollTop) > 1) {
                other.scrollTop = event.currentTarget.scrollTop;
              }
            }}
          >
            {rows.map((row, index) => (
              <div
                key={index}
                className={`${styles.diffLine} ${row.heading ? styles.hunk : row[side]?.changed ? (side === 'before' ? styles.removed : styles.added) : !row[side] ? styles.emptyLine : ''}`}
              >
                <span className={styles.lineNumber} aria-hidden="true">
                  {row[side]?.number}
                </span>
                <code>
                  {highlighted?.diff === diff && row[side]
                    ? highlighted.lines[side === 'before' ? 0 : 1][row[side].number - 1]?.map((span, column) => (
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
