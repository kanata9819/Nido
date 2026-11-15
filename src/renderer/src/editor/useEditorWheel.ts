import { useEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../grid/grid';
import { accumulateScroll, editorWheelMotion } from './scroll';

/**
 * Turn wheel events into scrolling. Editors scroll smoothly by pixels and sideways by columns;
 * terminals scroll by whole lines. Movement smaller than a line or column carries over to the
 * next nearby wheel event, and is dropped when the editor or its font changes.
 */
export function useEditorWheel({
	id,
	terminal,
	lineHeight,
	scrollFollowCursor,
	gridRef,
	scrollRef,
	send,
	reset
}: {
	id: string;
	terminal: boolean;
	lineHeight: number;
	scrollFollowCursor: boolean;
	gridRef: RefObject<Grid>;
	scrollRef: RefObject<
		(lines: number, follow: boolean, discrete: boolean, columns?: number) => void
	>;
	send: (promise: Promise<unknown>) => void;
	/** Values whose change drops the carried-over movement. */
	reset: unknown[];
}): (event: React.WheelEvent<HTMLDivElement>) => void {
	const wheel = useRef({ remainder: 0, time: 0 });
	const horizontalWheel = useRef({ remainder: 0, time: 0 });
	useEffect(() => {
		wheel.current = { remainder: 0, time: 0 };
		horizontalWheel.current = { remainder: 0, time: 0 };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, reset);

	const scrollEditor = (event: React.WheelEvent<HTMLDivElement>): void => {
		const { horizontalWheel: nextWheel, motion } = editorWheelMotion(
			event,
			{ surface: event.currentTarget, lineHeight, cellWidth: gridRef.current.cellWidth },
			horizontalWheel.current,
			performance.now()
		);
		horizontalWheel.current = nextWheel;
		if (motion) {
			scrollRef.current(motion.lines, scrollFollowCursor, motion.discrete, motion.columns);
		}
	};

	const scrollTerminal = (event: React.WheelEvent<HTMLDivElement>): void => {
		const now = performance.now();
		const result = accumulateScroll(
			now - wheel.current.time > 200 ? 0 : wheel.current.remainder,
			event.deltaY * 0.5,
			event.deltaMode,
			lineHeight,
			event.currentTarget.clientHeight
		);
		wheel.current = { remainder: result.remainder, time: now };
		if (result.lines) {
			send(window.nido.scroll(id, Math.max(-1000, Math.min(1000, result.lines)), true));
		}
	};

	return terminal ? scrollTerminal : scrollEditor;
}

/** End an IME composition that the window losing focus or becoming hidden interrupted. */
export function useCompositionReset(
	inputRef: RefObject<HTMLTextAreaElement | null>,
	composingRef: RefObject<boolean>,
	listening: boolean
): void {
	useEffect(() => {
		const resetComposition = (): void => {
			composingRef.current = false;
			if (inputRef.current) {
				inputRef.current.value = '';
				inputRef.current.removeAttribute('data-composing');
			}
		};
		if (!listening) {
			resetComposition();
			return;
		}
		const visibilityChanged = (): void => {
			if (document.hidden) {
				resetComposition();
			}
		};
		window.addEventListener('blur', resetComposition);
		document.addEventListener('visibilitychange', visibilityChanged);
		return () => {
			window.removeEventListener('blur', resetComposition);
			document.removeEventListener('visibilitychange', visibilityChanged);
		};
	}, [inputRef, composingRef, listening]);
}
