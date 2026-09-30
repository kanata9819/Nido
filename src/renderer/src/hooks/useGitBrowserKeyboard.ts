import { useEffect } from 'react';

export function useGitBrowserKeyboard({
    busy,
    back,
    changeView
}: {
    busy: boolean;
    back: () => void;
    changeView: (next: number) => void;
}): void {
    useEffect(() => {
        const keydown = (event: KeyboardEvent): void => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                if (!busy) {
                    back();
                }
                return;
            }
            if (!(event.target as HTMLElement).closest('[aria-label="git palette"]')) {
                return;
            }
            const editing = (event.target as HTMLElement).matches(
                'input, textarea, [contenteditable="true"]'
            );
            if (editing || event.altKey || event.metaKey) {
                return;
            }
            const target = event.target as HTMLElement;
            const dialog = target.closest('[aria-label="git palette"]');
            const key = event.key.toLowerCase();
            if (event.ctrlKey && !event.shiftKey && (key === 'h' || key === 'l')) {
                event.preventDefault();
                const selector =
                    key === 'h'
                        ? '[role="listbox"]'
                        : '[data-git-scroll="after"], [data-git-preview] > [tabindex]';
                dialog?.querySelector<HTMLElement>(selector)?.focus();
                return;
            }
            const preview = target.closest<HTMLElement>(
                '[data-git-preview] pre, [data-git-summary]'
            );
            if (preview) {
                const line = parseFloat(getComputedStyle(preview).lineHeight) || 20;
                let vertical = 0;
                let horizontal = 0;
                if (event.ctrlKey && !event.shiftKey) {
                    if (key === 'd' || key === 'u') {
                        vertical = (preview.clientHeight / 2) * (key === 'd' ? 1 : -1);
                    } else if (key === 'f' || key === 'b') {
                        vertical = preview.clientHeight * (key === 'f' ? 1 : -1);
                    }
                } else if (!event.ctrlKey) {
                    if (event.key === 'j' || event.key === 'k') {
                        vertical = line * (event.key === 'j' ? 1 : -1);
                    } else if (event.key === 'h' || event.key === 'l') {
                        horizontal = line * (event.key === 'l' ? 1 : -1);
                    } else if (key === 'g') {
                        event.preventDefault();
                        preview.scrollTo({
                            top: event.shiftKey || event.key === 'G' ? preview.scrollHeight : 0,
                            behavior: 'instant'
                        });
                        return;
                    }
                }
                if (vertical || horizontal) {
                    event.preventDefault();
                    preview.scrollBy({ top: vertical, left: horizontal, behavior: 'instant' });
                    return;
                }
            }
            if (
                !editing &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                ['1', '2', '3'].includes(event.key)
            ) {
                event.preventDefault();
                changeView(Number(event.key) - 1);
            }
        };
        document.addEventListener('keydown', keydown);
        return () => document.removeEventListener('keydown', keydown);
    });
}
