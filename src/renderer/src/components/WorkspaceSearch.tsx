import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchResults } from '../../../shared/types';
import { defaultSearchOptions, type ReplacementPreview } from '../../../shared/search';
import { useI18n } from '../i18n';
import styles from '../assets/WorkspaceSearch.module.css';
import { useFocusGuard } from '../hooks/useFocusGuard';

export default function WorkspaceSearch({
  workspaceId,
  onClose
}: {
  workspaceId: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useI18n();
  const captureFocus = useFocusGuard(workspaceId);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replace, setReplace] = useState(false);
  const [options, setOptions] = useState(defaultSearchOptions);
  const [selection, setSelection] = useState(0);
  const [excluded, setExcluded] = useState(new Set<number>());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<SearchResults>({ matches: [], truncated: false });
  const [preview, setPreview] = useState<ReplacementPreview>();
  const [file, setFile] = useState(0);
  const queryInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLDivElement>(null);
  const diff = useRef<HTMLDivElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const pendingEnter = useRef<string | undefined>(undefined);
  const focusTarget = useRef<'results' | 'files' | 'replace' | undefined>(undefined);
  const focus = (target: 'results' | 'files' | 'replace'): void => {
    focusTarget.current = target;
  };
  useLayoutEffect(() => {
    const target = focusTarget.current;
    const element =
      target === 'files'
        ? files.current
        : target === 'replace'
          ? replaceInput.current
          : target === 'results'
            ? results.current
            : undefined;
    if (element && !busy) {
      element.focus();
      focusTarget.current = undefined;
    }
  });

  const failure = (value: unknown): void => {
    const message = String(value).replace(
      /^Error: (?:Error invoking remote method '[^']+': Error: )?/,
      ''
    );
    setError(t(message));
  };
  const open = (index: number): void => {
    const match = result.matches[index];
    if (!match) {
      return;
    }
    const canFocus = captureFocus();
    void window.nido
      .openFile(workspaceId, match.path, match.line, match.column)
      .then(() => {
        if (canFocus()) {
          onClose();
        }
      })
      .catch(failure);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.nido
        .searchText(workspaceId, query, options)
        .then((result) => {
          if (!cancelled) {
            setResult(result);
            setExcluded(new Set());
            setSelection(0);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            failure(error);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void window.nido.cancelFindFiles(workspaceId).catch(() => {});
    };
    // Translation changes do not restart a search or invalidate its preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, query, options]);

  useEffect(() => {
    if (!loading && pendingEnter.current === query) {
      pendingEnter.current = undefined;
      if (document.activeElement === queryInput.current && !replace) {
        open(selection);
      }
    }
    // Opening is tied to the completed search, not unrelated focus changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, result]);

  useEffect(() => {
    const list = preview ? files.current : results.current;
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selection, preview, file]);

  const invalidate = (): void => {
    if (
      preview &&
      [files.current, diff.current, applyButton.current].includes(
        document.activeElement as HTMLDivElement
      )
    ) {
      focus('results');
    }
    request.current++;
    setPreview(undefined);
    setError('');
    setNotice('');
  };
  const searchChanged = (): void => {
    invalidate();
    pendingEnter.current = undefined;
    setResult({ matches: [], truncated: false });
    setSelection(0);
    setLoading(!!query);
  };
  const changeOption = (key: 'caseSensitive' | 'regex' | 'wholeWord'): void => {
    if (locked.current) {
      return;
    }
    searchChanged();
    setOptions((options) => ({ ...options, [key]: !options[key] }));
  };
  const prepare = async (): Promise<void> => {
    if (locked.current || loading || !result.token) {
      return;
    }
    const selected = result.matches.flatMap((_, index) => (excluded.has(index) ? [] : [index]));
    if (!selected.length) {
      return;
    }
    const generation = ++request.current;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await window.nido.previewReplacement(
        workspaceId,
        result.token,
        replacement,
        selected
      );
      if (!alive.current || generation !== request.current) {
        return;
      }
      setPreview(value);
      setFile(0);
      focus('files');
    } catch (error) {
      if (alive.current && generation === request.current) {
        failure(error);
      }
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  const apply = async (): Promise<void> => {
    if (locked.current || !preview?.count) {
      return;
    }
    const generation = ++request.current;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await window.nido.applyReplacement(workspaceId, preview.token);
      if (!alive.current || generation !== request.current) {
        return;
      }
      setPreview(undefined);
      setResult({ matches: [], truncated: false });
      setNotice(
        t(
          'Replaced {count} occurrences in {files} files. Unsaved edits · :wall to save all · u to undo in each file.',
          { ...value }
        )
      );
      focus('results');
    } catch (error) {
      if (alive.current && generation === request.current) {
        failure(error);
        setPreview(undefined);
        focus('results');
      }
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  const toggle = (index: number): void =>
    setExcluded((old) => {
      const next = new Set(old);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  const rows = useMemo(
    () =>
      result.matches.map((match, index) => ({
        ...match,
        index,
        title: `${match.path}:${match.line}:${match.column}`
      })),
    [result]
  );
  const navigate = (
    event: KeyboardEvent,
    count: number,
    move: (value: React.SetStateAction<number>) => void
  ): boolean => {
    const key = event.key;
    if (
      !['j', 'k', 'g', 'G', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) ||
      event.altKey ||
      event.metaKey ||
      (event.ctrlKey && !['j', 'k'].includes(key))
    ) {
      return false;
    }
    event.preventDefault();
    move((index) =>
      Math.max(
        0,
        Math.min(
          count - 1,
          ['g', 'Home'].includes(key)
            ? 0
            : ['G', 'End'].includes(key)
              ? count - 1
              : index + (['j', 'ArrowDown'].includes(key) ? 1 : -1)
        )
      )
    );
    return true;
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (locked.current) {
        return;
      }
      if (preview) {
        setPreview(undefined);
        focus('results');
      } else if (event.target !== results.current) {
        pendingEnter.current = undefined;
        results.current?.focus();
      } else {
        onClose();
      }
      return;
    }
    if (locked.current) {
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && ['c', 'w', 'r'].includes(key)) {
      event.preventDefault();
      changeOption(
        ({ c: 'caseSensitive', w: 'wholeWord', r: 'regex' } as const)[key as 'c' | 'w' | 'r']
      );
    } else if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      if (preview) {
        applyButton.current?.focus();
      } else if (replace) {
        void prepare();
      }
    }
  };

  return (
    <div
      className={styles.search}
      data-workspace-search
      onKeyDownCapture={(event) => {
        if (locked.current && event.key !== 'Tab') {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={keyboard}
      aria-busy={busy || loading}
    >
      <div className={styles.fields}>
        <label>
          {t('Search in files')}
          <input
            ref={queryInput}
            autoFocus
            value={query}
            disabled={busy}
            placeholder={t('Type text to grep…')}
            onChange={(event) => {
              searchChanged();
              setLoading(!!event.target.value);
              setQuery(event.target.value);
            }}
            onBlur={() => {
              pendingEnter.current = undefined;
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              if (event.ctrlKey && ['j', 'k'].includes(event.key)) {
                navigate(event, rows.length, setSelection);
              } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                navigate(event, rows.length, setSelection);
              } else if (event.key === 'Enter' && !event.ctrlKey) {
                event.preventDefault();
                if (replace) {
                  results.current?.focus();
                } else if (loading) {
                  pendingEnter.current = query;
                } else {
                  open(selection);
                }
              }
            }}
          />
        </label>
        <label>
          {t('Search folder')}
          <input
            ref={folderInput}
            value={options.folder}
            disabled={busy}
            placeholder={t('Entire workspace (for example: src)')}
            onChange={(event) => {
              searchChanged();
              setOptions((options) => ({ ...options, folder: event.target.value }));
            }}
          />
        </label>
        <div className={styles.options}>
          {(
            [
              ['caseSensitive', 'Match case', 'Alt+C'],
              ['wholeWord', 'Whole word', 'Alt+W'],
              ['regex', 'Regular expression', 'Alt+R']
            ] as const
          ).map(([key, label, shortcut]) => (
            <button
              key={key}
              disabled={busy}
              aria-pressed={options[key]}
              onClick={() => changeOption(key)}
            >
              {t(label)} <kbd>{shortcut}</kbd>
            </button>
          ))}
          <button
            disabled={busy}
            aria-pressed={replace}
            onClick={() => {
              invalidate();
              setReplace(!replace);
              if (!replace) {
                focus('replace');
              }
            }}
          >
            {t('Replace')}
          </button>
        </div>
        {replace && (
          <label>
            {t('Replace with')}
            <input
              ref={replaceInput}
              value={replacement}
              disabled={busy}
              onChange={(event) => {
                invalidate();
                setReplacement(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  results.current?.focus();
                }
              }}
            />
          </label>
        )}
        {replace && (
          <div className={styles.actions}>
            <button
              disabled={busy || loading || !result.token || excluded.size === rows.length}
              onClick={() => void prepare()}
            >
              {t('Preview replacement')} <kbd>Ctrl+Enter</kbd>
            </button>
            {preview && (
              <button
                ref={applyButton}
                disabled={busy || !preview.count}
                onClick={() => void apply()}
              >
                {t('Apply replacement')} <kbd>Enter</kbd>
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.body}>
        {preview ? (
          <>
            <div
              ref={files}
              className={styles.list}
              tabIndex={0}
              role="listbox"
              aria-label={t('Replacement files')}
              aria-activedescendant={preview.files[file] ? `replace-file-${file}` : undefined}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229 ||
                  navigate(event, preview.files.length, setFile)
                ) {
                  return;
                }
                if (event.key === 'Enter' || event.key === 'l') {
                  event.preventDefault();
                  diff.current?.focus();
                }
              }}
            >
              {preview.files.map((entry, index) => (
                <div
                  key={entry.path}
                  id={`replace-file-${index}`}
                  role="option"
                  aria-selected={index === file}
                  className={index === file ? styles.selected : ''}
                  onClick={() => setFile(index)}
                >
                  <strong>{entry.path}</strong>
                  <small>{t('{count} replacements', { count: entry.count })}</small>
                </div>
              ))}
              {!preview.files.length && <p>{t('Replacement would not change any files.')}</p>}
            </div>
            <div
              ref={diff}
              className={styles.diff}
              tabIndex={0}
              role="region"
              aria-label={t('Replacement diff')}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  return;
                }
                if (event.key === 'h' && !event.ctrlKey) {
                  event.preventDefault();
                  if (event.currentTarget.scrollLeft > 0) {
                    event.currentTarget.scrollLeft = Math.max(
                      0,
                      event.currentTarget.scrollLeft - 80
                    );
                  } else {
                    files.current?.focus();
                  }
                } else if (['j', 'k', 'h', 'l', 'd', 'u', 'g', 'G'].includes(event.key)) {
                  event.preventDefault();
                  if (event.key === 'l') {
                    event.currentTarget.scrollLeft += 80;
                  } else if (event.key === 'g') {
                    event.currentTarget.scrollTop = 0;
                  } else if (event.key === 'G') {
                    event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
                  } else {
                    event.currentTarget.scrollTop +=
                      (['j', 'd'].includes(event.key) ? 1 : -1) *
                      (event.ctrlKey ? event.currentTarget.clientHeight / 2 : 40);
                  }
                }
              }}
            >
              {preview.files[file] && (
                <>
                  <h3>{t('Before')}</h3>
                  <pre aria-label={t('Before replacement')}>{preview.files[file].before}</pre>
                  <h3>{t('After')}</h3>
                  <pre aria-label={t('After replacement')}>{preview.files[file].after}</pre>
                </>
              )}
            </div>
          </>
        ) : (
          <div
            ref={results}
            className={styles.list}
            tabIndex={0}
            role="listbox"
            aria-label={t('Search results')}
            aria-activedescendant={rows[selection] ? `search-result-${selection}` : undefined}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                navigate(event, rows.length, setSelection)
              ) {
                return;
              }
              if (event.ctrlKey || event.altKey || event.metaKey) {
                return;
              }
              if (event.key === '/') {
                event.preventDefault();
                queryInput.current?.focus();
              } else if (event.key === 'r') {
                event.preventDefault();
                if (replaceInput.current) {
                  replaceInput.current.focus();
                } else {
                  setReplace(true);
                  focus('replace');
                }
              } else if (event.key === 'f') {
                event.preventDefault();
                folderInput.current?.focus();
              } else if (replace && event.key === ' ') {
                event.preventDefault();
                toggle(selection);
              } else if (replace && event.key === 'a') {
                event.preventDefault();
                setExcluded((old) =>
                  old.size ? new Set() : new Set(rows.map((row) => row.index))
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                open(selection);
              }
            }}
          >
            {rows.map((row) => (
              <div
                key={`${row.path}:${row.line}`}
                id={`search-result-${row.index}`}
                role="option"
                aria-selected={row.index === selection}
                className={`${row.index === selection ? styles.selected : ''} ${replace && excluded.has(row.index) ? styles.excluded : ''}`}
                onClick={() => {
                  if (locked.current) {
                    return;
                  }
                  if (!replace) {
                    open(row.index);
                    return;
                  }
                  setSelection(row.index);
                  results.current?.focus();
                }}
                onDoubleClick={() => open(row.index)}
              >
                {replace && (
                  <span aria-label={t(excluded.has(row.index) ? 'Excluded' : 'Included')}>
                    {excluded.has(row.index) ? '☐' : '☑'}
                  </span>
                )}
                <span>
                  <strong>{row.title}</strong>
                  <small>{row.text}</small>
                </span>
              </div>
            ))}
            {!rows.length && (
              <p>
                {loading
                  ? t('Looking through your project…')
                  : query
                    ? t('No matching lines.')
                    : t('Enter text to search this workspace.')}
              </p>
            )}
          </div>
        )}
      </div>
      <div className={styles.footer} role="status">
        {notice ||
          (busy
            ? t('Working…')
            : preview
              ? t('{count} replacements in {files} files · Review before applying', {
                  count: preview.count,
                  files: preview.files.length
                })
              : result.truncated
                ? t('Showing the first 200 matching lines.')
                : t('{count} matching lines', { count: rows.length }))}
      </div>
      <div className={styles.footer}>
        {preview
          ? t('j/k Files · Enter/l Diff · h Back · Ctrl+Enter Focus apply · Esc Back')
          : t(
              'Esc Results/close · j/k Move · / Search · r Replace · f Folder · Space Include · a All · Ctrl+Enter Preview'
            )}
      </div>
      <div className={styles.footer}>
        {t('Saved UTF-8 files up to 1 MiB · Git ignores respected · Replacements stay unsaved')}
      </div>
    </div>
  );
}
