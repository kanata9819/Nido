import { onNidoEvent } from '../nidoEvents';
import { useEffect, useRef, type RefObject } from 'react';
import type { Grid } from '../grid';
import { EditorRenderer } from '../editorRenderer';

// Connects an Editor component to its EditorRenderer, which draws the Neovim grid on a canvas.
interface UseEditorRenderingOptions {
	backgroundOpacity: number;
	animations: boolean;
	smoothCursor: boolean;
	smoothBlink: boolean;
	pixelScroll: boolean;
	id: string;
	fontSize: number;
	fontWeight: number;
	lineHeight: number;
	blocked: boolean;
	active: boolean;
	focusTick: number;
	onError: (message: string) => void;
	onReady?: (id: string) => void;
	errorRef: RefObject<(message: string) => void>;
	hostRef: RefObject<HTMLDivElement | null>;
	canvasRef: RefObject<HTMLCanvasElement | null>;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	gridRef: RefObject<Grid>;
	attachedRef: RefObject<boolean>;
	paintRef: RefObject<() => void>;
	afterPaintRef: RefObject<(motionOffset: number) => void>;
	scrollRef: RefObject<
		(lines: number, follow: boolean, discrete: boolean, columns?: number) => void
	>;
	scrollCompletionRef: RefObject<Promise<void>>;
	fontFamily: string;
}

/**
 * Create the EditorRenderer for an editor and keep it in sync with the settings. Settings
 * that only change how frames are drawn go through refs, so the renderer keeps running;
 * the rest create a new renderer.
 */
export function useEditorRendering({
	backgroundOpacity,
	animations,
	smoothCursor,
	smoothBlink,
	pixelScroll,
	id,
	fontSize,
	fontWeight,
	lineHeight,
	blocked,
	active,
	focusTick,
	onError,
	onReady,
	errorRef,
	hostRef,
	canvasRef,
	inputRef,
	gridRef,
	attachedRef,
	paintRef,
	afterPaintRef,
	scrollRef,
	scrollCompletionRef,
	fontFamily
}: UseEditorRenderingOptions): void {
	const animationsRef = useRef(animations);
	const smoothCursorRef = useRef(smoothCursor);
	const scrollEnabledRef = useRef(active && !blocked);
	useEffect(() => {
		scrollEnabledRef.current = active && !blocked;
		paintRef.current();
	}, [active, blocked, paintRef]);
	useEffect(() => {
		smoothCursorRef.current = smoothCursor;
		paintRef.current();
	}, [smoothCursor, paintRef]);
	useEffect(() => {
		animationsRef.current = animations;
		paintRef.current();
	}, [animations, paintRef]);

	useEffect(() => {
		errorRef.current = onError;
	}, [onError, errorRef]);

	// Create the renderer; paintRef and scrollRef let the rest of the editor drive it.
	useEffect(() => {
		const renderer = new EditorRenderer(
			{
				id,
				grid: gridRef.current,
				host: hostRef.current!,
				surface: canvasRef.current!,
				input: inputRef.current!,
				backgroundOpacity,
				pixelScroll,
				smoothBlink,
				fontSize,
				fontFamily,
				fontWeight,
				lineHeight,
				onReady,
				animationsRef,
				smoothCursorRef,
				scrollEnabledRef,
				errorRef,
				attachedRef,
				inputRef,
				afterPaintRef,
				scrollCompletionRef
			},
			onNidoEvent
		);
		paintRef.current = renderer.schedule;
		scrollRef.current = renderer.scroll;
		return () => {
			paintRef.current = () => {};
			scrollRef.current = () => {};
			renderer.dispose();
		};
	}, [
		backgroundOpacity,
		onReady,
		id,
		fontSize,
		fontWeight,
		lineHeight,
		fontFamily,
		smoothBlink,
		pixelScroll,
		hostRef,
		canvasRef,
		inputRef,
		gridRef,
		attachedRef,
		errorRef,
		paintRef,
		afterPaintRef,
		scrollRef,
		scrollCompletionRef
	]);

	// Focus the active editor when it becomes usable or is asked to take focus.
	useEffect(() => {
		if (active && !blocked) {
			inputRef.current?.focus();
			paintRef.current();
		}
	}, [active, blocked, focusTick, inputRef, paintRef]);
}
