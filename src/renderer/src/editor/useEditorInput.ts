import type { RefObject } from 'react';
import type { StickyScrollCoverage } from '../../../shared/nidoApi';
import { isAltGraph, vimKey } from '../keyboard/keyboard';
import { afterEditorClick } from './editorClick';

/**
 * Typed text as Neovim input. nvim_input reads key notation such as <CR>, so a literal < is
 * sent as <LT>.
 */
function typedText(text: string): string {
	return text.replaceAll('<', '<LT>');
}

interface UseEditorInputOptions {
	id: string;
	blocked: boolean;
	composingRef: RefObject<boolean>;
	paintRef: RefObject<() => void>;
	stickyCoverage: RefObject<StickyScrollCoverage | undefined>;
	onError: (message: string) => void;
}

/**
 * Event handlers for the editor's hidden textarea, which receives all keyboard and IME input.
 * Keys become Vim key notation; typed and composed text is sent as text; pastes use Neovim's
 * paste. While `blocked` (a dialog is open) nothing is sent.
 */
export function useEditorInput({
	id,
	blocked,
	composingRef,
	paintRef,
	stickyCoverage,
	onError
}: UseEditorInputOptions): {
	onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
	onBlur: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
	onCompositionStart: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
	onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
	onInput: (event: React.FormEvent<HTMLTextAreaElement>) => void;
	onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
} {
	const send = (action: () => Promise<unknown>): void => {
		void afterEditorClick(id, action).catch((e) => onError(String(e)));
	};
	const sendKeys = (keys: string): void => {
		send(() => window.nido.input(id, keys, stickyCoverage.current));
	};
	const resetInput = (event: React.FocusEvent<HTMLTextAreaElement>): void => {
		composingRef.current = false;
		event.currentTarget.value = '';
		event.currentTarget.removeAttribute('data-composing');
		paintRef.current();
	};

	return {
		// Gaining or losing focus ends any composition; repaint to show or hide the cursor.
		onFocus: resetInput,
		onBlur: resetInput,
		onCompositionStart(event: React.CompositionEvent<HTMLTextAreaElement>): void {
			composingRef.current = !blocked;
			event.currentTarget.toggleAttribute('data-composing', !blocked);
		},
		// IME composition: the text is sent once it is committed.
		onCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>): void {
			const committed = composingRef.current && !blocked;
			composingRef.current = false;
			if (committed && event.data) {
				sendKeys(typedText(event.data));
			}
			event.currentTarget.value = '';
			event.currentTarget.removeAttribute('data-composing');
		},
		// Printable characters arrive here rather than through keydown.
		onInput(event: React.FormEvent<HTMLTextAreaElement>): void {
			if (blocked) {
				event.currentTarget.value = '';
				return;
			}
			if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) {
				return;
			}
			const value = event.currentTarget.value;
			if (value) {
				sendKeys(typedText(value));
			}
			event.currentTarget.value = '';
		},
		onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
			event.preventDefault();
			if (blocked) {
				return;
			}
			const text = event.clipboardData.getData('text/plain');
			send(() => window.nido.paste(id, text));
		},
		onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
			if (
				blocked ||
				composingRef.current ||
				event.nativeEvent.isComposing ||
				event.nativeEvent.keyCode === 229
			) {
				return;
			}

			// Ctrl+Shift+V pastes the system clipboard.
			if (
				event.ctrlKey &&
				event.shiftKey &&
				!isAltGraph(event.nativeEvent) &&
				event.key.toLowerCase() === 'v'
			) {
				event.preventDefault();
				send(() => window.nido.pasteClipboard(id));
				return;
			}

			const key = vimKey(event.nativeEvent);
			if (key) {
				event.preventDefault();
				sendKeys(key);
			}
		}
	};
}
