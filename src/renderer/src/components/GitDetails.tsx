import type { GitBranchEntry, GitCommitEntry } from '../../../shared/types';
import styles from '../assets/GitPanel.module.css';

export function CommitDetails({
    entry,
    busy,
    open
}: {
    entry: GitCommitEntry;
    busy: boolean;
    open: () => void;
}): React.JSX.Element {
    return (
        <section
            className={styles.commitSummary}
            data-git-summary
            tabIndex={0}
            aria-label="Commit details"
        >
            <span className={styles.summaryLabel}>COMMIT</span>
            <h2>{entry.subject}</h2>
            <dl className={styles.commitDetails}>
                <div>
                    <dt>Author</dt>
                    <dd>{entry.author}</dd>
                </div>
                <div>
                    <dt>Committed</dt>
                    <dd>
                        <time dateTime={entry.date}>
                            {new Date(entry.date).toLocaleString(undefined, {
                                dateStyle: 'medium',
                                timeStyle: 'short'
                            })}
                        </time>
                    </dd>
                </div>
                <div>
                    <dt>Hash</dt>
                    <dd>
                        <code>{entry.hash}</code>
                    </dd>
                </div>
            </dl>
            <button disabled={busy} onClick={open}>
                Browse changed files <kbd>Enter</kbd>
            </button>
        </section>
    );
}

export function BranchDetails({
    entry,
    busy,
    open
}: {
    entry: GitBranchEntry;
    busy: boolean;
    open: () => void;
}): React.JSX.Element {
    return (
        <section
            className={styles.commitSummary}
            data-git-summary
            tabIndex={0}
            aria-label="Branch details"
        >
            <span className={styles.summaryLabel}>BRANCH</span>
            <h2>{entry.name}</h2>
            <dl className={styles.commitDetails}>
                <div>
                    <dt>Type</dt>
                    <dd>{entry.remote ? 'Remote-tracking branch' : 'Local branch'}</dd>
                </div>
                <div>
                    <dt>Status</dt>
                    <dd>{entry.current ? 'Currently checked out' : 'Available to switch'}</dd>
                </div>
                <div>
                    <dt>On switch</dt>
                    <dd>
                        {entry.remote
                            ? 'Create a local branch that tracks this remote branch.'
                            : 'Check out this branch in the workspace.'}
                    </dd>
                </div>
            </dl>
            <p className={styles.summaryHint}>
                {entry.current
                    ? 'You are already working on this branch.'
                    : 'Switch to this branch to continue working on it.'}
            </p>
            <button disabled={busy || entry.current} onClick={open}>
                Switch branch <kbd>Enter</kbd>
            </button>
        </section>
    );
}
