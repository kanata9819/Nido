import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type RefObject
} from 'react';
import { CircleAlert, History, MessageSquare, Search, Terminal, X } from 'lucide-react';
import {
    emptyNeovimUI,
    splitCommandContent,
    type MessageChunk,
    type NeovimCommandLine
} from '../../../shared/neovimUI';
import { useI18n } from '../i18n';
import { color } from '../gridColors';
import { type Grid } from '../grid';
import { vimKey } from '../keyboard';
import styles from '../assets/NeovimUI.module.css';
import OverlayPresence from './OverlayPresence';

// Keep the existing IME textarea aligned with the external command cursor.
function positionCommandInput(
    anchor: HTMLTextAreaElement,
    cursor: HTMLSpanElement,
    body: HTMLDivElement
): void {
    const bounds = cursor.getBoundingClientRect();
    const content = body.getBoundingClientRect();
    if (bounds.right > content.right - 8) {
        body.scrollLeft += bounds.right - content.right + 8;
    }
    if (bounds.left < content.left + 8) {
        body.scrollLeft += bounds.left - content.left - 8;
    }
    if (bounds.bottom > content.bottom) {
        body.scrollTop += bounds.bottom - content.bottom;
    }
    if (bounds.top < content.top) {
        body.scrollTop += bounds.top - content.top;
    }
    const host = anchor.parentElement!.getBoundingClientRect();
    const point = cursor.getBoundingClientRect();
    anchor.style.left = `${point.left - host.left}px`;
    anchor.style.top = `${point.top - host.top}px`;
}

function Chunks({ content, grid }: { content: MessageChunk[]; grid: Grid }): React.JSX.Element {
    return (
        <>
            {content.map(([id, text], index) => {
                const highlight = grid.highlights.get(id);
                const foreground = highlight?.reverse
                    ? highlight.background
                    : highlight?.foreground;
                const style: CSSProperties = {
                    color: foreground === undefined ? undefined : color(foreground),
                    fontWeight: highlight?.bold ? 700 : undefined,
                    fontStyle: highlight?.italic ? 'italic' : undefined
                };
                return (
                    <span key={index} style={style}>
                        {text}
                    </span>
                );
            })}
        </>
    );
}

function CommandLine({
    command,
    grid,
    caret,
    current
}: {
    command: NeovimCommandLine;
    grid: Grid;
    caret: RefObject<HTMLSpanElement | null>;
    current: boolean;
}): React.JSX.Element {
    const { before, cursor, after } = splitCommandContent(command.content, command.position);
    return (
        <div className={styles.commandLine} data-current={current}>
            <span className={styles.prefix}>{command.firstCharacter}</span>
            <Chunks content={[[command.highlight, command.prompt]]} grid={grid} />
            {' '.repeat(Math.max(0, command.indent))}
            <Chunks content={before} grid={grid} />
            {current ? (
                <span ref={caret} className={styles.caret} data-neovim-caret>
                    {command.special?.text ||
                        (cursor.length ? <Chunks content={cursor} grid={grid} /> : ' ')}
                </span>
            ) : (
                <Chunks content={cursor} grid={grid} />
            )}
            {command.special?.shift && <Chunks content={cursor} grid={grid} />}
            <Chunks content={after} grid={grid} />
        </div>
    );
}

