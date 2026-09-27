import { useEffect, useRef, useState } from 'react';
import type { GitChange, GitStatus } from '../../../shared/types';
import styles from '../assets/GitPanel.module.css';

export default function GitPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus>();
  const [selected, setSelected] = useState('');
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const key = (change: GitChange): string => `${change.staged}:${change.path}`;
  const changes = [...(status?.changes || [])].sort((a, b) => Number(b.staged) - Number(a.staged));
  const current = changes.find((change) => key(change) === selected);

  async function refresh(): Promise<void> {
    const next = await window.nido.gitStatus(workspaceId);
    setStatus(next);
    setSelected((previous) =>
      next.changes.some((change) => key(change) === previous) ? previous : next.changes[0] ? key(next.changes[0]) : ''
    );
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
      setError(String(failure).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(async () => {});
    list.current?.focus();
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setDiff(current ? 'Loading diff…' : 'Select a change to preview its diff.');
    if (current) {
      window.nido
        .gitDiff(workspaceId, current.path, current.staged)
        .then((value) => {
          if (!cancelled) {
            setDiff(value || 'No textual diff (the file may have a mode change or be empty).');
          }
        })
        .catch((failure) => {
          if (!cancelled) {
            setDiff(String(failure));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selected, status]);

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
          aria-activedescendant={current ? `git-change-${changes.indexOf(current)}` : undefined}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) {
              return;
            }
            const index = changes.findIndex((change) => key(change) === selected);
            if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? changes.length - 1
                    : Math.max(
                        0,
                        Math.min(changes.length - 1, index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1))
                      );
              if (changes[next]) {
                setSelected(key(changes[next]));
              }
            } else if (event.key === 's' || event.key === 'u') {
              event.preventDefault();
              if (current && current.staged === (event.key === 'u')) {
                stage();
              }
            } else if (event.key === 'r') {
              event.preventDefault();
              void run(async () => {});
            } else if (event.key === 'c') {
              event.preventDefault();
              input.current?.focus();
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
                title={change.original ? `${change.original} → ${change.path}` : change.path}
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
        <div className={styles.preview}>
          <div className={styles.toolbar}>
            <span>{current ? `${current.staged ? 'Staged' : 'Working tree'} · ${current.path}` : 'Diff'}</span>
            <button disabled={busy || !current} onClick={stage}>
              {current?.staged ? 'Unstage (u)' : 'Stage (s)'}
            </button>
          </div>
          <pre tabIndex={0} aria-label="Git diff">
            {diff.split('\n').map((line, index) => (
              <div
                key={index}
                className={
                  line.startsWith('+')
                    ? styles.added
                    : line.startsWith('-')
                      ? styles.removed
                      : line.startsWith('@@')
                        ? styles.hunk
                        : ''
                }
              >
                {line || ' '}
              </div>
            ))}
          </pre>
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
        <button disabled={busy || !message.trim() || !changes.some((change) => change.staged)} onClick={commit}>
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
        {busy ? 'Working…' : 'j/k Select · s Stage · u Unstage · r Refresh · c Message · Esc Close'}
        <br />
        Saved files only · Changes cover the entire repository.
      </footer>
    </section>
  );
}
