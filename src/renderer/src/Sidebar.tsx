import { useI18n } from './i18n';
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw, Command } from 'lucide-react';
import ExplorerCommands from './components/ExplorerCommands';
import FileIcon from './components/FileIcon';
import DiagnosticBadges from './components/DiagnosticBadges';
import type { Workspace } from '../../shared/types';
import { useExplorer } from './hooks/useExplorer';
import { toggle } from './sidebarToggle';
import { createExplorerKeyHandler } from './sidebarKeyboard';
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

const rowHeight = 26;
const overscan = 8;

// Hidden trees keep their DOM and local state; refresh parent props when activated.
export default memo(
  Sidebar,
  (previous, next) =>
    previous.workspace === next.workspace &&
    ((!previous.active && !next.active) ||
      (previous.active === next.active &&
        previous.gitFiles === next.gitFiles &&
        previous.width === next.width &&
        previous.currentFile === next.currentFile &&
        previous.onResize === next.onResize &&
        previous.onOpen === next.onOpen &&
        previous.onError === next.onError))
);

function Sidebar({
  gitFiles,
  workspace,
  active,
  currentFile,
  onOpen,
  onError,
  width,
  onResize
}: Props): React.JSX.Element {
  const t = useI18n();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const centerPrefix = useRef(false);
  const {
    visible,
    expanded,
    selected,
    selectedIndex,
    setSelected,
    setExpanded,
    load,
    tree,
    ready,
    initialScrollTop,
    rememberScroll,
    operation,
    setOperation,
    clipboard,
    commands,
    closeOperation,
    onDone
  } = useExplorer({ workspace, active, onError });
  const [top, setTop] = useState(initialScrollTop);
  const viewport = useRef(initialScrollTop);
  const restored = useRef(false);
  const previousSelection = useRef(selected);
  const [height, setHeight] = useState(200);
  const first = Math.max(
    0,
    Math.min(visible.length - 1, Math.floor(Math.max(0, top - 5) / rowHeight) - overscan)
  );
  const last = Math.min(visible.length, Math.ceil((top + height) / rowHeight) + overscan);
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  if (selectedIndex >= 0 && selectedIndex < first) {
    indices.unshift(selectedIndex);
  } else if (selectedIndex >= last) {
    indices.push(selectedIndex);
  }
  useLayoutEffect(() => {
    const node = tree.current;
    if (!active) {
      restored.current = false;
    }
    if (!node || !active || !ready) {
      return;
    }
    setHeight(node.clientHeight);
    if (!restored.current) {
      node.scrollTo({ top: viewport.current });
      restored.current = true;
      previousSelection.current = selected;
      rememberScroll(node.scrollTop);
    } else if (selected !== previousSelection.current && selectedIndex >= 0) {
      const rowTop = selectedIndex * rowHeight + 5;
      if (rowTop < node.scrollTop) {
        node.scrollTo({ top: rowTop });
      } else if (rowTop + rowHeight > node.scrollTop + node.clientHeight) {
        node.scrollTo({ top: rowTop + rowHeight - node.clientHeight });
      }
    }
    if (selectedIndex >= 0 || !selected) {
      previousSelection.current = selected;
    }
    viewport.current = node.scrollTop;
    setTop(node.scrollTop);
  }, [selected, selectedIndex, visible, active, ready, tree, rememberScroll]);
  useEffect(() => {
    const node = tree.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setHeight(node.clientHeight);
      setTop(node.scrollTop);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tree]);
  const rootDecoration = gitFiles[gitFileKey(workspace.root).replace(/\/$/, '')];

  return (
    <aside
      className={styles.sidebar}
      aria-label={t('File explorer')}
      hidden={!active}
      style={{ width }}
      onKeyDownCapture={(event) => {
        if (
          (event.target as Element).closest('[data-explorer-commands]') ||
          event.nativeEvent.isComposing ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey
        ) {
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
        aria-label={t('Explorer width')}
        aria-orientation="vertical"
        aria-valuemin={160}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        title={t('Drag to resize · Shift+H / L')}
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
        <button
          title={t('Explorer commands (:)')}
          aria-label={t('Explorer commands')}
          onClick={() => setOperation({})}
        >
          <Command size={14} />
        </button>
        <button
          title={t('Refresh files')}
          aria-label={t('Refresh files')}
          onClick={() => void load('')}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div
        ref={tree}
        className={styles.tree}
        role="tree"
        data-row-count={visible.length}
        tabIndex={0}
        aria-label={t('Project files')}
        title={t(
          'j/k Select · zz Center selection · : Commands · a/A New file/folder · F2 Rename · Ctrl+C/X/V Copy/Cut/Paste · Delete'
        )}
        aria-activedescendant={selectedIndex >= 0 ? `file-${workspace.id}-${selected}` : undefined}
        aria-busy={!ready}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setTop(top);
          if (active && restored.current) {
            viewport.current = top;
            rememberScroll(top);
          }
        }}
        onBlur={() => {
          centerPrefix.current = false;
        }}
        onKeyDown={(event) => {
          const pending = centerPrefix.current;
          centerPrefix.current = false;
          if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
            return;
          }
          if (event.key === 'z' && !event.ctrlKey && !event.shiftKey && !event.repeat) {
            event.preventDefault();
            event.stopPropagation();
            centerPrefix.current = !pending;
            if (pending) {
              const row = document.getElementById(`file-${workspace.id}-${selected}`);
              if (row) {
                const viewport = event.currentTarget;
                const bounds = viewport.getBoundingClientRect();
                const target = row.getBoundingClientRect();
                viewport.scrollTop +=
                  target.top + target.height / 2 - bounds.top - viewport.clientHeight / 2;
              }
            }
            return;
          }
          if (
            event.key === ':' ||
            event.key === 'ContextMenu' ||
            (event.shiftKey && event.key === 'F10')
          ) {
            event.preventDefault();
            event.stopPropagation();
            setOperation({});
            return;
          }
          const key = event.ctrlKey
            ? ({ c: 'c', x: 'x', v: 'p' } as Record<string, string>)[event.key.toLowerCase()]
            : event.key === 'F2'
              ? 'r'
              : event.key === 'Delete'
                ? 'd'
                : event.key;
          const command = commands.find((command) => command.key === key);
          if (command) {
            event.preventDefault();
            event.stopPropagation();
            if (!command.disabled) {
              command.run();
            }
            return;
          }
          createExplorerKeyHandler({
            visible,
            selectedIndex,
            expanded,
            setSelected,
            setExpanded,
            load,
            onOpen
          })(event);
        }}
      >
        <div style={{ height: visible.length * rowHeight, position: 'relative' }}>
          {indices.map((index) => {
            const entry = visible[index];
            const decoration = gitFiles[gitFileKey(`${workspace.root}/${entry.path}`)];
            return (
              <div
                key={entry.path}
                id={`file-${workspace.id}-${entry.path}`}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-posinset={entry.position}
                aria-setsize={entry.siblings}
                aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
                aria-selected={selected === entry.path}
                data-ignored={entry.ignored || undefined}
                className={`${styles.treeItem} ${selected === entry.path ? styles.treeSelected : ''} ${currentFile.endsWith(entry.path) ? styles.currentFile : ''}`}
                style={
                  {
                    '--tree-depth': entry.depth,
                    position: 'absolute',
                    top: index * rowHeight,
                    left: 0,
                    right: 0
                  } as CSSProperties
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelected(entry.path);
                  setOperation({});
                }}
                onClick={() =>
                  toggle({
                    entry,
                    expanded,
                    setExpanded,
                    setSelected,
                    onOpen,
                    load
                  })
                }
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
                {!entry.directory && <DiagnosticBadges decoration={decoration} />}
                {!entry.directory && decoration?.code && (
                  <span
                    className={styles.gitBadge}
                    data-status={decoration.code}
                    title={t(decoration.title)}
                    aria-label={t(decoration.title)}
                  >
                    {decoration.code}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {!visible.length && (
          <p className={styles.emptyTree}>
            {t('No files yet.')}
            <br />
            {t('Press')} <kbd>a</kbd> {t('for a file or')} <kbd>A</kbd> {t('for a folder.')}
          </p>
        )}
      </div>
      <div className={styles.sidebarFooter}>
        <span className={styles.liveDot} />{' '}
        {clipboard
          ? `${clipboard.cut ? t('Cut') : t('Copied')}: ${clipboard.name}`
          : t('File commands')}{' '}
        <kbd>:</kbd>
      </div>
      <ExplorerCommands
        visible={!!operation}
        workspaceId={workspace.id}
        request={operation?.request}
        commands={commands}
        onClose={closeOperation}
        onDone={onDone}
      />
    </aside>
  );
}
