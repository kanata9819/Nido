import type { GitView } from '../types';
import { useLayoutEffect } from 'react';

// Keyboard shortcuts of the Git browser that work wherever focus is inside it.
const panelSelector = '[data-panel="git"]';
/** 1, 2 and 3 switch between the Git browser's views. */
const views = new Map<string, GitView>([
	['1', 'changes'],
	['2', 'history'],
	['3', 'branches']
]);

/** Ctrl+H focuses the list and Ctrl+L the preview. Returns whether the key was handled. */
function focusPane(event: KeyboardEvent, dialog: Element | null): boolean {
	const key = event.key.toLowerCase();
	if (!event.ctrlKey || event.shiftKey || (key !== 'h' && key !== 'l')) {
		return false;
	}
	event.preventDefault();
	const selector =
		key === 'h'
			? '[role="listbox"]'
			: '[data-git-scroll="after"], [data-git-preview] > [tabindex]';
	dialog?.querySelector<HTMLElement>(selector)?.focus();
	return true;
}

/** The scroll distance for a Vim-style key in a preview, or undefined for other keys. */
function previewScroll(
	event: KeyboardEvent,
	preview: HTMLElement
): { vertical: number; horizontal: number } | undefined {
	const key = event.key.toLowerCase();
	const line = parseFloat(getComputedStyle(preview).lineHeight) || 20;
	if (event.ctrlKey && !event.shiftKey) {
		if (key === 'd' || key === 'u') {
			return {
				vertical: Math.round(preview.clientHeight / 2) * (key === 'd' ? 1 : -1),
				horizontal: 0
			};
		}
		if (key === 'f' || key === 'b') {
			return { vertical: preview.clientHeight * (key === 'f' ? 1 : -1), horizontal: 0 };
		}
	} else if (!event.ctrlKey) {
		if (event.key === 'j' || event.key === 'k') {
			return { vertical: line * (event.key === 'j' ? 1 : -1), horizontal: 0 };
		}
		if (event.key === 'h' || event.key === 'l') {
			return { vertical: 0, horizontal: line * (event.key === 'l' ? 1 : -1) };
		}
	}
	return undefined;
}

/**
 * j/k/h/l, Ctrl+D/U/F/B and g/G scroll a diff preview or commit summary.
 * Returns whether the key was handled.
 */
function scrollPreview(event: KeyboardEvent, preview: HTMLElement): boolean {
	if (!event.ctrlKey && event.key.toLowerCase() === 'g') {
		event.preventDefault();
		preview.scrollTo({
			top: event.shiftKey || event.key === 'G' ? preview.scrollHeight : 0,
			behavior: 'instant'
		});
		return true;
	}
	const scroll = previewScroll(event, preview);
	if (!scroll || (!scroll.vertical && !scroll.horizontal)) {
		return false;
	}
	event.preventDefault();
	// Absolute pixel targets avoid accumulating Windows display-scale rounding.
	preview.scrollTo({
		top: Math.round(preview.scrollTop + scroll.vertical),
		left: Math.round(preview.scrollLeft + scroll.horizontal),
		behavior: 'instant'
	});
	return true;
}

/**
 * The Git browser's shortcuts: 1/2/3 switch views, Esc goes back, Ctrl+H/L move between list
 * and preview, and Vim keys scroll the preview.
 */
export function useGitBrowserKeyboard({
	busy,
	back,
	changeView
}: {
	busy: boolean;
	back: () => void;
	changeView: (next: GitView) => void;
}): void {
	// Keep keyboard handlers in sync with the enabled controls before browser events resume.
	useLayoutEffect(() => {
		const keydown = (event: KeyboardEvent): void => {
			if (event.isComposing || event.keyCode === 229) {
				return;
			}
			// Exit animation keeps the DOM mounted after keyboard control has returned.
			if (document.querySelector(panelSelector)?.closest('[inert]')) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				if (!busy) {
					back();
				}
				return;
			}
			const target = event.target as HTMLElement;
			const dialog = target.closest(panelSelector);
			if (!dialog) {
				return;
			}
			const editing = target.matches('input, textarea, [contenteditable="true"]');
			if (editing || event.altKey || event.metaKey || focusPane(event, dialog)) {
				return;
			}
			const preview = target.closest<HTMLElement>(
				'[data-git-preview] pre, [data-git-summary]'
			);
			if (preview && scrollPreview(event, preview)) {
				return;
			}
			// 1, 2 and 3 switch between Changes, History and Branches.
			const view = views.get(event.key);
			if (view && !event.ctrlKey) {
				event.preventDefault();
				changeView(view);
			}
		};
		document.addEventListener('keydown', keydown);
		return () => document.removeEventListener('keydown', keydown);
	});
}
