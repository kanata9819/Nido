import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileEntry, Workspace } from '../../shared/types'
import styles from './Nido.module.css'

interface Props {
  workspace: Workspace
  active: boolean
  currentFile: string
  onOpen: (path: string) => void
  onError: (message: string) => void
}
export default function Sidebar({
  workspace,
  active,
  currentFile,
  onOpen,
  onError
}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState('')
  const load = async (path: string): Promise<void> => {
    try {
      const files = await window.nido.files(workspace.id, path)
      setEntries((old) => ({ ...old, [path]: files }))
    } catch (e) {
      onError(String(e))
    }
  }
  useEffect(() => {
    let cancelled = false
    window.nido
      .files(workspace.id, '')
      .then((files) => {
        if (!cancelled) setEntries({ '': files })
      })
      .catch((e) => {
        if (!cancelled) onError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [workspace.id, onError])
  const visible: (FileEntry & { depth: number })[] = []
  const visit = (path: string, depth: number): void => {
    for (const entry of entries[path] || []) {
      visible.push({ ...entry, depth })
      if (entry.directory && expanded.has(entry.path)) visit(entry.path, depth + 1)
    }
  }
  visit('', 0)
  const toggle = (entry: FileEntry): void => {
    setSelected(entry.path)
    if (!entry.directory) {
      onOpen(entry.path)
      return
    }
    const next = new Set(expanded)
    if (next.has(entry.path)) next.delete(entry.path)
    else {
      next.add(entry.path)
      void load(entry.path)
    }
    setExpanded(next)
  }
  return (
    <aside className={styles.sidebar} aria-label="File explorer" hidden={!active}>
      <div className={styles.sidebarHeading}>
        <span>{workspace.name}</span>
        <button title="Refresh files" aria-label="Refresh files" onClick={() => void load('')}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div
        className={styles.tree}
        role="tree"
        tabIndex={0}
        aria-label="Project files"
        aria-activedescendant={selected ? `file-${workspace.id}-${selected}` : undefined}
        onKeyDown={(event) => {
          const index = visible.findIndex((entry) => entry.path === selected),
            item = visible[Math.max(0, index)]
          if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? visible.length - 1
                  : Math.min(
                      visible.length - 1,
                      Math.max(0, index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1))
                    )
            if (visible[next]) {
              setSelected(visible[next].path)
              document
                .getElementById(`file-${workspace.id}-${visible[next].path}`)
                ?.scrollIntoView({ block: 'nearest' })
            }
          } else if (item && ['Enter', 'l', 'ArrowRight'].includes(event.key)) {
            event.preventDefault()
            if (!item.directory || !expanded.has(item.path) || event.key === 'Enter') toggle(item)
          } else if (item && ['h', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault()
            if (expanded.has(item.path)) {
              const next = new Set(expanded)
              next.delete(item.path)
              setExpanded(next)
            } else {
              const parent = item.path.replace(/[\\/][^\\/]+$/, '')
              if (parent !== item.path) setSelected(parent)
            }
          }
        }}
      >
        {visible.map((entry) => (
          <div
            key={entry.path}
            id={`file-${workspace.id}-${entry.path}`}
            role="treeitem"
            aria-level={entry.depth + 1}
            aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
            aria-selected={selected === entry.path}
            className={`${styles.treeItem} ${selected === entry.path ? styles.treeSelected : ''} ${currentFile.endsWith(entry.path) ? styles.currentFile : ''}`}
            style={{ paddingLeft: 14 + entry.depth * 16 }}
            onClick={() => toggle(entry)}
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
              <FileCode2 size={15} className={styles.fileIcon} />
            )}
            <span>{entry.name}</span>
          </div>
        ))}
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
  )
}
