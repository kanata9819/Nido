import { useContext } from 'react';
import { LanguageContext, useI18n } from '../i18n';
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
    const t = useI18n();
    const language = useContext(LanguageContext);
    return (
        <section
            className={styles.commitSummary}
            data-git-summary
            tabIndex={0}
            aria-label={t('Commit details')}
        >
            <span className={styles.summaryLabel}>{t('COMMIT')}</span>
            <h2>{entry.subject}</h2>
            <dl className={styles.commitDetails}>
                <div>
                    <dt>{t('Author')}</dt>
                    <dd>{entry.author}</dd>
                </div>
                <div>
                    <dt>{t('Committed')}</dt>
                    <dd>
                        <time dateTime={entry.date}>
                            {new Date(entry.date).toLocaleString(
                                language === 'ja' ? 'ja-JP' : 'en-US',
                                {
                                    dateStyle: 'medium',
                                    timeStyle: 'short'
                                }
                            )}
                        </time>
                    </dd>
                </div>
                <div>
                    <dt>{t('Hash')}</dt>
                    <dd>
                        <code>{entry.hash}</code>
                    </dd>
                </div>
            </dl>
            <button disabled={busy} onClick={open}>
                {t('Browse changed files')} <kbd>Enter</kbd>
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
    const t = useI18n();
    return (
        <section
            className={styles.commitSummary}
            data-git-summary
            tabIndex={0}
            aria-label={t('Branch details')}
        >
            <span className={styles.summaryLabel}>{t('BRANCH')}</span>
            <h2>{entry.name}</h2>
            <dl className={styles.commitDetails}>
                <div>
                    <dt>{t('Type')}</dt>
                    <dd>{entry.remote ? t('Remote-tracking branch') : t('Local branch')}</dd>
                </div>
                <div>
                    <dt>{t('Status')}</dt>
                    <dd>{entry.current ? t('Currently checked out') : t('Available to switch')}</dd>
                </div>
                <div>
                    <dt>{t('On switch')}</dt>
                    <dd>
                        {entry.remote
                            ? t('Create a local branch that tracks this remote branch.')
                            : t('Check out this branch in the workspace.')}
                    </dd>
                </div>
            </dl>
            <p className={styles.summaryHint}>
                {entry.current
                    ? t('You are already working on this branch.')
                    : t('Switch to this branch to continue working on it.')}
            </p>
            <button disabled={busy || entry.current} onClick={open}>
                {t('Switch branch')} <kbd>Enter</kbd>
            </button>
        </section>
    );
}
