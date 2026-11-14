import { onNidoEvent } from '../nidoEvents';
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
import OverlayPresence from './OverlayPresence';
import { placeNearCursor } from '../popupPosition';
import { vimKey } from '../keyboard';

/** LSP diagnostic severities 1 to 4, with their label and icon. */
const severities = [
	{ label: 'Error', name: 'error', icon: CircleAlert },
	{ label: 'Warning', name: 'warning', icon: TriangleAlert },
	{ label: 'Information', name: 'info', icon: Info },
	{ label: 'Hint', name: 'hint', icon: Lightbulb }
];

/** A diagnostic message, with `code` spans in the editor font. */
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

/**
 * The diagnostic card: the errors and warnings at the cursor, shown after a jump with [d/]d or
 * on request. While it has focus, [d and ]d (with a count) jump on to the next diagnostic.
 */
export default function DiagnosticInformation({
	id,
	input,
	fontFamily,
	onError,
	hidden = false
}: {
	id: string;
	input: RefObject<HTMLTextAreaElement | null>;
	fontFamily: string;
	onError: (message: string) => void;
	hidden?: boolean;
}): React.JSX.Element | null {
	const t = useI18n();
	const [info, setInfo] = useState<Extract<NidoEvent, { type: 'diagnostics' }>>();
	const [previousHidden, setPreviousHidden] = useState(hidden);
	if (hidden !== previousHidden) {
		setPreviousHidden(hidden);
		if (hidden) {
			setInfo(undefined);
		}
	}
	const card = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	// Keys typed so far of a pending jump, such as "2]" before the final d.
	const keys = useRef('');
	const close = (): void => {
		keys.current = '';
		setInfo(undefined);
		input.current?.focus();
	};
	/** Send a jump to Neovim; the next diagnostics event replaces the card. */
	const jump = (sequence: string): void => {
		keys.current = '';
		void window.nido.input(id, sequence).catch((error) => onError(String(error)));
	};

	useEffect(() => {
		if (hidden) {
			keys.current = '';
		}
	}, [hidden]);

	// Show diagnostics events for this workspace; a hover card replaces this card.
	useEffect(() => {
		if (hidden) {
			return;
		}
		return onNidoEvent((event) => {
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
		});
	}, [id, input, hidden]);

	// Position the card at the cursor and close it on a click outside.
	useLayoutEffect(() => {
		const element = card.current;
		const anchor = input.current;
		if (hidden || !info || !element || !anchor) {
			return;
		}
		const host = element.parentElement!;
		const position = (): void => placeNearCursor(element, anchor, host);
		position();
		body.current!.scrollTop = 0;
		// Jumps with [d / ]d come from the editor, so the card can take its keys too;
		// focus elsewhere, such as in a panel, is left alone.
		if (info.focus || document.activeElement === anchor) {
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
	}, [info, input, hidden]);

	if (!info || hidden) {
		return <OverlayPresence>{null}</OverlayPresence>;
	}
	const first = info.items[0];
	const filename = first.path.replaceAll('\\', '/').split('/').pop() || t('Untitled');
	return (
		<OverlayPresence>
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
						const pending = keys.current;
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
						} else if (plain && ['h', 'l', 'arrowleft', 'arrowright'].includes(key)) {
							// Long messages wrap; a wide code span can still scroll sideways.
							event.preventDefault();
							content.scrollLeft += ['l', 'arrowright'].includes(key) ? 48 : -48;
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
						} else if (
							!event.defaultPrevented &&
							event.nativeEvent.keyCode !== 229 &&
							// Ctrl+C with a selection copies the selected message text.
							!(ctrl && key === 'c') &&
							// Enter and Space still press a focused button.
							!(
								['Enter', ' '].includes(event.key) &&
								(event.target as HTMLElement).closest('button')
							)
						) {
							// Any other key goes back to the editor, with a pending count or bracket.
							const typed = vimKey(event.nativeEvent);
							if (typed) {
								event.preventDefault();
								close();
								jump(pending + typed);
							}
						}
					}
				}}
			>
				<header className={styles.header}>
					<CircleAlert size={15} />
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
							<ChevronUp size={14} />
						</button>
						<button
							aria-label={t('Next diagnostic')}
							title={`${t('Next diagnostic')} (]d)`}
							onClick={() => jump(']d')}
						>
							<ChevronDown size={14} />
						</button>
						<button
							aria-label={t('Close diagnostics')}
							title={t('Close (Esc / Ctrl+C)')}
							onClick={close}
						>
							<X size={14} />
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
							<article
								key={index}
								className={styles.item}
								data-severity={severity.name}
							>
								<div className={styles.metadata}>
									<span className={styles.severity}>
										<Icon size={13} />
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
										<Message
											text={details.join('\n')}
											fontFamily={fontFamily}
										/>
									</p>
								)}
							</article>
						);
					})}
				</div>
				<footer className={styles.footer}>
					<span>{t('[d / ]d · Previous / Next')}</span>
					<span>{t('h j k l · Scroll')}</span>
					<span>{t('Other keys · Back to editor')}</span>
				</footer>
			</div>
		</OverlayPresence>
	);
}
