import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
    ChevronDown,
    ChevronUp,
    CircleAlert,
    Info,
    Lightbulb,
    TriangleAlert,
    X
} from 'lucide-react';
import type { NidoEvent } from '../../../shared/types';
import { useI18n } from '../i18n';
import styles from '../assets/DiagnosticInformation.module.css';

const severities = [
    { label: 'Error', name: 'error', icon: CircleAlert },
    { label: 'Warning', name: 'warning', icon: TriangleAlert },
    { label: 'Information', name: 'info', icon: Info },
    { label: 'Hint', name: 'hint', icon: Lightbulb }
];

function Message({ text, fontFamily }: { text: string; fontFamily: string }): React.JSX.Element {
    return (
        <>
            {text.split(/(`[^`\n]+`)/g).map((part, index) =>
                part.startsWith('`') && part.endsWith('`') ? (
                    <code key={index} style={{ fontFamily }}>
                        {part.slice(1, -1)}
                    </code>
                ) : (
                    part
                )
            )}
        </>
    );
}

export default function DiagnosticInformation({
    id,
    input,
    fontFamily,
    onError
}: {
    id: string;
    input: RefObject<HTMLTextAreaElement | null>;
    fontFamily: string;
    onError: (message: string) => void;
}): React.JSX.Element | null {
    const t = useI18n();
    const [info, setInfo] = useState<Extract<NidoEvent, { type: 'diagnostics' }>>();
    const card = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const keys = useRef('');
    const close = (): void => {
        keys.current = '';
        setInfo(undefined);
        input.current?.focus();
    };
    const jump = (sequence: string): void => {
        keys.current = '';
        void window.nido.input(id, sequence).catch((error) => onError(String(error)));
    };

    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.id !== id) {
                    return;
                }
                if (event.type === 'diagnostics') {
                    if (!event.items.length) {
                        keys.current = '';
                    }
                    if (!event.items.length && card.current?.contains(document.activeElement)) {
                        input.current?.focus();
                    }
                    setInfo(event.items.length ? event : undefined);
                } else if (event.type === 'hover' && event.markdown) {
                    keys.current = '';
                    setInfo(undefined);
                }
            }),
        [id, input]
    );

    useLayoutEffect(() => {
        const element = card.current;
        const anchor = input.current;
        if (!info || !element || !anchor) {
            return;
        }
        const host = element.parentElement!;
        const position = (): void => {
            const below = anchor.offsetTop + anchor.offsetHeight + 10;
            const above = anchor.offsetTop - element.offsetHeight - 10;
            element.style.left = `${Math.max(12, Math.min(anchor.offsetLeft, host.clientWidth - element.offsetWidth - 12))}px`;
            element.style.top = `${Math.max(
                12,
                Math.min(
                    below + element.offsetHeight <= host.clientHeight - 12 ? below : above,
                    host.clientHeight - element.offsetHeight - 12
                )
            )}px`;
        };
        position();
        body.current!.scrollTop = 0;
        if (info.focus) {
            body.current?.focus();
        }
        const observer = new ResizeObserver(position);
        observer.observe(host);
        observer.observe(element);
        // The diagnostic notification can arrive before the cursor's next canvas paint.
        const anchorObserver = new MutationObserver(position);
        anchorObserver.observe(anchor, { attributes: true, attributeFilter: ['style'] });
        const outside = (event: PointerEvent): void => {
            if (!element.contains(event.target as Node)) {
                keys.current = '';
                setInfo(undefined);
            }
        };
        document.addEventListener('pointerdown', outside, true);
        return () => {
            observer.disconnect();
            anchorObserver.disconnect();
            document.removeEventListener('pointerdown', outside, true);
        };
    }, [info, input]);

    if (!info) {
        return null;
    }
    const first = info.items[0];
    const filename = first.path.replaceAll('\\', '/').split('/').pop() || t('Untitled');
    return (
        <div
            ref={card}
            className={styles.card}
            role="dialog"
            aria-label={t('Diagnostic details')}
            data-diagnostic-information
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) {
                    return;
                }
                const key = event.key.toLowerCase();
                const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
                const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
                if (
                    key === 'escape' ||
                    (ctrl && key === 'c' && !window.getSelection()?.toString())
                ) {
                    event.preventDefault();
                    close();
                } else if (ctrl && key === 'k') {
                    event.preventDefault();
                    close();
                    jump('<C-k>');
                } else if (
                    plain &&
                    /^[0-9]$/.test(key) &&
                    !/\[|\]/.test(keys.current) &&
                    (key !== '0' || keys.current)
                ) {
                    event.preventDefault();
                    keys.current = (keys.current + key).slice(0, 6);
                } else if (plain && ['[', ']'].includes(key)) {
                    event.preventDefault();
                    keys.current = keys.current.replace(/(\[|\])$/, '') + key;
                } else if (plain && key === 'd' && /(\[|\])$/.test(keys.current)) {
                    event.preventDefault();
                    jump(keys.current + 'd');
                } else {
                    keys.current = '';
                    const content = body.current!;
                    if (ctrl && ['d', 'u', 'f', 'b'].includes(key)) {
                        event.preventDefault();
                        content.scrollTop +=
                            (['d', 'f'].includes(key) ? 1 : -1) *
                            content.clientHeight *
                            (['d', 'u'].includes(key) ? 0.5 : 1);
                    } else if (key === 'tab') {
                        event.preventDefault();
                        const nodes = [
                            content,
                            ...card.current!.querySelectorAll<HTMLElement>('button')
                        ];
                        const index = nodes.indexOf(document.activeElement as HTMLElement);
                        nodes[
                            (index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length
                        ]?.focus();
                    } else if (
                        plain &&
                        [
                            'j',
                            'k',
                            'arrowdown',
                            'arrowup',
                            'pagedown',
                            'pageup',
                            'home',
                            'end'
                        ].includes(key)
                    ) {
                        event.preventDefault();
                        if (key === 'home') {
                            content.scrollTop = 0;
                        } else if (key === 'end') {
                            content.scrollTop = content.scrollHeight;
                        } else {
                            content.scrollTop +=
                                (['j', 'arrowdown', 'pagedown'].includes(key) ? 1 : -1) *
                                (key.startsWith('page') ? content.clientHeight * 0.8 : 32);
                        }
                    }
                }
            }}
        >
            <header className={styles.header}>
                <CircleAlert size={16} />
                <strong>{t('Diagnostics')}</strong>
                <span className={styles.count}>
                    {t('{count} on this line', { count: info.items.length })}
                </span>
                <div className={styles.actions}>
                    <button
                        aria-label={t('Previous diagnostic')}
                        title={`${t('Previous diagnostic')} ([d)`}
                        onClick={() => jump('[d')}
                    >
                        <ChevronUp size={16} />
                    </button>
                    <button
                        aria-label={t('Next diagnostic')}
                        title={`${t('Next diagnostic')} (]d)`}
                        onClick={() => jump(']d')}
                    >
                        <ChevronDown size={16} />
                    </button>
                    <button
                        aria-label={t('Close diagnostics')}
                        title={t('Close (Esc / Ctrl+C)')}
                        onClick={close}
                    >
                        <X size={16} />
                    </button>
                </div>
            </header>
            <div className={styles.location} title={first.path}>
                <span>{filename}</span>
                <span>
                    {t('Ln {line}, Col {column}', { line: first.line, column: first.column })}
                </span>
            </div>
            <div
                ref={body}
                className={styles.body}
                tabIndex={0}
                aria-label={t('Diagnostic content')}
            >
                {info.items.map((item, index) => {
                    const severity = severities[item.severity - 1] || severities[0];
                    const Icon = severity.icon;
                    const [headline, ...details] = item.message.split('\n');
                    return (
                        <article key={index} className={styles.item} data-severity={severity.name}>
                            <div className={styles.metadata}>
                                <span className={styles.severity}>
                                    <Icon size={14} />
                                    {t(severity.label)}
                                </span>
                                {item.source && <span>{item.source}</span>}
                                {item.code && <code style={{ fontFamily }}>{item.code}</code>}
                                <span className={styles.column}>
                                    {t('Col {column}', { column: item.column })}
                                </span>
                            </div>
                            <h3>
                                <Message text={headline} fontFamily={fontFamily} />
                            </h3>
                            {details.length > 0 && (
                                <p>
                                    <Message text={details.join('\n')} fontFamily={fontFamily} />
                                </p>
                            )}
                        </article>
                    );
                })}
            </div>
            <footer className={styles.footer}>
                <span>{t('[d / ]d · Previous / Next')}</span>
                <span>{t('gl · Read · j / k · Scroll')}</span>
                <span>{t('Esc / Ctrl C · Back to editor')}</span>
            </footer>
        </div>
    );
}
