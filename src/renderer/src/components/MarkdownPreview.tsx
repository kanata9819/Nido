import { onNidoEvent } from '../nidoEvents';
import { useI18n } from '../i18n';
import { memo, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import prose from '../assets/TypeInformation.module.css';
import styles from '../assets/MarkdownPreview.module.css';

export default memo(MarkdownPreview);

function MarkdownPreview({
  workspaceId,
  onClose,
  focusEditor
}: {
  workspaceId: string;
  onClose: () => void;
  focusEditor: () => void;
}): React.JSX.Element {
  const t = useI18n();
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let token = '';
    let timer: number | undefined;
    let pending = false;
    let dirty = true;
    body.current?.focus();
    const refresh = (): void => {
      if (cancelled || document.hidden || pending || !dirty) {
        return;
      }
      pending = true;
      dirty = false;
      const current = generation;
      window.nido
        .markdownPreview(workspaceId, token)
        .then((value) => {
          if (!cancelled && current === generation) {
            token = value.token;
            if (value.text !== undefined) {
              setSource(value.text);
            }
            setError('');
          }
        })
        .catch((error) => {
          if (!cancelled && current === generation) {
            setError(String(error));
          }
        })
        .finally(() => {
          pending = false;
          // A slow read may span several edits. Fetch only their latest
          // state once the current read and the existing delay finish.
          if (!timer) {
            refresh();
          }
        });
    };
    const schedule = (): void => {
      generation++;
      dirty = true;
      window.clearTimeout(timer);
      timer = undefined;
      if (document.hidden) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        refresh();
      }, 150);
    };
    const visibilityChanged = (): void => {
      generation++;
      dirty = true;
      window.clearTimeout(timer);
      timer = undefined;
      refresh();
    };
    const unsubscribe = onNidoEvent((event) => {
      if (event.id !== workspaceId) {
        return;
      }
      if (
        (event.type === 'redraw' && event.events.some(([name]) => name === 'nido_edit')) ||
        ((event.type === 'state' || event.type === 'statePatch') &&
          (event.state.current !== undefined || event.state.filetype !== undefined))
      ) {
        schedule();
      }
    });
    document.addEventListener('visibilitychange', visibilityChanged);
    refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      unsubscribe();
    };
  }, [workspaceId]);
  return (
    <section className={styles.pane} aria-label={t('Markdown preview')}>
      <header>
        <strong>{t('Markdown preview')}</strong>
        <span>Ctrl+J · Ctrl+Shift+V</span>
        <button onClick={onClose} aria-label={t('Close preview')}>
          ×
        </button>
      </header>
      <div
        ref={body}
        className={styles.markdownPreview}
        tabIndex={0}
        aria-label={t('Markdown preview content')}
        data-markdown-preview
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
            return;
          }
          const key = event.key.toLowerCase();
          if (event.key === 'Escape' || (event.ctrlKey && key === 'j')) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') {
              onClose();
            } else {
              focusEditor();
            }
            return;
          }
          const content = event.currentTarget;
          if (event.ctrlKey && ['d', 'u', 'f', 'b'].includes(key)) {
            event.preventDefault();
            content.scrollTop +=
              (['d', 'f'].includes(key) ? 1 : -1) *
              content.clientHeight *
              (['d', 'u'].includes(key) ? 0.5 : 1);
          } else if (!event.ctrlKey && ['j', 'k', 'g', 'G'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'g') {
              content.scrollTop = 0;
            } else if (event.key === 'G') {
              content.scrollTop = content.scrollHeight;
            } else {
              content.scrollTop += event.key === 'j' ? 40 : -40;
            }
          }
        }}
      >
        <article className={prose.prose}>
          {error ? (
            <p role="alert">{error}</p>
          ) : source === undefined ? (
            <p>{t('Loading…')}</p>
          ) : (
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: ({ alt }) => <span>{alt}</span>,
                a: ({ href, children }) =>
                  href && /^https?:\/\//i.test(href) ? (
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        void window.nido
                          .openDocumentation(href)
                          .catch((error) => setError(String(error)));
                      }}
                    >
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  )
              }}
            >
              {source}
            </Markdown>
          )}
        </article>
      </div>
    </section>
  );
}
