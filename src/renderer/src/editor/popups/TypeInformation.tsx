import { onNidoEvent } from '../../nidoEvents';
import { useErrorMessage, useI18n } from '../../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Braces, X } from 'lucide-react';
import styles from '../../assets/TypeInformation.module.css';
import type { NidoEvent } from '../../../../shared/types';
import OverlayPresence from '../../ui/OverlayPresence';
import { placeNearCursor } from '../../ui/popupPosition';
import { vimKey } from '../../keyboard/keyboard';
import { cycleFocus, scrollLines, scrollPage } from '../../ui/popupKeys';
import HoverMarkdown from './hover/HoverMarkdown';

/** The keys that scroll the card by lines; letters only in lower case. */
const lineKeys = ['j', 'k', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];

/** The first code block or table in view that is wider than the card, to scroll sideways. */
function wideBlockInView(body: HTMLElement): HTMLElement | undefined {
	const bounds = body.getBoundingClientRect();
	return [...body.querySelectorAll<HTMLElement>('pre, table')].find((node) => {
		const rect = node.getBoundingClientRect();
		return (
			node.scrollWidth > node.clientWidth &&
			rect.bottom > bounds.top &&
			rect.top < bounds.bottom
		);
	});
}

/**
 * The card's keys: Esc or Ctrl+C/K close, Ctrl+D/U/F/B scroll, h/l scroll wide code
 * sideways, Tab cycles focus, and j/k and the page keys scroll. Any other key closes the card
 * and goes on to the editor, like moving away from a hover.
 */
