import type { RefObject } from 'react';
import { isAltGraph, vimKey } from '../keyboard';

interface UseEditorInputOptions {
    id: string;
    blocked: boolean;
    composingRef: RefObject<boolean>;
    paintRef: RefObject<() => void>;
    onError: (message: string) => void;
}

export function useEditorInput({
    id,
    blocked,
    composingRef,
    paintRef,
    onError
}: UseEditorInputOptions): {
    onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
    onBlur: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
    onInput: (event: React.FormEvent<HTMLTextAreaElement>) => void;
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
} {
    const send = (promise: Promise<unknown>): void => {
        void promise.catch((e) => onError(String(e)));
    };

    return {
        onFocus(event: React.FocusEvent<HTMLTextAreaElement>): void {
            composingRef.current = false;
            event.currentTarget.value = '';
            paintRef.current();
        },
        onBlur(event: React.FocusEvent<HTMLTextAreaElement>): void {
            composingRef.current = false;
            event.currentTarget.value = '';
            paintRef.current();
        },
        onCompositionStart(): void {
            composingRef.current = !blocked;
        },
        onCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>): void {
            const committed = composingRef.current && !blocked;
            composingRef.current = false;
            if (committed && event.data) {
                send(window.nido.input(id, event.data.replaceAll('<', '<LT>')));
            }
            event.currentTarget.value = '';
        },
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
                send(window.nido.input(id, value.replaceAll('<', '<LT>')));
            }
            event.currentTarget.value = '';
        },
        onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
            event.preventDefault();
            if (blocked) {
                return;
            }
            send(window.nido.paste(id, event.clipboardData.getData('text/plain')));
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

            if (
                event.ctrlKey &&
                event.shiftKey &&
                !isAltGraph(event.nativeEvent) &&
                event.key.toLowerCase() === 'v'
            ) {
                event.preventDefault();
                send(window.nido.pasteClipboard(id));
                return;
            }

            const key = vimKey(event.nativeEvent);
            if (key) {
                event.preventDefault();
                send(window.nido.input(id, key));
            }
        }
    };
}