export default function NeovimUI({
    id,
    grid,
    input,
    paint,
    fontFamily,
    hidden,
    onError
}: {
    id: string;
    grid: RefObject<Grid>;
    input: RefObject<HTMLTextAreaElement | null>;
    paint: RefObject<() => void>;
    fontFamily: string;
    hidden: boolean;
    onError: (message: string) => void;
}): React.JSX.Element {
    const t = useI18n();
    const [state, setState] = useState(emptyNeovimUI);
    const [dismissed, setDismissed] = useState({ messages: -1, history: -1 });
    const caret = useRef<HTMLSpanElement>(null);
    const commandCard = useRef<HTMLDivElement>(null);
    const commandBody = useRef<HTMLDivElement>(null);
    const messageBody = useRef<HTMLDivElement>(null);
    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.id === id && event.type === 'neovimUI') {
                    setState(event.state);
                }
            }),
        [id]
    );

    const commands = Object.values(state.commands).sort((a, b) => a.level - b.level);
    const current = commands.at(-1);
    const showCommand = !hidden && (Boolean(current) || state.block.length > 0);
    const showHistory = state.history !== null && dismissed.history !== state.historyVersion;
    const messages = showHistory ? state.history! : state.messages;
    const showMessages =
        !hidden &&
        (showHistory || (messages.length > 0 && dismissed.messages !== state.messageVersion));
    const prompt = state.messages.findLast(
        (message) => message.kind === 'confirm' || message.kind === 'return_prompt'
    );
    const auxiliary = [state.showmode, state.showcmd, state.ruler].filter(
        (content) => content.length
    );

    const send = (keys: string): void => {
        void window.nido.input(id, keys).catch((error) => onError(String(error)));
        input.current?.focus();
    };
    const closeMessages = (): void => {
        if (prompt) {
            send('<Esc>');
        }
        setDismissed({ messages: state.messageVersion, history: state.historyVersion });
        input.current?.focus();
    };

    useLayoutEffect(() => {
        const anchor = input.current;
        const cursor = caret.current;
        const card = commandCard.current;
        const body = commandBody.current;
        if (!showCommand || !current || !anchor || !cursor || !card || !body) {
            return;
        }
        anchor.setAttribute('data-nvim-command-active', '');
        anchor.setAttribute('aria-describedby', `neovim-command-${id}`);
        const position = (): void => positionCommandInput(anchor, cursor, body);
        position();
        const observer = new ResizeObserver(position);
        observer.observe(card);
        observer.observe(anchor.parentElement!);
        body.addEventListener('scroll', position);
        const repaint = paint.current;
        return () => {
            observer.disconnect();
            body.removeEventListener('scroll', position);
            anchor.removeAttribute('data-nvim-command-active');
            anchor.removeAttribute('aria-describedby');
            repaint();
        };
    }, [state.commands, showCommand, current, input, id, paint]);

    useLayoutEffect(() => {
        if (!showMessages) {
            return;
        }
        const body = messageBody.current;
        if (body && !showHistory) {
            body.scrollTop = body.scrollHeight;
        }
    }, [showMessages, showHistory, state.messageVersion, state.historyVersion]);

    useLayoutEffect(() => {
        const anchor = input.current;
        if (!anchor || !state.completion || !current || hidden) {
            return;
        }
        anchor.setAttribute('aria-autocomplete', 'list');
        anchor.setAttribute('aria-controls', `neovim-completion-${id}`);
        if (state.completion.selected >= 0) {
            anchor.setAttribute(
                'aria-activedescendant',
                `neovim-completion-${id}-${state.completion.selected}`
            );
        }
        commandCard.current
            ?.querySelector('[aria-selected="true"]')
            ?.scrollIntoView({ block: 'nearest' });
        return () => {
            anchor.removeAttribute('aria-autocomplete');
            anchor.removeAttribute('aria-controls');
            anchor.removeAttribute('aria-activedescendant');
        };
    }, [state.completion, current, input, hidden, id]);

    return (
        <>
            <OverlayPresence>
                {showCommand ? (
                    <div
                        ref={commandCard}
                        className={styles.command}
                        data-neovim-ui
                        role="dialog"
                        aria-label={t('Neovim command line')}
                        style={{ fontFamily }}
                        onMouseDown={(event) => {
                            event.preventDefault();
                            input.current?.focus();
                        }}
                    >
                        <div className={styles.header} id={`neovim-command-${id}`}>
                            {current?.firstCharacter === '/' || current?.firstCharacter === '?' ? (
                                <Search size={15} />
                            ) : (
                                <Terminal size={15} />
                            )}
                            <strong>
                                {t(
                                    current?.firstCharacter === '/' ||
                                        current?.firstCharacter === '?'
                                        ? 'Search'
                                        : 'Command line'
                                )}
                            </strong>
                            <span className={styles.hint}>
                                <kbd>Enter</kbd> {t('Run')} · <kbd>Esc</kbd> {t('Cancel')}
                            </span>
                            <button aria-label={t('Cancel command')} onClick={() => send('<Esc>')}>
                                <X size={16} />
                            </button>
                        </div>
                        <div
                            ref={commandBody}
                            className={styles.commandBody}
                            aria-label={t('Command content')}
                        >
                            {state.block.map((line, index) => (
                                <div key={index} className={styles.blockLine}>
                                    <Chunks content={line} grid={grid.current} />
                                </div>
                            ))}
                            {commands.map((command) => (
                                <CommandLine
                                    key={command.level}
                                    command={command}
                                    grid={grid.current}
                                    caret={caret}
                                    current={command.level === current?.level}
                                />
                            ))}
                        </div>
                        <OverlayPresence>
                            {state.completion ? (
                                <div
                                    className={styles.completion}
                                    id={`neovim-completion-${id}`}
                                    role="listbox"
                                    aria-label={t('Command completion')}
                                >
                                    {state.completion.items.map(([word, , detail], index) => (
                                        <div
                                            key={index}
                                            role="option"
                                            id={`neovim-completion-${id}-${index}`}
                                            aria-selected={index === state.completion?.selected}
                                            onClick={() => {
                                                void window.nido
                                                    .selectCompletion(id, index)
                                                    .catch((error) => onError(String(error)));
                                                input.current?.focus();
                                            }}
                                        >
                                            <span>{word}</span>
                                            {detail && <small>{detail}</small>}
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </OverlayPresence>
                    </div>
                ) : null}
            </OverlayPresence>
            <OverlayPresence>
                {showMessages ? (
                    <div
                        className={styles.messages}
                        data-neovim-ui
                        role="dialog"
                        aria-label={t(showHistory ? 'Message history' : 'Neovim messages')}
                        style={{ fontFamily }}
                    >
                        <div className={styles.header}>
                            {showHistory ? <History size={15} /> : <MessageSquare size={15} />}
                            <strong>
                                {t(showHistory ? 'Message history' : 'Neovim messages')}
                            </strong>
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
                                } else if (
                                    prompt &&
                                    !event.ctrlKey &&
                                    !event.metaKey &&
                                    !event.altKey
                                ) {
                                    const key = vimKey(event.nativeEvent);
                                    if (key) {
                                        event.preventDefault();
                                        send(key);
                                    }
                                } else if (
                                    (event.ctrlKey && ['u', 'd'].includes(event.key)) ||
                                    (!event.ctrlKey &&
                                        !event.altKey &&
                                        ['j', 'k'].includes(event.key))
                                ) {
                                    event.preventDefault();
                                    const down = event.key === 'j' || event.key === 'd';
                                    event.currentTarget.scrollBy({
                                        top:
                                            (down ? 1 : -1) *
                                            (event.ctrlKey
                                                ? event.currentTarget.clientHeight / 2
                                                : 32)
                                    });
                                }
                            }}
                        >
                            {messages.map((message, index) => (
                                <article
                                    key={index}
                                    data-kind={message.kind}
                                    data-severity={
                                        /emsg|echoerr|lua_error|rpc_error|shell_err/.test(
                                            message.kind
                                        )
                                            ? 'error'
                                            : message.kind === 'wmsg'
                                              ? 'warning'
                                              : 'info'
                                    }
                                >
                                    {/emsg|echoerr|lua_error|rpc_error|shell_err|wmsg/.test(
                                        message.kind
                                    ) && <CircleAlert size={14} aria-hidden="true" />}
                                    <pre>
                                        <Chunks content={message.content} grid={grid.current} />
                                    </pre>
                                </article>
                            ))}
                            {showHistory && !messages.length && (
                                <p className={styles.empty}>{t('No messages')}</p>
                            )}
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
            <OverlayPresence>
                {!hidden && auxiliary.length > 0 ? (
                    <div
                        className={styles.auxiliary}
                        data-neovim-ui
                        role="status"
                        style={{ fontFamily }}
                    >
                        {auxiliary.map((content, index) => (
                            <span key={index}>
                                <Chunks content={content} grid={grid.current} />
                            </span>
                        ))}
                    </div>
                ) : null}
            </OverlayPresence>
        </>
    );
}
