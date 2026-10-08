import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import prose from '../assets/TypeInformation.module.css';
import styles from '../assets/MarkdownPreview.module.css';

export default function MarkdownPreview({
    workspaceId
}: {
    workspaceId: string;
}): React.JSX.Element {
    const t = useI18n();
    const [source, setSource] = useState<string>();
    const [error, setError] = useState('');
    const body = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let cancelled = false;
        body.current?.focus();
        window.nido
            .markdownPreview(workspaceId)
            .then((value) => {
                if (!cancelled) {
                    setSource(value);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    setError(String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workspaceId]);
    return (
        <div
            ref={body}
            className={styles.markdownPreview}
            tabIndex={0}
            aria-label={t('Markdown preview content')}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
                    return;
                }
                const key = event.key.toLowerCase();
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
    );
}
