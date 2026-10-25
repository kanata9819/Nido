import { useI18n } from '../i18n';
import { memo, useEffect, useRef } from 'react';
import { Command, FolderOpen, FileCode2, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import type { Panel, Item } from '../types';
import styles from '../assets/Palette.module.css';
import FileIcon from './FileIcon';

interface PaletteItemsProps {
  panel: Exclude<Panel, null>;
  filtered: Item[];
  selection: number;
  query: string;
  loading: boolean;
  message?: string;
  setQuery: (value: string) => void;
  setSelection: React.Dispatch<React.SetStateAction<number>>;
}

function itemIcon(panel: Exclude<Panel, null>, severity: number | undefined): React.JSX.Element {
  switch (panel) {
    case 'problems':
      switch (severity) {
        case 1:
          return <CircleAlert size={18} />;
        case 2:
          return <TriangleAlert size={18} />;
        default:
          return <Info size={18} />;
      }
    case 'workspaces':
      return <FolderOpen size={18} />;
    case 'symbols':
    case 'search':
      return <FileCode2 size={18} />;
    default:
      return <Command size={17} />;
  }
}

const PaletteItem = memo(function PaletteItem({
  panel,
  item,
  index,
  selected
}: {
  panel: Exclude<Panel, null>;
  item: Item;
  index: number;
  selected: boolean;
}): React.JSX.Element {
  return (
    <button
      id={
        panel === 'problems'
          ? `problem-${index}`
          : panel === 'symbols'
            ? `symbol-${index}`
            : undefined
      }
      role={panel === 'problems' || panel === 'symbols' ? 'option' : undefined}
      aria-selected={panel === 'problems' || panel === 'symbols' ? selected : undefined}
      data-severity={item.severity}
      className={selected ? styles.selectedItem : ''}
      ref={(node) => {
        if (node && selected) {
          node.scrollIntoView({ block: 'nearest' });
        }
      }}
      onClick={item.run}
    >
      <span className={styles.itemIcon}>
        {panel === 'files' || panel === 'buffers' ? (
          <FileIcon path={item.detail} />
        ) : (
          itemIcon(panel, item.severity)
        )}
      </span>
      <span>
        <strong>{item.title}</strong>
        <small>{item.detail}</small>
      </span>
      {item.key && <kbd>{item.key}</kbd>}
    </button>
  );
});

export default function PaletteItems({
  panel,
  filtered,
  selection,
  query,
  loading,
  message,
  setQuery,
  setSelection
}: PaletteItemsProps): React.JSX.Element {
  const t = useI18n();
  const results = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const pendingEnter = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!loading && pendingEnter.current === query) {
      pendingEnter.current = undefined;
      if (document.activeElement === filter.current) {
        filtered[Math.max(0, selection)]?.run();
      }
    }
  }, [loading, query, filtered, selection]);
  useEffect(() => {
    if (panel === 'problems') {
      results.current?.focus();
    }
  }, [panel]);
  useEffect(() => {
    if (panel === 'problems') {
      setSelection((index) => Math.max(0, Math.min(index, filtered.length - 1)));
    }
  }, [panel, filtered.length, setSelection]);
  useEffect(() => {
    const node = results.current;
    if (panel !== 'problems' || !node) {
      return;
    }
    const observer = new ResizeObserver(() => {
      node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [panel]);
  return (
    <>
      <input
        ref={filter}
        autoFocus={panel !== 'problems'}
        className={styles.paletteInput}
        role={panel === 'symbols' ? 'combobox' : undefined}
        aria-expanded={panel === 'symbols' ? true : undefined}
        aria-autocomplete={panel === 'symbols' ? 'list' : undefined}
        aria-controls={panel === 'symbols' ? 'symbol-results' : undefined}
        aria-activedescendant={
          panel === 'symbols' && filtered[selection] ? `symbol-${selection}` : undefined
        }
        aria-label={panel === 'search' ? t('Search in files') : t('Filter items')}
        placeholder={
          panel === 'files'
            ? t('Type a filename…')
            : panel === 'symbols'
              ? t('Type a symbol name…')
              : panel === 'search'
                ? t('Type text to grep…')
                : t('Type to search…')
        }
        value={query}
        onChange={(event) => {
          pendingEnter.current = undefined;
          setQuery(event.target.value);
          setSelection(0);
        }}
        onBlur={() => {
          pendingEnter.current = undefined;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            return;
          }
          if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
            event.preventDefault();
            setSelection((n) => Math.min(n + 1, filtered.length - 1));
          } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
            event.preventDefault();
            setSelection((n) => Math.max(0, n - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (['files', 'search', 'symbols'].includes(panel) && loading) {
              pendingEnter.current = query;
            } else {
              filtered[Math.max(0, selection)]?.run();
            }
          }
        }}
      />
      <div
        className={styles.paletteItems}
        id={panel === 'symbols' ? 'symbol-results' : undefined}
        ref={results}
        tabIndex={panel === 'problems' ? 0 : undefined}
        role={panel === 'problems' || panel === 'symbols' ? 'listbox' : undefined}
        aria-label={
          panel === 'problems' ? t('Problems') : panel === 'symbols' ? t('File symbols') : undefined
        }
        aria-busy={panel === 'symbols' ? loading : undefined}
        aria-activedescendant={
          panel === 'problems' && filtered[selection] ? `problem-${selection}` : undefined
        }
        onKeyDown={(event) => {
          if (
            panel !== 'problems' ||
            event.nativeEvent.isComposing ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey
          ) {
            return;
          }
          if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const last = Math.max(0, filtered.length - 1);
            setSelection((index) => {
              if (event.key === 'Home') {
                return 0;
              }
              if (event.key === 'End') {
                return last;
              }
              const step = ['j', 'ArrowDown'].includes(event.key) ? 1 : -1;
              return Math.max(0, Math.min(last, index + step));
            });
          } else if (event.key === 'Enter') {
            event.preventDefault();
            filtered[selection]?.run();
          } else if (event.key === '/') {
            event.preventDefault();
            filter.current?.focus();
          }
        }}
      >
        {panel === 'symbols' && message && filtered.length > 0 && (
          <p className={styles.noResults} role="status">
            {t(message)}
          </p>
        )}
        {filtered.map((item, i) => (
          <PaletteItem
            key={`${item.title}-${i}`}
            panel={panel}
            item={item}
            index={i}
            selected={i === selection}
          />
        ))}
        {!filtered.length && (
          <p className={styles.noResults}>
            {loading
              ? panel === 'symbols'
                ? t('Loading symbols…')
                : t('Looking through your project…')
              : message
                ? t(message)
                : panel === 'search'
                  ? query
                    ? t('No matching lines.')
                    : t('Enter text to search this workspace.')
                  : panel === 'problems' && !query
                    ? t('No problems reported.')
                    : t('No matching items.')}
          </p>
        )}
      </div>
      <div className={styles.paletteFooter}>
        <span>
          {panel === 'problems'
            ? t('{count} problems · j/k Select · / Filter', { count: filtered.length })
            : t('↑ ↓ or Ctrl+j / k to navigate')}
        </span>
        <span>{t('Enter to select · Esc to return')}</span>
      </div>
    </>
  );
}
