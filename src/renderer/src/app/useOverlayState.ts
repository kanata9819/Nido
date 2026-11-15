import { useCallback, useState } from 'react';

/**
 * The editor's overlays that are not palettes: the Space leader menu and the Markdown preview,
 * plus `focusTick`, which grows to ask the selected editor to take focus.
 */
export function useOverlayState(): {
	leader: boolean;
	setLeader: (open: boolean) => void;
	dismissLeader: () => void;
	markdownVisible: boolean;
	setMarkdownVisible: (visible: boolean) => void;
	toggleMarkdown: () => void;
	focusTick: number;
	requestEditorFocus: () => void;
} {
	const [markdownVisible, setMarkdownVisible] = useState(false);
	const [leader, setLeader] = useState(false);
	const [focusTick, setFocusTick] = useState(0);
	const requestEditorFocus = useCallback(() => setFocusTick((n) => n + 1), []);
	const dismissLeader = useCallback(() => setLeader(false), []);
	const toggleMarkdown = useCallback((): void => {
		setMarkdownVisible((visible) => !visible);
		requestEditorFocus();
	}, [requestEditorFocus]);
	return {
		leader,
		setLeader,
		dismissLeader,
		markdownVisible,
		setMarkdownVisible,
		toggleMarkdown,
		focusTick,
		requestEditorFocus
	};
}
