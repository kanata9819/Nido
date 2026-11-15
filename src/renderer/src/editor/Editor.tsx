// One editor per workspace. Text is painted on a <canvas> from the Grid (grid/grid.ts).
// Keys arrive through a hidden <textarea> so IME composition works (useEditorInput.ts).
// useEditorRendering.ts applies Neovim events and repaints.
import { useI18n } from '../i18n';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Grid } from '../grid/grid';
import { useEditorRendering } from './useEditorRendering';
import { useEditorInput } from './useEditorInput';
import { useCompositionReset, useEditorWheel } from './useEditorWheel';
import { clickCell, clickedCell, focusEditorPart } from './editorClick';
import styles from './Editor.module.css';
import TypeInformation from './popups/TypeInformation';
import DiagnosticInformation from './popups/DiagnosticInformation';
import CompletionMenu from './popups/CompletionMenu';
import StickyScroll from './StickyScroll';
import NeovimUI from '../neovim/NeovimUI';
import type { UITheme } from '../../../shared/types';
import { defaultFontWeight } from '../settings/useEditorSettings';

/** Settings and callbacks of one editor; `blocked` is true while a dialog covers it. */
interface Props {
	theme: UITheme;
	scrollFollowCursor?: boolean;
	stickyScroll?: boolean;
	stickyScrollMaxLines?: number;
	terminal?: boolean;
	children?: ReactNode;
	id: string;
	active: boolean;
	fontSize: number;
	fontWeight?: number;
	lineHeight: number;
	animations: boolean;
	smoothCursor: boolean;
	smoothBlink: boolean;
	blocked: boolean;
	focusTick: number;
	fontFamily: string;
	onError: (message: string) => void;
	onReady?: (id: string) => void;
}

export default memo(Editor);

function Editor({
	theme,
	scrollFollowCursor = true,
	stickyScroll = true,
	stickyScrollMaxLines = 5,
	terminal = false,
	children,
	id,
	active,
	fontSize,
	fontWeight = defaultFontWeight,
	lineHeight,
	animations,
	smoothCursor,
	smoothBlink,
	blocked,
	focusTick,
	fontFamily,
	onError,
	onReady
}: Props): React.JSX.Element {
	const t = useI18n();
	const host = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const [editorGrid] = useState(() => new Grid());
	const grid = useRef(editorGrid);
	const composing = useRef(false);
	const attached = useRef(false);
	// Functions the renderer installs: repaint, the sticky scroll repaint, and scroll.
	const paint = useRef<() => void>(() => {});
	const stickyPaint = useRef<(motionOffset: number) => void>(() => {});
	const scroll = useRef<
		(lines: number, follow: boolean, discrete: boolean, columns?: number) => void
	>(() => {});
	// The latest scroll request; clicks and sticky jumps wait for it so they hit the right row.
	const scrollCompletion = useRef<Promise<void>>(Promise.resolve());
	const error = useRef(onError);

	const send = (promise: Promise<unknown>): void => {
		void promise.catch((e) => error.current(String(e)));
	};
	const wheelScroll = useEditorWheel({
		id,
		terminal,
		lineHeight,
		scrollFollowCursor,
		gridRef: grid,
		scrollRef: scroll,
		send,
		reset: [active, blocked, lineHeight, fontSize, fontFamily]
	});
	useCompositionReset(input, composing, active && !blocked);

	useEffect(() => {
		error.current = onError;
	}, [onError]);

	useEditorRendering({
		backgroundOpacity: theme === 'acrylic' ? 0.5 : 1,
		animations,
		smoothCursor,
		smoothBlink,
		id,
		fontSize,
		fontWeight,
		lineHeight,
		blocked,
		active,
		focusTick,
		onError,
		onReady,
		errorRef: error,
		hostRef: host,
		canvasRef: canvas,
		inputRef: input,
		gridRef: grid,
		attachedRef: attached,
		paintRef: paint,
		afterPaintRef: stickyPaint,
		scrollRef: scroll,
		scrollCompletionRef: scrollCompletion,
		fontFamily: fontFamily,
		pixelScroll: !terminal
	});

	const inputHandlers = useEditorInput({
		id,
		blocked: blocked || !active,
		composingRef: composing,
		paintRef: paint,
		onError
	});

	/** A click moves Neovim's cursor to the clicked cell. */
	const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (
			event.button !== 0 ||
			blocked ||
			!active ||
			composing.current ||
			event.target !== canvas.current
		) {
			return;
		}
		event.preventDefault();
		input.current?.focus();
		if (terminal) {
			return;
		}
		const cell = clickedCell(grid.current, canvas.current, event.clientX, event.clientY);
		if (cell) {
			send(clickCell(id, grid.current, cell, scrollCompletion.current, () => !!host.current));
		}
	};

	return (
		<div
			ref={host}
			className={styles.editor}
			hidden={!active}
			onKeyDownCapture={(event) => {
				if (!blocked) {
					focusEditorPart(event, host.current);
				}
			}}
			onPointerDown={pointerDown}
			onWheel={(event) => {
				if (
					blocked ||
					!active ||
					event.ctrlKey ||
					composing.current ||
					(event.target as Element).closest(
						'[data-type-information], [data-diagnostic-information], [data-neovim-ui]'
					)
				) {
					return;
				}
				wheelScroll(event);
			}}
		>
			<canvas
				key={theme === 'acrylic' ? 'acrylic' : 'opaque'}
				ref={canvas}
				className={styles.canvas}
				aria-label={terminal ? t('Terminal display') : t('Neovim editor display')}
			/>
			{children}
			<NeovimUI
				id={id}
				grid={grid}
				input={input}
				paint={paint}
				fontFamily={fontFamily}
				hidden={blocked || !active}
				onError={onError}
			/>
			{!terminal && active && stickyScroll && (
				<StickyScroll
					id={id}
					grid={grid}
					paintRef={stickyPaint}
					input={input}
					scrollCompletion={scrollCompletion}
					maxLines={stickyScrollMaxLines}
					fontSize={fontSize}
					fontWeight={fontWeight}
					fontFamily={fontFamily}
					onError={onError}
				/>
			)}
			{!terminal && (
				<CompletionMenu
					id={id}
					grid={grid}
					input={input}
					fontFamily={fontFamily}
					onError={onError}
					hidden={blocked || !active}
				/>
			)}
			{!terminal && (
				<>
					<TypeInformation
						id={id}
						input={input}
						fontFamily={fontFamily}
						hidden={!active || blocked}
					/>
					<DiagnosticInformation
						id={id}
						input={input}
						fontFamily={fontFamily}
						onError={onError}
						hidden={!active || blocked}
					/>
				</>
			)}
			<textarea
				ref={input}
				className={styles.editorInput}
				style={{
					fontFamily,
					fontSize,
					fontWeight,
					lineHeight: `${lineHeight}px`,
					height: lineHeight
				}}
				data-editor-input={terminal ? 'terminal' : 'editor'}
				aria-label={terminal ? t('Terminal input') : t('Neovim input')}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				wrap="off"
				{...inputHandlers}
			/>
		</div>
	);
}
