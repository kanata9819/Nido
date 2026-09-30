import type { GitView } from '../types';
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
    const [view, setView] = useState<GitView>('changes');
    const [message, setMessage] = useState('');
    const [revision, setRevision] = useState(0);
    const [history, setHistory] = useState<GitCommitEntry[]>([]);
    const [branches, setBranches] = useState<GitBranchEntry[]>([]);
    const [commit, setCommit] = useState<GitCommitEntry>();
    const [files, setFiles] = useState<string[]>([]);
    const [index, setIndex] = useState(0);
    const [diff, setDiff] = useState('');
    const [newBranchName, setNewBranchName] = useState('');
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [hasMoreHistory, setHasMoreHistory] = useState(false);
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
        setHasMoreHistory(entries.length === 100);
    }

    useEffect(() => {
        if (creating) {
            branchInput.current?.focus();
        }
    }, [creating]);

    useEffect(() => {
        if (view === 'changes') {
            return;
        }
        void run(async () => {
            setBranchName((await window.nido.gitStatus(workspaceId)).branch);
            if (view === 'history') {
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

    function returnToPreviousView(): void {
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

    function changeView(next: GitView): void {
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
            setNewBranchName('');
            setBranches(await window.nido.gitBranches(workspaceId));
            setBranchName((await window.nido.gitStatus(workspaceId)).branch);
            list.current?.focus();
        });
    }

    function openSelection(): void {
        if (view === 'branches' && branches[index]) {
            const branch = branches[index];
            switchBranch(`refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`, false);
        } else if (view === 'history' && !commit && history[index]) {
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
    if (view === 'branches') {
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
    if (view === 'branches') {
        listLabel = 'Branches';
    } else if (commit) {
        listLabel = 'Commit files';
    }

    useGitBrowserKeyboard({ busy, back: returnToPreviousView, changeView });

    return (
        <div className={styles.panel}>
            <nav className={styles.toolbar} aria-label="Git views">
                {(
                    [
                        { view: 'changes', title: 'Changes' },
                        { view: 'history', title: 'History' },
                        { view: 'branches', title: 'Branches' }
                    ] as const
                ).map(({ view: tab, title }, shortcutIndex) => (
                    <button
                        key={title}
                        disabled={busy}
                        aria-current={view === tab ? 'page' : undefined}
                        onClick={() => changeView(tab)}
                    >
                        {shortcutIndex + 1} {title}
                    </button>
                ))}
            </nav>
            {view === 'changes' ? (
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
                                : view === 'history'
                                  ? 'History of the current branch'
                                  : 'Local and remote-tracking branches'}
                        </span>
                        {commit && (
                            <button disabled={busy} onClick={returnToPreviousView}>
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
                            open={openSelection}
                            setCreating={setCreating}
                        />
                        <div className={styles.preview} data-git-preview>
                            {view === 'history' && commit ? (
                                <GitDiff
                                    key={`${commit.hash}:${path}`}
                                    workspaceId={workspaceId}
                                    path={path}
                                    diff={diff}
                                    label="Commit diff"
                                    beforeLabel="First parent"
                                    afterLabel={commit.hash.slice(0, 8)}
                                />
                            ) : view === 'history' && history[index] ? (
                                <CommitDetails
                                    entry={history[index]}
                                    busy={busy}
                                    open={openSelection}
                                />
                            ) : view === 'branches' && branches[index] ? (
                                <BranchDetails
                                    entry={branches[index]}
                                    busy={busy}
                                    open={openSelection}
                                />
                            ) : (
                                <pre tabIndex={0} />
                            )}
                        </div>
                    </div>
                    <div className={styles.toolbar}>
                        {!commit && (
                            <button disabled={busy || !labels.length} onClick={openSelection}>
                                {view === 'history'
                                    ? 'Open commit (Enter)'
                                    : 'Switch branch (Enter)'}
                            </button>
                        )}
                        {view === 'history' && !commit && hasMoreHistory && (
                            <button
                                disabled={busy}
                                onClick={() => void run(() => loadHistory(true))}
                            >
                                Load older commits
                            </button>
                        )}
                        {view === 'branches' && (
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
                                switchBranch(newBranchName, true);
                            }}
                        >
                            <input
                                ref={branchInput}
                                autoFocus
                                aria-label="New branch name"
                                placeholder="New branch name"
                                value={newBranchName}
                                onChange={(event) => setNewBranchName(event.target.value)}
                            />
                            <button disabled={busy || !newBranchName.trim()} type="submit">
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