function hoverKeyDown(
	event: React.KeyboardEvent,
	{
		body,
		card,
		close,
		send
	}: { body: HTMLElement; card: HTMLElement; close: () => void; send: (keys: string) => void }
): void {
	event.stopPropagation();
	const key = event.key.toLowerCase();
	const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
	if (event.key === 'Escape' || (ctrl && ['c', 'k'].includes(key))) {
		event.preventDefault();
		close();
	} else if (ctrl && ['d', 'u', 'f', 'b'].includes(key)) {
		event.preventDefault();
		scrollPage(body, key);
	} else if (
		!event.ctrlKey &&
		!event.altKey &&
		!event.metaKey &&
		!event.nativeEvent.isComposing &&
		['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(event.key)
	) {
		event.preventDefault();
		const block = wideBlockInView(body);
		if (block) {
			block.scrollLeft += ['l', 'ArrowRight'].includes(event.key) ? 48 : -48;
		}
	} else if (event.key === 'Tab') {
		event.preventDefault();
		cycleFocus(
			[body, ...card.querySelectorAll<HTMLElement>('button, a[href]')],
			event.shiftKey
		);
	} else if (!event.ctrlKey && !event.altKey && lineKeys.includes(event.key)) {
		event.preventDefault();
		scrollLines(body, key);
	} else if (
		!event.defaultPrevented &&
		!event.nativeEvent.isComposing &&
		event.nativeEvent.keyCode !== 229 &&
		// Enter and Space still activate a focused link or the close button.
		!(
			['Enter', ' '].includes(event.key) &&
			(event.target as HTMLElement).closest('a[href], button')
		)
	) {
		const keys = vimKey(event.nativeEvent);
		if (keys) {
			event.preventDefault();
			close();
			send(keys);
		}
	}
}

/**
 * The hover card (K in the editor): the language server's Markdown documentation for the
 * symbol under the cursor, with code blocks highlighted like the editor. It takes focus, so
 * it can be scrolled with the keyboard; Esc returns to the editor.
 */
export default function TypeInformation({
	id,
	input,
	fontFamily,
	hidden = false
}: {
	id: string;
	input: RefObject<HTMLTextAreaElement | null>;
	fontFamily: string;
	hidden?: boolean;
}): React.JSX.Element | null {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [info, setInfo] = useState<Extract<NidoEvent, { type: 'hover' }>>();
	const [linkError, setLinkError] = useState('');
	// Grows when the card closes or changes, so a slow link opened from an older card is ignored.
	const linkRequest = useRef({ generation: 0 });
	// Hiding the editor (for example behind a dialog) closes the card.
	const [previousHidden, setPreviousHidden] = useState(hidden);
	if (hidden !== previousHidden) {
		setPreviousHidden(hidden);
		if (hidden) {
			setInfo(undefined);
		}
	}
	const card = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const close = (): void => {
		linkRequest.current.generation++;
		setInfo(undefined);
		input.current?.focus();
	};

	// Show hover results for this workspace. A diagnostics popup replaces the card.
	useEffect(() => {
		if (hidden) {
			return;
		}
		const requests = linkRequest.current;
		const unsubscribe = onNidoEvent((event) => {
			if (event.type === 'diagnostics' && event.id === id && event.items.length) {
				requests.generation++;
				if (!event.focus && card.current?.contains(document.activeElement)) {
					input.current?.focus();
				}
				setInfo(undefined);
				return;
			}
			if (event.type !== 'hover' || event.id !== id) {
				return;
			}
			requests.generation++;
			setLinkError('');
			if (!event.markdown && card.current?.contains(document.activeElement)) {
				input.current?.focus();
			}
			setInfo(event.markdown ? event : undefined);
		});
		return () => {
			requests.generation++;
			unsubscribe();
		};
	}, [id, input, hidden]);

	// Position the card, focus it, and close it on a click outside.
	useLayoutEffect(() => {
		const element = card.current;
		const anchor = input.current;
		if (hidden || !info || !element || !anchor) {
			return;
		}
		const host = element.parentElement!;
		const position = (): void => placeNearCursor(element, anchor, host);
		position();
		body.current?.focus();
		const observer = new ResizeObserver(position);
		observer.observe(host);
		observer.observe(element);
		const outside = (event: PointerEvent): void => {
			if (!element.contains(event.target as Node)) {
				linkRequest.current.generation++;
				setInfo(undefined);
			}
		};
		document.addEventListener('pointerdown', outside, true);
		return () => {
			observer.disconnect();
			document.removeEventListener('pointerdown', outside, true);
		};
	}, [info, input, hidden]);

	if (!info || hidden) {
		return <OverlayPresence>{null}</OverlayPresence>;
	}
	/** Open a documentation link; a failure shows only while the card stays as it is. */
	const openLink = (href: string): void => {
		const request = ++linkRequest.current.generation;
		void window.nido.openDocumentation(href).catch((error) => {
			if (request === linkRequest.current.generation) {
				setLinkError(String(error));
			}
		});
	};
	return (
		<OverlayPresence>
			<div
				ref={card}
				className={styles.card}
				// Code blocks and inline code follow the editor font setting.
				style={{ '--editor-font': fontFamily } as React.CSSProperties}
				role="dialog"
				aria-label={t('Type information')}
				data-type-information
				onClick={(event) => event.stopPropagation()}
				onWheel={(event) => event.stopPropagation()}
				onKeyDown={(event) =>
					hoverKeyDown(event, {
						body: body.current!,
						card: card.current!,
						close,
						send: (keys) => void window.nido.input(id, keys).catch(() => {})
					})
				}
			>
				<header>
					<Braces size={15} />
					<strong>{t('Type information')}</strong>
					<span>{info.filetype}</span>
					<button
						aria-label={t('Close type information')}
						title={t('Close (Esc / Ctrl+C)')}
						onClick={close}
					>
						<X size={14} />
					</button>
				</header>
				<div
					ref={body}
					className={styles.body}
					tabIndex={0}
					aria-label={t('Type information content')}
				>
					<div className={styles.prose}>
						<HoverMarkdown
							markdown={info.markdown}
							codeBlocks={info.codeBlocks}
							openLink={openLink}
						/>
					</div>
					{linkError && <p role="alert">{errorMessage(linkError)}</p>}
				</div>
				<footer>
					<span
						title={t(
							'h/l / ← →: horizontal · j/k / ↑ ↓: line · Ctrl+D/U: half page · Ctrl+F/B: page · Other keys: close and continue in the editor'
						)}
					>
						{t('h j k l · Scroll · Other keys · Close')}
					</span>
					<span>{t('Esc / Ctrl C · Back to editor')}</span>
				</footer>
			</div>
		</OverlayPresence>
	);
}
