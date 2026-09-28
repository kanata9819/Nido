import { useEffect, useRef } from 'react';
import { Command, FolderOpen, FileCode2, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import type { Panel, Item } from '../types';
import styles from '../assets/Nido.module.css';

interface PaletteItemsProps {
  panel: Exclude<Panel, null>;
  filtered: Item[];
  selection: number;
  query: string;
  loading: boolean;
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
    case 'files':
    case 'buffers':
      return <FileCode2 size={18} />;
    default:
      return <Command size={17} />;
  }
}

export default function PaletteItems({
  panel,
  filtered,
  selection,
  query,
  loading,
  setQuery,
  setSelection
}: PaletteItemsProps): React.JSX.Element {
  const results = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
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
  return (
    <>
      <input
        ref={filter}
        autoFocus={panel !== 'problems'}
        className={styles.paletteInput}
        aria-label="Filter items"
        placeholder={panel === 'files' ? 'Type a filename…' : 'Type to search…'}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelection(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
            event.preventDefault();
            setSelection((n) => Math.min(n + 1, filtered.length - 1));
          } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
            event.preventDefault();
            setSelection((n) => Math.max(0, n - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            filtered[Math.max(0, selection)]?.run();
          }
        }}
      />
      <div
        className={styles.paletteItems}
        ref={results}
        tabIndex={panel === 'problems' ? 0 : undefined}
        role={panel === 'problems' ? 'listbox' : undefined}
        aria-label={panel === 'problems' ? 'Problems' : undefined}
        aria-activedescendant={panel === 'problems' && filtered[selection] ? `problem-${selection}` : undefined}
        onKeyDown={(event) => {
          if (panel !== 'problems' || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
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
        {filtered.map((item, i) => (
          <button
            key={`${item.title}-${i}`}
            id={panel === 'problems' ? `problem-${i}` : undefined}
            role={panel === 'problems' ? 'option' : undefined}
            aria-selected={panel === 'problems' ? i === selection : undefined}
            data-severity={item.severity}
            className={i === selection ? styles.selectedItem : ''}
            ref={(node) => {
              if (node && i === selection) {
                node.scrollIntoView({ block: 'nearest' });
              }
            }}
            onClick={item.run}
          >
            <span className={styles.itemIcon}>{itemIcon(panel, item.severity)}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
            {item.key && <kbd>{item.key}</kbd>}
          </button>
        ))}
        {!filtered.length && (
          <p className={styles.noResults}>
            {loading
              ? 'Looking through your project…'
              : panel === 'problems' && !query
                ? 'No problems reported.'
                : 'No matching items.'}
          </p>
        )}
      </div>
      <div className={styles.paletteFooter}>
        <span>
          {panel === 'problems'
            ? `${filtered.length} problems · j/k Select · / Filter`
            : '↑ ↓ or Ctrl+j / k to navigate'}
        </span>
        <span>Enter to select · Esc to return</span>
      </div>
    </>
  );
}
