import type { Panel, Item } from '../types';
import { Command, FolderOpen, FileCode2, X } from 'lucide-react';
import styles from '../assets/Nido.module.css';
import FolderPicker from './FolderPicker';
import GitBrowser from './GitBrowser';

interface PanelProps {
  formatOnSave: boolean;
  setFormatOnSave: (value: boolean) => void;
  workspaceId: string;
  animations: boolean;
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
}

const panelTitles = {
  git: 'Source control',
  folders: 'Open a workspace',
  files: 'Find a file',
  workspaces: 'Your workspaces',
  buffers: 'Open files',
  settings: 'Settings',
  commands: 'All commands'
};

export function Panel({
  formatOnSave,
  setFormatOnSave,
  workspaceId,
  animations,
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
  setSelection
}: PanelProps): React.JSX.Element | null {
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
          <div className={styles.settings}>
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
              UI animations{' '}
              <input type="checkbox" checked={animations} onChange={(event) => setAnimations(event.target.checked)} />
            </label>
            <p>
              Vim editing · Space commands · Ctrl+Tab workspaces
              <br />
              Nido includes its own Neovim and editor settings. Personal Neovim config is not loaded.
            </p>
          </div>
        ) : (
          <>
            <input
              autoFocus
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
            <div className={styles.paletteItems}>
              {filtered.map((item, i) => (
                <button
                  key={`${item.title}-${i}`}
                  className={i === selection ? styles.selectedItem : ''}
                  ref={(node) => {
                    if (node && i === selection) {
                      node.scrollIntoView({ block: 'nearest' });
                    }
                  }}
                  onClick={item.run}
                >
                  <span className={styles.itemIcon}>
                    {panel === 'workspaces' ? (
                      <FolderOpen size={18} />
                    ) : panel === 'files' || panel === 'buffers' ? (
                      <FileCode2 size={18} />
                    ) : (
                      <Command size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  {item.key && <kbd>{item.key}</kbd>}
                </button>
              ))}
              {!filtered.length && (
                <p className={styles.noResults}>{loading ? 'Looking through your project…' : 'No matching items.'}</p>
              )}
            </div>
            <div className={styles.paletteFooter}>
              <span>↑ ↓ or Ctrl+j / k to navigate</span>
              <span>Enter to select · Esc to return</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
