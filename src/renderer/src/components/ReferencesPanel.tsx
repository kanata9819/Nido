import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReferenceList, ReferencePreview } from '../../../shared/types';
import FileIcon from './FileIcon';
import styles from '../assets/Nido.module.css';

interface Props {
  workspaceId: string;
  state: ReferenceList;
  root: string;
  visible: boolean;
  focusTick: number;
  onClose: () => void;
  onOpen: (index: number) => void;
}

export default function ReferencesPanel({
  workspaceId,
  state,
  root,
  visible,
  focusTick,
  onClose,
  onOpen
}: Props): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState<ReferencePreview>();
  const [previewError, setPreviewError] = useState('');
  const closePrefix = useRef(false);
  const item = state.items[selected];
  const previewHost = document.getElementById('editor-preview-host');
  useEffect(() => {
    setPreview(undefined);
    setPreviewError('');
    if (!visible || !focused || !item || state.loading) {
      return;
    }
    let cancelled = false;
    void window.nido.previewReference(workspaceId, selected + 1, state.version).then(
      (result) => {
        if (!cancelled) {
          setPreview(result);
        }
      },
      (error) => {
        if (!cancelled) {
          setPreviewError(String(error));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selected, state.version, state.loading, visible, focused, item?.path, item?.line]);
  useEffect(() => {
    setSelected(0);
  }, [state.version]);
  useEffect(() => {
    if (visible) {
      list.current?.focus();
    }
  }, [focusTick, visible]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, visible]);

  return (
    <section
      className={styles.referencesPanel}
      aria-label="References"
      hidden={!visible}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closePrefix.current = false;
          setFocused(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        const closing = closePrefix.current && event.key === 'd';
        closePrefix.current = event.key === ' ';
        if (closing || event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === ' ') {
          event.preventDefault();
        }
      }}
    >
      {visible &&
        focused &&
        item &&
        !state.loading &&
        previewHost &&
        createPortal(
          <section className={styles.referencePreview} aria-label="Reference preview">
            <header>
              <FileIcon path={item.path} />
              <strong title={item.path}>{item.path.replaceAll('\\', '/')}</strong>
              <span>Ln {item.line} · Enter to jump</span>
            </header>
            <div className={styles.referencePreviewCode}>
              {preview ? (
                preview.lines.map((spans, index) => (
                  <div key={index} data-current={preview.first + index === preview.line}>
                    <span aria-hidden="true">{preview.first + index}</span>
                    <code>
                      {spans.map((span, part) => (
                        <span key={part} style={{ color: span.color }}>
                          {span.text || ' '}
                        </span>
                      ))}
                    </code>
                  </div>
                ))
              ) : (
                <p>{previewError || 'Loading preview…'}</p>
              )}
            </div>
          </section>,
          previewHost
        )}
      <div className={styles.referencesToolbar}>
        <strong>
          References <span>{state.loading ? 'Searching…' : state.items.length}</span>
        </strong>
        <span>j/k Select · Enter Jump · Ctrl+J Return · Esc / Space d Close</span>
        <button aria-label="Hide references" onClick={onClose}>
          ×
        </button>
      </div>
      <div
        ref={list}
        className={styles.referencesList}
        role="listbox"
        aria-label="Reference results"
        tabIndex={0}
        aria-busy={state.loading}
        aria-activedescendant={state.items[selected] ? `reference-${selected}` : undefined}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
            return;
          }
          if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const last = Math.max(0, state.items.length - 1);
            if (event.key === 'Home') {
              setSelected(0);
            } else if (event.key === 'End') {
              setSelected(last);
            } else {
              const direction = ['j', 'ArrowDown'].includes(event.key) ? 1 : -1;
              setSelected((index) => Math.max(0, Math.min(last, index + direction)));
            }
          } else if (event.key === 'Enter' && state.items[selected]) {
            event.preventDefault();
            onOpen(selected + 1);
          }
        }}
      >
        {state.items.map((item, index) => {
          const path = item.path.replaceAll('\\', '/');
          const prefix = root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
          const relative = path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path;
          return (
            <div
              key={`${item.path}:${item.line}:${item.column}`}
              id={`reference-${index}`}
              role="option"
              aria-selected={selected === index}
              className={styles.referenceRow}
              onClick={() => {
                setSelected(index);
                list.current?.focus();
              }}
              onDoubleClick={() => onOpen(index + 1)}
            >
              <FileIcon path={item.path} />
              <span className={styles.referencePath} title={item.path}>
                {relative}
              </span>
              <span className={styles.referencePosition}>
                {item.line}:{item.column}
              </span>
              <code>{item.text.trim()}</code>
            </div>
          );
        })}
        {state.error && <p role="alert">{state.error}</p>}
        {!state.loading && !state.error && !state.items.length && <p>No references found.</p>}
      </div>
    </section>
  );
}
