import type { RefObject } from 'react';
import { CircleAlert, History, MessageSquare, X } from 'lucide-react';
import type { NeovimMessage } from '../../../shared/neovimUI';
import type { Grid } from '../grid';
import { useI18n } from '../i18n';
import { vimKey } from '../keyboard';
import styles from '../assets/NeovimUI.module.css';
import Chunks from './NeovimUIChunks';
import OverlayPresence from './OverlayPresence';

export default function NeovimMessages({
  visible,
  showHistory,
  messages,
  prompt,
  fontFamily,
  messageBody,
  grid,
  input,
  send,
  closeMessages
}: {
  visible: boolean;
  showHistory: boolean;
  messages: NeovimMessage[];
  prompt: NeovimMessage | undefined;
  fontFamily: string;
  messageBody: RefObject<HTMLDivElement | null>;
  grid: RefObject<Grid>;
  input: RefObject<HTMLTextAreaElement | null>;
  send: (keys: string) => void;
  closeMessages: () => void;
}): React.JSX.Element {
  const t = useI18n();
  return (
    <OverlayPresence>
      {visible ? (
        <div
          className={styles.messages}
          data-neovim-ui
          role="dialog"
          aria-label={t(showHistory ? 'Message history' : 'Neovim messages')}
          style={{ fontFamily }}
        >
          <div className={styles.header}>
            {showHistory ? <History size={15} /> : <MessageSquare size={15} />}
            <strong>{t(showHistory ? 'Message history' : 'Neovim messages')}</strong>
            <span className={styles.count}>{messages.length}</span>
            <span className={styles.hint}>
              <kbd>Alt Shift M</kbd> {t('Focus')}
            </span>
            <button aria-label={t('Close messages')} onClick={closeMessages}>
              <X size={16} />
            </button>
          </div>
          <div
            ref={messageBody}
            className={styles.messageBody}
            tabIndex={0}
            aria-label={t('Message content')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeMessages();
              } else if (prompt && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const key = vimKey(event.nativeEvent);
                if (key) {
                  event.preventDefault();
                  send(key);
                }
              } else if (
                (event.ctrlKey && ['u', 'd'].includes(event.key)) ||
                (!event.ctrlKey && !event.altKey && ['j', 'k'].includes(event.key))
              ) {
                event.preventDefault();
                const down = event.key === 'j' || event.key === 'd';
                event.currentTarget.scrollBy({
                  top: (down ? 1 : -1) * (event.ctrlKey ? event.currentTarget.clientHeight / 2 : 32)
                });
              }
            }}
          >
            {messages.map((message, index) => (
              <article
                key={index}
                data-kind={message.kind}
                data-severity={
                  /emsg|echoerr|lua_error|rpc_error|shell_err/.test(message.kind)
                    ? 'error'
                    : message.kind === 'wmsg'
                      ? 'warning'
                      : 'info'
                }
              >
                {/emsg|echoerr|lua_error|rpc_error|shell_err|wmsg/.test(message.kind) && (
                  <CircleAlert size={14} aria-hidden="true" />
                )}
                <pre>
                  <Chunks content={message.content} grid={grid.current} />
                </pre>
              </article>
            ))}
            {showHistory && !messages.length && <p className={styles.empty}>{t('No messages')}</p>}
          </div>
          {prompt && (
            <div className={styles.footer}>
              {prompt.kind === 'return_prompt' ? (
                <button onClick={() => send('<CR>')}>
                  <kbd>Enter</kbd> {t('Continue')}
                </button>
              ) : (
                <button onClick={() => input.current?.focus()}>
                  {t('Type a choice to continue')}
                </button>
              )}
              <button onClick={closeMessages}>
                <kbd>Esc</kbd> {t('Cancel')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </OverlayPresence>
  );
}
