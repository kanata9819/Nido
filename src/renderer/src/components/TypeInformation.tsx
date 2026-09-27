import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Braces, X } from 'lucide-react';
import styles from '../assets/TypeInformation.module.css';
import type { NidoEvent } from '../../../shared/types';

export default function TypeInformation({
  id,
  input,
  fontFamily
}: {
  id: string;
  input: RefObject<HTMLTextAreaElement | null>;
  fontFamily: string;
}): React.JSX.Element | null {
  const [info, setInfo] = useState<Extract<NidoEvent, { type: 'hover' }>>();
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = (): void => {
    setInfo(undefined);
    input.current?.focus();
  };

  useEffect(
    () =>
      window.nido.onEvent((event) => {
        if (event.type !== 'hover' || event.id !== id) return;
        if (!event.markdown && card.current?.contains(document.activeElement)) input.current?.focus();
        setInfo(event.markdown ? event : undefined);
      }),
    [id, input]
  );

  useLayoutEffect(() => {
    const element = card.current;
    const anchor = input.current;
    if (!info || !element || !anchor) return;
    const host = element.parentElement!;
    const position = (): void => {
      const below = anchor.offsetTop + anchor.offsetHeight + 10;
      const above = anchor.offsetTop - element.offsetHeight - 10;
      element.style.left = `${Math.max(12, Math.min(anchor.offsetLeft, host.clientWidth - element.offsetWidth - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(below + element.offsetHeight <= host.clientHeight - 12 ? below : above, host.clientHeight - element.offsetHeight - 12))}px`;
    };
    position();
    body.current?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(host);
    observer.observe(element);
    const outside = (event: PointerEvent): void => {
      if (!element.contains(event.target as Node)) setInfo(undefined);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [info, input]);

  if (!info) return null;
  // ponytail: fenced code and inline emphasis only; use a Markdown renderer if richer documentation is needed.
  const blocks = info.markdown.split(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm);
  return (
    <div
      ref={card}
      className={styles.card}
      role="dialog"
      aria-label="Type information"
      data-type-information
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        const key = event.key.toLowerCase();
        const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
        if (event.key === 'Escape' || (ctrl && ['c', 'k'].includes(key))) {
          event.preventDefault();
          close();
        } else if (ctrl && ['d', 'u', 'f', 'b'].includes(key)) {
          event.preventDefault();
          const content = body.current!;
          content.scrollTop +=
            (['d', 'f'].includes(key) ? 1 : -1) * content.clientHeight * (['d', 'u'].includes(key) ? 0.5 : 1);
        } else if (event.key === 'Tab') {
          event.preventDefault();
          const button = card.current?.querySelector('button');
          if (document.activeElement === button) body.current?.focus();
          else button?.focus();
        } else if (
          !event.ctrlKey &&
          !event.altKey &&
          ['j', 'k', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const content = body.current!;
          if (event.key === 'Home') content.scrollTop = 0;
          else if (event.key === 'End') content.scrollTop = content.scrollHeight;
          else
            content.scrollTop +=
              (['j', 'PageDown'].includes(event.key) ? 1 : -1) *
              (event.key.length === 1 ? 32 : content.clientHeight * 0.8);
        }
      }}
    >
      <header>
        <Braces size={17} />
        <strong>Type information</strong>
        <span>{info.filetype}</span>
        <button aria-label="Close type information" title="Close (Esc / Ctrl+C)" onClick={close}>
          <X size={16} />
        </button>
      </header>
      <div ref={body} className={styles.body} tabIndex={0} aria-label="Type information content">
        {blocks.map((block, index) =>
          index % 3 === 2 || (!block.trim() && index % 3 === 0) ? null : index % 3 === 1 ? (
            <section className={styles.code} key={index}>
              {block.trim() && <span>{block.trim()}</span>}
              <pre style={{ fontFamily }}>
                <code>
                  {info.codeBlocks[Math.floor(index / 3)]?.length
                    ? info.codeBlocks[Math.floor(index / 3)].map((line, row) => (
                        <span key={row}>
                          {row > 0 && '\n'}
                          {line.map((span, col) => (
                            <span key={col} style={{ color: span.color }}>
                              {span.text}
                            </span>
                          ))}
                        </span>
                      ))
                    : blocks[index + 1].trimEnd()}
                </code>
              </pre>
            </section>
          ) : (
            <div className={styles.prose} key={index}>
              {block
                .trim()
                .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
                .map((part, i) =>
                  part.startsWith('`') ? (
                    <code key={i}>{part.slice(1, -1)}</code>
                  ) : part.startsWith('**') ? (
                    <strong key={i}>{part.slice(2, -2)}</strong>
                  ) : (
                    part
                  )
                )}
            </div>
          )
        )}
      </div>
      <footer>
        <span title="↑ ↓ / j k: line · Ctrl+D/U: half page · Ctrl+F/B: page">Ctrl D / U · Scroll</span>
        <span>Esc / Ctrl C · Back to editor</span>
      </footer>
    </div>
  );
}
