import { useI18n } from '../i18n';
import type { GitView } from '../types';
import type { RefObject } from 'react';
import type { GitBranchEntry, GitCommitEntry } from '../../../shared/types';
import styles from '../assets/GitPanel.module.css';

export default function GitBrowserList({
  view,
  busy,
  commit,
  history,
  branches,
  labels,
  listLabel,
  index,
  setIndex,
  listRef,
  open,
  setCreating
}: {
  view: GitView;
  busy: boolean;
  commit?: GitCommitEntry;
  history: GitCommitEntry[];
  branches: GitBranchEntry[];
  labels: string[];
  listLabel: string;
  index: number;
  setIndex: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  open: () => void;
  setCreating: (creating: boolean) => void;
}): React.JSX.Element {
  const t = useI18n();
  return (
    <div
      className={`${styles.list} ${view === 'branches' || (view === 'history' && !commit) ? styles.historyList : ''}`}
      ref={listRef}
      role="listbox"
      aria-label={listLabel}
      tabIndex={0}
      aria-activedescendant={labels[index] ? `git-entry-${index}` : undefined}
      onKeyDown={(event) => {
        if (
          busy ||
          event.altKey ||
          event.metaKey ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        ) {
          return;
        }
        const key = event.key.toLowerCase();
        const halfPage = event.ctrlKey && !event.shiftKey && ['d', 'u'].includes(key);
        const fullPage =
          (event.ctrlKey && !event.shiftKey && ['f', 'b'].includes(key)) ||
          (!event.ctrlKey && ['PageDown', 'PageUp'].includes(event.key));
        if (halfPage || fullPage) {
          event.preventDefault();
          const row = event.currentTarget.querySelector<HTMLElement>('[role="option"]');
          const step = Math.max(
            1,
            Math.floor(
              event.currentTarget.clientHeight /
                (row?.getBoundingClientRect().height || 1) /
                (halfPage ? 2 : 1)
            )
          );
          const direction = ['d', 'f', 'pagedown'].includes(key) ? 1 : -1;
          setIndex(Math.max(0, Math.min(labels.length - 1, index + direction * step)));
          return;
        }
        if (event.ctrlKey) {
          return;
        }
        if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'G'].includes(event.key)) {
          event.preventDefault();
          let next = index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1);
          if (event.key === 'Home' || event.key === 'g') {
            next = 0;
          }
          if (event.key === 'End' || event.key === 'G') {
            next = labels.length - 1;
          }
          setIndex(Math.max(0, Math.min(labels.length - 1, next)));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          open();
        } else if (view === 'branches' && event.key === 'n') {
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
          className={`${styles.change} ${view === 'branches' || (view === 'history' && !commit) ? styles.historyEntry : ''}`}
          title={label}
          ref={(node) => {
            if (node && index === position) {
              node.scrollIntoView({ block: 'nearest' });
            }
          }}
          onClick={() => {
            setIndex(position);
            listRef.current?.focus();
          }}
          onDoubleClick={open}
        >
          {view === 'history' && !commit ? (
            <>
              <strong className={styles.commitSubject}>{history[position].subject}</strong>
              <div className={styles.commitMeta}>
                <code className={styles.hashBadge}>{history[position].hash.slice(0, 8)}</code>
                <span>{history[position].author}</span>
              </div>
            </>
          ) : view === 'branches' ? (
            <>
              <strong className={styles.commitSubject}>{branches[position].name}</strong>
              <div className={styles.commitMeta}>
                <span className={styles.branchBadge}>
                  {branches[position].remote ? t('Remote') : t('Local')}
                </span>
                {branches[position].current && (
                  <span className={styles.currentBadge}>{t('Current')}</span>
                )}
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
            ? t('No changed files.')
            : view === 'history'
              ? t('No commits yet.')
              : t('No branches yet. Press n to create one.')}
        </p>
      )}
    </div>
  );
}
