import { onNidoEvent } from '../nidoEvents';
import { useErrorMessage, useI18n } from '../i18n';
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import prose from '../ui/Prose.module.css';
import styles from './MarkdownPreview.module.css';
import { headingSlug, resolveMarkdownLink } from './markdownLinks';

/** The text of rendered Markdown, for a heading's id. */
function textOf(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) =>
			typeof child === 'string' || typeof child === 'number'
				? String(child)
				: isValidElement<{ children?: ReactNode }>(child)
					? textOf(child.props.children)
					: ''
		)
		.join('');
}

export default memo(MarkdownPreview);

/**
 * The rendered preview of the current Markdown file. It reloads 150 ms after edits; the token
 * from the last read lets the main process skip sending unchanged text.
 */
function MarkdownPreview({
	workspaceId,
	root,
	onClose,
	focusEditor
}: {
	workspaceId: string;
	/** The workspace's folder, which links to other files are resolved in. */
	root: string;
	onClose: () => void;
	focusEditor: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [source, setSource] = useState<string>();
	const [error, setError] = useState('');
	// The document's path, for relative links, and why the last link could not be followed.
	const [path, setPath] = useState('');
	const [linkError, setLinkError] = useState('');
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let cancelled = false;
		// Grows with every change, so a read that started before the change is ignored.
		let generation = 0;
		let token = '';
		let timer: number | undefined;
		let pending = false;
		// Whether the buffer may have changed since the last read.
		let dirty = true;
		body.current?.focus();
		// Read the buffer, at most one read at a time, while the window is visible.
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
						setPath(value.path);
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
		// After an edit, read again once the edits pause.
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
	// Heading ids, numbered from the top for each render as GitHub does for repeated headings.
	const headingIds = new Map<string, number>();
	const headingId = (children: ReactNode): string => {
		const slug = headingSlug(textOf(children));
		const seen = headingIds.get(slug) ?? 0;
		headingIds.set(slug, seen + 1);
		return seen ? `${slug}-${seen}` : slug;
	};
	/** Follow a link: a web page in the browser, a heading here, a workspace file in the editor. */
	const follow = (href: string): void => {
		const link = resolveMarkdownLink(href, path, root);
		setLinkError('');
		const fail = (reason: unknown): void => setLinkError(String(reason));
		if (link.kind === 'web') {
			void window.nido.openDocumentation(link.url).catch(fail);
		} else if (link.kind === 'heading') {
			const target = [...(body.current?.querySelectorAll('[id]') ?? [])].find(
				(element) => element.id.toLowerCase() === link.id
			);
			target?.scrollIntoView({ block: 'start' });
		} else if (link.kind === 'file') {
			void window.nido.openFile(workspaceId, link.path, link.line).then(focusEditor, fail);
		}
	};
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
					{linkError && (
						<p role="alert" className={styles.linkError}>
							{errorMessage(linkError)}
						</p>
					)}
					{error ? (
						<p role="alert">{errorMessage(error)}</p>
					) : source === undefined ? (
						<p>{t('Loading…')}</p>
					) : (
						<Markdown
							remarkPlugins={[remarkGfm]}
							skipHtml
							components={{
								img: ({ alt }) => <span>{alt}</span>,
								h1: ({ children }) => <h1 id={headingId(children)}>{children}</h1>,
								h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
								h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
								h4: ({ children }) => <h4 id={headingId(children)}>{children}</h4>,
								h5: ({ children }) => <h5 id={headingId(children)}>{children}</h5>,
								h6: ({ children }) => <h6 id={headingId(children)}>{children}</h6>,
								a: ({ href, children }) =>
									href &&
									resolveMarkdownLink(href, path, root).kind !== 'none' ? (
										<a
											href={href}
											onClick={(event) => {
												event.preventDefault();
												follow(href);
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
