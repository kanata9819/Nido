import type { Panel, Item } from '../types';
import { useEffect, useRef } from 'react';
import { Command, FolderOpen, FileCode2, X, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import styles from '../assets/Nido.module.css';
import FolderPicker from './FolderPicker';
import GitBrowser from './GitBrowser';

interface PanelProps {
  scrollFollowCursor: boolean;
  setScrollFollowCursor: (value: boolean) => void;
  formatOnSave: boolean;
  clipboardSharing: boolean;
  setClipboardSharing: (value: boolean) => void;
  setFormatOnSave: (value: boolean) => void;
  workspaceId: string;
  animations: boolean;
  smoothCursor: boolean;
  smoothBlink: boolean;
  setSmoothBlink: (value: boolean) => void;
  setSmoothCursor: (value: boolean) => void;
  setAnimations: (value: boolean) => void;
  initialFolder: string;
  creating: boolean;
  openWorkspace: (path: string, kind: 'editor' | 'terminal') => Promise<void>;
  panel: Panel;
  filtered: Item[];
  selection: number;
  query: string;
  loading: boolean;
  modal: React.RefObject<HTMLDivElement | null>;
  focusEditor: () => void;
  fontSize: number;
  setFontSize: (value: number) => void;
  sidebar: boolean;
  setSidebar: (value: boolean) => void;
  setQuery: (value: string) => void;
  setSelection: React.Dispatch<React.SetStateAction<number>>;
  fontFamily: string;
  setFontFamily: React.Dispatch<React.SetStateAction<string>>;
}

const panelTitles = {
  problems: 'Problems',
  git: 'Source control',
  folders: 'Open a workspace',
  files: 'Find a file',
  workspaces: 'Your workspaces',
  buffers: 'Open files',
  settings: 'Settings',
  commands: 'All commands'
};

function itemIcon(panel: Exclude<Panel, null>, severity: number | undefined): React.JSX.Element {
  if (panel === 'problems') {
    if (severity === 1) {
      return <CircleAlert size={18} />;
    }
    if (severity === 2) {
      return <TriangleAlert size={18} />;
    }
    return <Info size={18} />;
  }
  if (panel === 'workspaces') {
    return <FolderOpen size={18} />;
  }
  if (panel === 'files' || panel === 'buffers') {
    return <FileCode2 size={18} />;
  }
  return <Command size={17} />;
}

export function Panel({
  scrollFollowCursor,
  setScrollFollowCursor,
  formatOnSave,
  clipboardSharing,
  setClipboardSharing,
  setFormatOnSave,
  workspaceId,
  animations,
  smoothCursor,
  smoothBlink,
  setSmoothBlink,
  setSmoothCursor,
  setAnimations,
  initialFolder,
  creating,
  openWorkspace,
  panel,
  filtered,
  selection,
  query,
  loading,
  modal,
  focusEditor,
  fontSize,
  setFontSize,
  sidebar,
  setSidebar,
  setQuery,
  setSelection,
  fontFamily,
  setFontFamily
}: PanelProps): React.JSX.Element | null {
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
  if (!panel) {
    return null;
  }

  return (
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          focusEditor();
        }
      }}
    >
      <div
        className={`${styles.palette} ${panel === 'git' ? styles.gitPalette : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={panel === 'settings' ? 'Settings' : `${panel} palette`}
        ref={modal}
      >
        <div className={styles.paletteHeading}>
          <Command size={17} />
          <span>{panelTitles[panel]}</span>
          <button aria-label="Close palette" onClick={focusEditor}>
            <X size={17} />
          </button>
        </div>
        {panel === 'git' ? (
          <GitBrowser key={workspaceId} workspaceId={workspaceId} onClose={focusEditor} />
        ) : panel === 'folders' ? (
          <FolderPicker
            initialPath={initialFolder}
            busy={creating}
            onOpen={(path, kind) => void openWorkspace(path, kind)}
          />
        ) : panel === 'settings' ? (
          <div
            className={styles.settings}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.altKey || event.metaKey) return;
              const target = event.target as HTMLInputElement;
              const text = target.type === 'text';
              const next = event.key === 'ArrowDown' || ((!text || event.ctrlKey) && event.key === 'j');
              const previous = event.key === 'ArrowUp' || ((!text || event.ctrlKey) && event.key === 'k');
              if (next || previous) {
                event.preventDefault();
                const inputs = [...event.currentTarget.querySelectorAll('input')];
                const index = inputs.indexOf(target);
                inputs[(index + (next ? 1 : -1) + inputs.length) % inputs.length]?.focus();
              } else if (event.key === 'Enter' && target.type === 'checkbox') {
                event.preventDefault();
                target.click();
              }
            }}
          >
            <label>
              Editor font size{' '}
              <input
                autoFocus
                type="range"
                min="8"
                max="24"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
              <span>{fontSize}px</span>
            </label>
            <label className={styles.fontFamilyField}>
              Font family
              <input
                type="text"
                value={fontFamily}
                placeholder="Default editor font"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setFontFamily(event.target.value)}
              />
            </label>
            <label>
              Show file explorer{' '}
              <input type="checkbox" checked={sidebar} onChange={(e) => setSidebar(e.target.checked)} />
            </label>
            <label>
              Format on save{' '}
              <input
                type="checkbox"
                checked={formatOnSave}
                onChange={(event) => setFormatOnSave(event.target.checked)}
              />
            </label>
            <label>
              Share system clipboard{' '}
              <input
                type="checkbox"
                checked={clipboardSharing}
                onChange={(event) => setClipboardSharing(event.target.checked)}
              />
            </label>
            <small>Sync Vim copy, cut and paste (yy / dd / p) with the system clipboard.</small>
            <label>
              Cursor follows scrolling{' '}
              <input
                type="checkbox"
                checked={scrollFollowCursor}
                onChange={(event) => setScrollFollowCursor(event.target.checked)}
              />
            </label>
            <label>
              UI animations{' '}
              <input type="checkbox" checked={animations} onChange={(event) => setAnimations(event.target.checked)} />
            </label>
            <label>
              Smooth cursor movement{' '}
              <input
                type="checkbox"
                checked={smoothCursor}
                onChange={(event) => setSmoothCursor(event.target.checked)}
              />
            </label>
            <label>
              Smooth cursor blink{' '}
              <input type="checkbox" checked={smoothBlink} onChange={(event) => setSmoothBlink(event.target.checked)} />
            </label>
            <p>
              Tab / ↑ ↓ / j k: Move · ← →: Adjust · Space / Enter: Toggle · Esc: Close
              <br />
              Nido includes its own Neovim and editor settings. Personal Neovim config is not loaded.
            </p>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
