import { useEffect, useRef, useState } from 'react';
import type { GitBranchEntry, GitCommitEntry } from '../../../shared/types';
import GitPanel from './GitPanel';
import GitBrowserList from './GitBrowserList';
import { CommitDetails, BranchDetails } from './GitDetails';
import { useGitBrowserKeyboard } from '../hooks/useGitBrowserKeyboard';
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
            setError(
                String(failure).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
            );
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
        labels = branches.map(
            (branch) =>
                `${branch.current ? '● ' : ''}${branch.remote ? '[remote] ' : ''}${branch.name}`
        );
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

    useGitBrowserKeyboard({ busy, back, changeView });

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
                <GitPanel
                    workspaceId={workspaceId}
                    onBusyChange={setBusy}
                    message={message}
                    setMessage={setMessage}
                />
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
                        <GitBrowserList
                            view={view}
                            busy={busy}
                            commit={commit}
                            history={history}
                            branches={branches}
                            labels={labels}
                            listLabel={listLabel}
                            index={index}
                            setIndex={setIndex}
                            listRef={list}
                            open={open}
                            setCreating={setCreating}
                        />
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
                                <CommitDetails entry={history[index]} busy={busy} open={open} />
                            ) : view === 2 && branches[index] ? (
                                <BranchDetails entry={branches[index]} busy={busy} open={open} />
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
                            <button
                                disabled={busy}
                                onClick={() => void run(() => loadHistory(true))}
                            >
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
                        1/2/3 Views · Ctrl+H/L List / Diff · j/k Select / Scroll · Ctrl+D/U Half
                        page · Ctrl+F/B Page · g/G Top / Bottom · n/N Next / Previous change · Tab
                        Move focus · Esc Back / Close
                    </footer>
                </section>
            )}
        </div>
    );
}
