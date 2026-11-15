// While Neovim's command line is shown, the editor's hidden input element serves it: it moves
// to the command cursor so IME composition appears there, and it carries the command-line
// completion for assistive technology.
import { useLayoutEffect, type RefObject } from 'react';
import type { NeovimCommandLine, NeovimUIState } from '../../../shared/neovimUI';

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
	anchor.style.maxWidth = `${Math.max(2, host.right - point.left)}px`;
}

/** Move the input to the command cursor while the command line is shown; repaint after. */
export function useCommandInputAnchor({
	id,
	commands,
	showCommand,
	current,
	inputRef,
	caretRef,
	cardRef,
	bodyRef,
	paintRef
}: {
	id: string;
	commands: NeovimUIState['commands'];
	showCommand: boolean;
	current: NeovimCommandLine | undefined;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	caretRef: RefObject<HTMLSpanElement | null>;
	cardRef: RefObject<HTMLDivElement | null>;
	bodyRef: RefObject<HTMLDivElement | null>;
	paintRef: RefObject<() => void>;
}): void {
	useLayoutEffect(() => {
		const anchor = inputRef.current;
		const cursor = caretRef.current;
		const card = cardRef.current;
		const body = bodyRef.current;
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
		const repaint = paintRef.current;
		return () => {
			observer.disconnect();
			body.removeEventListener('scroll', position);
			anchor.removeAttribute('data-nvim-command-active');
			anchor.removeAttribute('aria-describedby');
			repaint();
		};
	}, [commands, showCommand, current, inputRef, caretRef, cardRef, bodyRef, id, paintRef]);
}

/** Expose the command-line completion to assistive technology through the input element. */
export function useCompletionAria({
	id,
	completion,
	current,
	hidden,
	inputRef,
	cardRef
}: {
	id: string;
	completion: NeovimUIState['completion'];
	current: NeovimCommandLine | undefined;
	hidden: boolean;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	cardRef: RefObject<HTMLDivElement | null>;
}): void {
	useLayoutEffect(() => {
		const anchor = inputRef.current;
		if (!anchor || !completion || !current || hidden) {
			return;
		}
		anchor.setAttribute('aria-autocomplete', 'list');
		anchor.setAttribute('aria-controls', `neovim-completion-${id}`);
		if (completion.selected >= 0) {
			anchor.setAttribute(
				'aria-activedescendant',
				`neovim-completion-${id}-${completion.selected}`
			);
		}
		cardRef.current
			?.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: 'nearest' });
		return () => {
			anchor.removeAttribute('aria-autocomplete');
			anchor.removeAttribute('aria-controls');
			anchor.removeAttribute('aria-activedescendant');
		};
	}, [completion, current, inputRef, cardRef, hidden, id]);
}
