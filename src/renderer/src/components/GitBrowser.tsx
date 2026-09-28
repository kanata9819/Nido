import { useEffect, useRef, useState } from 'react';
import type { GitBranchEntry, GitCommitEntry } from '../../../shared/types';
import GitPanel from './GitPanel';
import GitDiff from './GitDiff';
import styles from '../assets/GitPanel.module.css';

export default function GitBrowser({
  workspaceId,
  onClose
}: {
  workspaceId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [view, setView] = useState(0);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<GitCommitEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [commit, setCommit] = useState<GitCommitEntry>();
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [diff, setDiff] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [branchName, setBranchName] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const branchInput = useRef<HTMLInputElement>(null);
  const locked = useRef(false);

  async function run(action: () => Promise<void>): Promise<void> {
    if (locked.current) {
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(String(failure).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function loadHistory(append = false): Promise<void> {
    const entries = await window.nido.gitHistory(workspaceId, append ? history.length : 0);
    setHistory(append ? [...history, ...entries] : entries);
    setMore(entries.length === 100);
  }

  useEffect(() => {
    if (creating) {
      branchInput.current?.focus();
    }
  }, [creating]);

  useEffect(() => {
    if (view === 0) {
      return;
    }
    void run(async () => {
      setBranchName((await window.nido.gitStatus(workspaceId)).branch);
      if (view === 1) {
        await loadHistory();
      } else {
        setBranches(await window.nido.gitBranches(workspaceId));
      }
    });
    list.current?.focus();
  }, [view, revision]);

  const path = files[index];
  useEffect(() => {
    let cancelled = false;
    if (!commit || !path) {
      setDiff('Select a commit and press Enter to browse its changed files.');
      return;
    }
    setDiff('Loading diff…');
    window.nido
      .gitCommitDiff(workspaceId, commit.hash, path)
      .then((value) => {
        if (!cancelled) {
          setDiff(value || 'No textual changes.');
        }
      })
      .catch((failure) => {
        if (!cancelled) {
          setDiff(String(failure));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commit, path]);

  function back(): void {
    if (creating) {
      setCreating(false);
    } else if (commit) {
      setIndex(
        Math.max(
          0,
          history.findIndex((entry) => entry.hash === commit.hash)
        )
      );
      setCommit(undefined);
      setFiles([]);
    } else {
      onClose();
      return;
    }
    list.current?.focus();
  }

  function changeView(next: number): void {
    if (busy) {
      return;
    }
    setView(next);
    setCommit(undefined);
    setFiles([]);
    setIndex(0);
    setCreating(false);
    setError('');
  }

  function switchBranch(branch: string, create: boolean): void {
    void run(async () => {
      await window.nido.gitSwitch(workspaceId, branch, create);
      setCreating(false);
      setName('');
      setBranches(await window.nido.gitBranches(workspaceId));
      setBranchName((await window.nido.gitStatus(workspaceId)).branch);
      list.current?.focus();
    });
  }

  function open(): void {
    if (view === 2 && branches[index]) {
      const branch = branches[index];
      switchBranch(`refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`, false);
    } else if (view === 1 && !commit && history[index]) {
      const entry = history[index];
      void run(async () => {
        const paths = await window.nido.gitCommitFiles(workspaceId, entry.hash);
        setCommit(entry);
        setFiles(paths);
        setIndex(0);
        list.current?.focus();
      });
    }
  }

  let labels: string[];
  if (view === 2) {
    labels = branches.map((branch) => `${branch.current ? '● ' : ''}${branch.remote ? '[remote] ' : ''}${branch.name}`);
  } else if (commit) {
    labels = files;
  } else {
    labels = history.map((entry) => `${entry.hash.slice(0, 8)}  ${entry.subject}`);
  }
  let listLabel = 'Commit history';
  if (view === 2) {
    listLabel = 'Branches';
  } else if (commit) {
    listLabel = 'Commit files';
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) {
          back();
        }
        return;
      }
      if (!(event.target as HTMLElement).closest('[aria-label="git palette"]')) {
        return;
      }
      const editing = (event.target as HTMLElement).matches('input, textarea, [contenteditable="true"]');
      if (editing || event.altKey || event.metaKey) {
        return;
      }
      const target = event.target as HTMLElement;
      const dialog = target.closest('[aria-label="git palette"]');
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.shiftKey && (key === 'h' || key === 'l')) {
        event.preventDefault();
        const selector =
          key === 'h' ? '[role="listbox"]' : '[data-git-scroll="after"], [data-git-preview] > [tabindex]';
        dialog?.querySelector<HTMLElement>(selector)?.focus();
        return;
      }
      const preview = target.closest<HTMLElement>('[data-git-preview] pre, [data-git-summary]');
      if (preview) {
        const line = parseFloat(getComputedStyle(preview).lineHeight) || 20;
        let vertical = 0;
        let horizontal = 0;
        if (event.ctrlKey && !event.shiftKey) {
          if (key === 'd' || key === 'u') {
            vertical = (preview.clientHeight / 2) * (key === 'd' ? 1 : -1);
          } else if (key === 'f' || key === 'b') {
            vertical = preview.clientHeight * (key === 'f' ? 1 : -1);
          }
        } else if (!event.ctrlKey) {
          if (event.key === 'j' || event.key === 'k') {
            vertical = line * (event.key === 'j' ? 1 : -1);
          } else if (event.key === 'h' || event.key === 'l') {
            horizontal = line * (event.key === 'l' ? 1 : -1);
          } else if (key === 'g') {
            event.preventDefault();
            preview.scrollTo({
              top: event.shiftKey || event.key === 'G' ? preview.scrollHeight : 0,
              behavior: 'instant'
            });
            return;
          }
        }
        if (vertical || horizontal) {
          event.preventDefault();
          preview.scrollBy({ top: vertical, left: horizontal, behavior: 'instant' });
          return;
        }
      }
      if (!editing && !event.ctrlKey && !event.altKey && !event.metaKey && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        changeView(Number(event.key) - 1);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  });

  return (
    <div className={styles.panel}>
      <nav className={styles.toolbar} aria-label="Git views">
        {['Changes', 'History', 'Branches'].map((title, tab) => (
          <button
            key={title}
            disabled={busy}
            aria-current={view === tab ? 'page' : undefined}
            onClick={() => changeView(tab)}
          >
            {tab + 1} {title}
          </button>
        ))}
      </nav>
      {view === 0 ? (
        <GitPanel workspaceId={workspaceId} onBusyChange={setBusy} message={message} setMessage={setMessage} />
      ) : (
        <section aria-label="Git browser" aria-busy={busy}>
          <div className={styles.toolbar}>
            <strong>{branchName}</strong>
            <span>
              {commit
                ? `${commit.hash.slice(0, 8)} · ${commit.subject} · Compared with first parent`
                : view === 1
                  ? 'History of the current branch'
                  : 'Local and remote-tracking branches'}
            </span>
            {commit && (
              <button disabled={busy} onClick={back}>
                Back (Esc)
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => {
                setCommit(undefined);
                setFiles([]);
                setIndex(0);
                setRevision((value) => value + 1);
              }}
            >
              Refresh
            </button>
          </div>
          <div className={styles.content}>
            <div
              className={`${styles.list} ${view === 2 || (view === 1 && !commit) ? styles.historyList : ''}`}
              ref={list}
              role="listbox"
              aria-label={listLabel}
              tabIndex={0}
              aria-activedescendant={labels[index] ? `git-entry-${index}` : undefined}
              onKeyDown={(event) => {
                if (busy || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) {
                  return;
                }
                if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  let next = index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1);
                  if (event.key === 'Home') {
                    next = 0;
                  }
                  if (event.key === 'End') {
                    next = labels.length - 1;
                  }
                  setIndex(Math.max(0, Math.min(labels.length - 1, next)));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  open();
                } else if (view === 2 && event.key === 'n') {
                  event.preventDefault();
                  setCreating(true);
                }
              }}
            >
              {labels.map((label, position) => (
                <div
                  key={label}
                  id={`git-entry-${position}`}
                  role="option"
                  aria-selected={index === position}
                  className={`${styles.change} ${view === 2 || (view === 1 && !commit) ? styles.historyEntry : ''}`}
                  title={label}
                  ref={(node) => {
                    if (node && index === position) {
                      node.scrollIntoView({ block: 'nearest' });
                    }
                  }}
                  onClick={() => {
                    setIndex(position);
                    list.current?.focus();
                  }}
                  onDoubleClick={open}
                >
                  {view === 1 && !commit ? (
                    <>
                      <strong className={styles.commitSubject}>{history[position].subject}</strong>
                      <div className={styles.commitMeta}>
                        <code className={styles.hashBadge}>{history[position].hash.slice(0, 8)}</code>
                        <span>{history[position].author}</span>
                      </div>
                    </>
                  ) : view === 2 ? (
                    <>
                      <strong className={styles.commitSubject}>{branches[position].name}</strong>
                      <div className={styles.commitMeta}>
                        <span className={styles.branchBadge}>{branches[position].remote ? 'Remote' : 'Local'}</span>
                        {branches[position].current && <span className={styles.currentBadge}>Current</span>}
                      </div>
                    </>
                  ) : (
                    <span>{label}</span>
                  )}
                </div>
              ))}
              {!labels.length && !busy && (
                <p>
                  {commit
                    ? 'No changed files.'
                    : view === 1
                      ? 'No commits yet.'
                      : 'No branches yet. Press n to create one.'}
                </p>
              )}
            </div>
            <div className={styles.preview} data-git-preview>
              {view === 1 && commit ? (
                <GitDiff
                  key={`${commit.hash}:${path}`}
                  workspaceId={workspaceId}
                  path={path}
                  diff={diff}
                  label="Commit diff"
                  beforeLabel="First parent"
                  afterLabel={commit.hash.slice(0, 8)}
                />
              ) : view === 1 && history[index] ? (
                <section className={styles.commitSummary} data-git-summary tabIndex={0} aria-label="Commit details">
                  <span className={styles.summaryLabel}>COMMIT</span>
                  <h2>{history[index].subject}</h2>
                  <dl className={styles.commitDetails}>
                    <div>
                      <dt>Author</dt>
                      <dd>{history[index].author}</dd>
                    </div>
                    <div>
                      <dt>Committed</dt>
                      <dd>
                        <time dateTime={history[index].date}>
                          {new Date(history[index].date).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short'
                          })}
                        </time>
                      </dd>
                    </div>
                    <div>
                      <dt>Hash</dt>
                      <dd>
                        <code>{history[index].hash}</code>
                      </dd>
                    </div>
                  </dl>
                  <button disabled={busy} onClick={open}>
                    Browse changed files <kbd>Enter</kbd>
                  </button>
                </section>
              ) : view === 2 && branches[index] ? (
                <section className={styles.commitSummary} data-git-summary tabIndex={0} aria-label="Branch details">
                  <span className={styles.summaryLabel}>BRANCH</span>
                  <h2>{branches[index].name}</h2>
                  <dl className={styles.commitDetails}>
                    <div>
                      <dt>Type</dt>
                      <dd>{branches[index].remote ? 'Remote-tracking branch' : 'Local branch'}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{branches[index].current ? 'Currently checked out' : 'Available to switch'}</dd>
                    </div>
                    <div>
                      <dt>On switch</dt>
                      <dd>
                        {branches[index].remote
                          ? 'Create a local branch that tracks this remote branch.'
                          : 'Check out this branch in the workspace.'}
                      </dd>
                    </div>
                  </dl>
                  <p className={styles.summaryHint}>
                    {branches[index].current
                      ? 'You are already working on this branch.'
                      : 'Switch to this branch to continue working on it.'}
                  </p>
                  <button disabled={busy || branches[index].current} onClick={open}>
                    Switch branch <kbd>Enter</kbd>
                  </button>
                </section>
              ) : (
                <pre tabIndex={0} />
              )}
            </div>
          </div>
          <div className={styles.toolbar}>
            {!commit && (
              <button disabled={busy || !labels.length} onClick={open}>
                {view === 1 ? 'Open commit (Enter)' : 'Switch branch (Enter)'}
              </button>
            )}
            {view === 1 && !commit && more && (
              <button disabled={busy} onClick={() => void run(() => loadHistory(true))}>
                Load older commits
              </button>
            )}
            {view === 2 && (
              <button disabled={busy} onClick={() => setCreating(true)}>
                New branch (n)
              </button>
            )}
          </div>
          {creating && (
            <form
              className={styles.commit}
              onSubmit={(event) => {
                event.preventDefault();
                switchBranch(name, true);
              }}
            >
              <input
                ref={branchInput}
                autoFocus
                aria-label="New branch name"
                placeholder="New branch name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button disabled={busy || !name.trim()} type="submit">
                Create and switch
              </button>
            </form>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <footer>
            1/2/3 Views · Ctrl+H/L List / Diff · j/k Select / Scroll · Ctrl+D/U Half page · Ctrl+F/B Page · g/G Top /
            Bottom · n/N Next / Previous change · Tab Move focus · Esc Back / Close
          </footer>
        </section>
      )}
    </div>
  );
}
