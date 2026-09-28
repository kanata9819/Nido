import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import FileIcon from './components/FileIcon';
import type { FileEntry, Workspace } from '../../shared/types';
import { getVisibleEntries } from './sidebarTree';
import { toggle } from './sidebarToggle';
import { createOnKeyDown } from './sidebarKeyboard';
import styles from './assets/Nido.module.css';
import { gitFileKey, type Decoration } from './hooks/useGitFileStatus';

interface Props {
  gitFiles: Record<string, Decoration>;
  width: number;
  onResize: (width: number) => void;
  workspace: Workspace;
  active: boolean;
  currentFile: string;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}

export default function Sidebar({
  gitFiles,
  workspace,
  active,
  currentFile,
  onOpen,
  onError,
  width,
  onResize
}: Props): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      window.nido.onEvent((event) => {
        if (event.type === 'filesChanged' && event.id === workspace.id) {
          setExpanded(new Set());
          setSelected('');
          setRevision((value) => value + 1);
        }
      }),
    [workspace.id]
  );
  const load = async (path: string): Promise<void> => {
    try {
      const files = await window.nido.files(workspace.id, path);
      setEntries((old) => ({ ...old, [path]: files }));
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    window.nido
      .files(workspace.id, '')
      .then((files) => {
        if (!cancelled) {
          setEntries({ '': files });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          onError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, onError, revision]);

  const visible = getVisibleEntries(entries, expanded);
  const rootDecoration = gitFiles[gitFileKey(workspace.root).replace(/\/$/, '')];

  return (
    <aside
      className={styles.sidebar}
      aria-label="File explorer"
      hidden={!active}
      style={{ width }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        if (event.shiftKey && ['H', 'L'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onResize(width + (event.key === 'H' ? -20 : 20));
        }
      }}
    >
      <div
        className={styles.sidebarResize}
        role="separator"
        aria-label="Explorer width"
        aria-orientation="vertical"
        aria-valuemin={160}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · Shift+H / L"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            onResize(width + (event.key === 'ArrowLeft' ? -20 : 20));
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            onResize(drag.current.width + event.clientX - drag.current.x);
          }
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <div className={styles.sidebarHeading}>
        <span
          className={styles.gitName}
          data-status={rootDecoration?.code || undefined}
          data-diagnostic={rootDecoration?.diagnostic}
        >
          {workspace.name}
        </span>
        <button title="Refresh files" aria-label="Refresh files" onClick={() => void load('')}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div
        className={styles.tree}
        role="tree"
        tabIndex={0}
        aria-label="Project files"
        title="j/k Select · Ctrl+D/U Half page · Ctrl+F/B Page · gg/G First / Last"
        aria-activedescendant={selected ? `file-${workspace.id}-${selected}` : undefined}
        onKeyDown={createOnKeyDown({
          visible,
          selected,
          expanded,
          setSelected,
          setExpanded,
          load,
          onOpen,
          workspaceId: workspace.id
        })}
      >
        {visible.map((entry) => {
          const decoration = gitFiles[gitFileKey(`${workspace.root}/${entry.path}`)];
          return (
            <div
              key={entry.path}
              id={`file-${workspace.id}-${entry.path}`}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
              aria-selected={selected === entry.path}
              className={`${styles.treeItem} ${selected === entry.path ? styles.treeSelected : ''} ${currentFile.endsWith(entry.path) ? styles.currentFile : ''}`}
              style={{ paddingLeft: 14 + entry.depth * 16 }}
              onClick={() => toggle({ entry, expanded, setExpanded, setSelected, onOpen, load })}
            >
              {entry.directory ? (
                expanded.has(entry.path) ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )
              ) : (
                <span className={styles.treeSpacer} />
              )}
              {entry.directory ? (
                expanded.has(entry.path) ? (
                  <FolderOpen size={15} />
                ) : (
                  <Folder size={15} />
                )
              ) : (
                <FileIcon path={entry.path} className={styles.fileIcon} />
              )}
              <span
                className={`${styles.treeName} ${styles.gitName}`}
                data-status={decoration?.code || undefined}
                data-diagnostic={decoration?.diagnostic}
              >
                {entry.name}
              </span>
              {decoration?.diagnostic && (
                <span
                  className={styles.gitBadge}
                  data-diagnostic={decoration.diagnostic}
                  title={`Diagnostics: ${decoration.diagnostic}`}
                  aria-label={`Diagnostics: ${decoration.diagnostic}`}
                >
                  !
                </span>
              )}
              {decoration?.code && (
                <span
                  className={styles.gitBadge}
                  data-status={decoration.code}
                  title={decoration.title}
                  aria-label={decoration.title}
                >
                  {decoration.code}
                </span>
              )}
            </div>
          );
        })}
        {!visible.length && (
          <p className={styles.emptyTree}>
            No files yet.
            <br />
            Use <code>:e filename</code> to create one.
          </p>
        )}
      </div>
      <div className={styles.sidebarFooter}>
        <span className={styles.liveDot} /> Independent session <kbd>Space w</kbd>
      </div>
    </aside>
  );
}
