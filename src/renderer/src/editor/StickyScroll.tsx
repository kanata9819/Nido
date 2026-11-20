import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StickyScrollState } from '../../../shared/types';
import type { StickyScrollCoverage } from '../../../shared/nidoApi';
import type { Grid } from '../grid/grid';
import { stickyRows, type StickyRow } from './stickyHeaders';
import styles from './StickyScroll.module.css';
import { listIndex } from '../ui/listNavigation';

/** What the sticky header draws, in pixels. */
interface Model {
	state: StickyScrollState;
	rows: StickyRow[];
	top: number;
	left: number;
	width: number;
	height: number;
	lineHeight: number;
	cellWidth: number;
	background: string;
	horizontalOffset: number;
}

interface LayoutInputs {
	state: StickyScrollState;
	rowGeometryVersion: number;
	motionOffset: number;
	surfaceTop: number;
	surfaceLeft: number;
	cellWidth: number;
	background: string;
	horizontalOffset: number;
}

/** Whether two models draw the same thing. */
function sameModel(previous: Model, next: Model): boolean {
	return (
		previous.state === next.state &&
		previous.top === next.top &&
		previous.width === next.width &&
		previous.left === next.left &&
		previous.cellWidth === next.cellWidth &&
		previous.lineHeight === next.lineHeight &&
		previous.background === next.background &&
		previous.horizontalOffset === next.horizontalOffset &&
		previous.rows.length === next.rows.length &&
		previous.rows.every(
			(row, index) =>
				row.scope === next.rows[index].scope && row.offset === next.rows[index].offset
		)
	);
}

/**
 * Sticky scroll: the header lines of the scopes that contain the top of the window, pinned
 * above the editor. Clicking a header jumps to it; holding Shift over one shows its end line.
 */
export default function StickyScroll({
	id,
	grid,
	paintRef,
	coverageRef,
	input,
	scrollCompletion,
	maxLines,
	fontSize,
	fontWeight = 400,
	fontFamily,
	onError
}: {
	id: string;
	grid: RefObject<Grid>;
	paintRef: RefObject<(motionOffset: number) => void>;
	coverageRef: RefObject<StickyScrollCoverage | undefined>;
	input: RefObject<HTMLTextAreaElement | null>;
	scrollCompletion: RefObject<Promise<void>>;
	maxLines: number;
	fontSize: number;
	fontWeight?: number;
	fontFamily: string;
	onError: (message: string) => void;
}): React.JSX.Element | null {
	const t = useI18n();
	const [model, setModel] = useState<Model>();
	// The header whose end line is shown instead, while Shift is held over it.
	const [peek, setPeek] = useState<number>();
	const hovered = useRef<number>(undefined);
	// Pressing or releasing Shift over a header switches it between its first and end line.
	useEffect(() => {
		const keyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Shift') {
				setPeek(hovered.current);
			}
		};
		const keyUp = (event: KeyboardEvent): void => {
			if (event.key === 'Shift') {
				setPeek(undefined);
			}
		};
		const blur = (): void => setPeek(undefined);
		window.addEventListener('keydown', keyDown);
		window.addEventListener('keyup', keyUp);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', keyDown);
			window.removeEventListener('keyup', keyUp);
			window.removeEventListener('blur', blur);
		};
	}, []);
	// Follow scroll frames, reusing the model's inputs across unrelated cursor paints.
	useLayoutEffect(() => {
		let last: LayoutInputs | null | undefined;
		const update = (motionOffset: number): void => {
			const surface = grid.current;
			const {
				stickyScroll: state,
				rowGeometryVersion,
				cellHeight,
				cellWidth,
				surfaceTop,
				surfaceLeft,
				background,
				horizontalOffset
			} = surface;
			if (!state || !cellHeight) {
				coverageRef.current = undefined;
				if (last !== null) {
					last = null;
					setModel(undefined);
				}
				return;
			}
			if (
				last?.state === state &&
				last.rowGeometryVersion === rowGeometryVersion &&
				last.motionOffset === motionOffset &&
				last.surfaceTop === surfaceTop &&
				last.surfaceLeft === surfaceLeft &&
				last.cellWidth === cellWidth &&
				last.background === background &&
				last.horizontalOffset === horizontalOffset
			) {
				return;
			}
			last = {
				state,
				rowGeometryVersion,
				motionOffset,
				surfaceTop,
				surfaceLeft,
				cellWidth,
				background,
				horizontalOffset
			};
			const top = surface.rowTop(state.top);
			const rows = stickyRows(
				state,
				(row) => surface.rowY(row),
				top,
				cellHeight,
				maxLines,
				motionOffset
			);
			const coveredHeight = rows.length * cellHeight + (rows.at(-1)?.offset ?? 0);
			let coveredRows = 0;
			// The cursor resumes on grid rows with the fractional wheel offset cleared.
			while (
				coveredRows < state.height - 1 &&
				surface.rowTop(state.top + coveredRows) - top < coveredHeight - 0.0001
			) {
				coveredRows++;
			}
			coverageRef.current = coveredRows
				? { window: state.window, buffer: state.buffer, rows: coveredRows }
				: undefined;
			const next: Model | undefined = rows.length
				? {
						state,
						rows,
						top: top + surfaceTop,
						left: state.left * cellWidth + surfaceLeft,
						width: state.width * cellWidth,
						height: coveredHeight,
						lineHeight: cellHeight,
						cellWidth,
						background,
						horizontalOffset
					}
				: undefined;
			// Keep the previous model when nothing changed, so React skips the render.
			setModel((previous) =>
				previous && next && sameModel(previous, next) ? previous : next
			);
		};
		paintRef.current = update;
		const frame = requestAnimationFrame(() => update(0));
		return () => {
			cancelAnimationFrame(frame);
			paintRef.current = () => {};
			coverageRef.current = undefined;
		};
	}, [grid, paintRef, coverageRef, maxLines]);

	if (!model) {
		return null;
	}
	// Jump to a header's line (or its end line), after any scroll in progress has finished.
	const jump = (scope: StickyRow['scope'], ending: boolean): void => {
		const state = model.state;
		void (async () => {
			await scrollCompletion.current;
			await window.nido.jumpSticky(
				id,
				state.window,
				state.buffer,
				ending ? scope.ending : scope.line
			);
			input.current?.focus();
		})().catch((error) => onError(String(error)));
	};
	return (
		<div
			className={styles.sticky}
			data-sticky-scroll={id}
			role="navigation"
			aria-label={t('Sticky Scroll')}
			style={{
				top: model.top,
				left: model.left,
				width: model.width,
				height: model.height,
				background: model.background,
				fontSize,
				fontWeight,
				fontFamily,
				lineHeight: `${model.lineHeight}px`,
				tabSize: model.state.tabstop
			}}
			// With focus in the headers (Alt+Shift+S), j/k move between them and Esc returns.
			onKeyDown={(event) => {
				const buttons = [
					...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
				];
				const index = buttons.indexOf(event.target as HTMLButtonElement);
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					input.current?.focus();
				} else if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
					event.preventDefault();
					event.stopPropagation();
					buttons[listIndex(event.key, index, buttons.length)]?.focus();
				}
			}}
		>
			{model.rows.map(({ scope, offset }, index) => {
				const ending = peek === scope.line;
				const line = ending ? scope.ending : scope.line;
				const relativeTo = model.state.relativeTo;
				const spans = ending ? scope.endText : scope.text;
				const positioned = spans.every((span) => span.cells !== undefined);
				let column = 0;
				return (
					<div
						key={scope.line}
						className={styles.row}
						style={{ top: index * model.lineHeight, height: model.lineHeight }}
					>
						<button
							type="button"
							style={{
								height: model.lineHeight,
								transform: `translateY(${offset}px)`
							}}
							data-source-line={scope.line}
							aria-label={t('Go to line {line}', {
								line: ending ? scope.ending : scope.line
							})}
							title={t(
								'Jump to this scope · Shift: ending line · Alt+Shift+S: focus headers'
							)}
							onPointerEnter={(event) => {
								hovered.current = scope.line;
								setPeek(event.shiftKey ? scope.line : undefined);
							}}
							onPointerMove={(event) =>
								setPeek(event.shiftKey ? scope.line : undefined)
							}
							onPointerLeave={() => {
								hovered.current = undefined;
								setPeek(undefined);
							}}
							onClick={(event) => jump(scope, event.shiftKey)}
						>
							<span
								className={styles.number}
								style={{
									width: model.state.gutter * model.cellWidth,
									paddingRight: model.cellWidth
								}}
							>
								{relativeTo && line !== relativeTo
									? Math.abs(line - relativeTo)
									: line}
							</span>
							<span className={styles.code}>
								<span
									style={{
										transform: `translateX(${-model.state.leftcol * model.cellWidth + model.horizontalOffset}px)`
									}}
								>
									{spans.map((span, i) => {
										// Use the total column so fractional CSS widths cannot accumulate rounding errors.
										const left = column * model.cellWidth;
										column += span.cells ?? 0;
										return (
											<span
												key={i}
												style={{
													color: span.color,
													position: positioned ? 'absolute' : undefined,
													top: positioned ? 0 : undefined,
													left: positioned ? left : undefined,
													width: positioned
														? span.cells! * model.cellWidth
														: undefined
												}}
											>
												{positioned && span.text === '\t' ? ' ' : span.text}
											</span>
										);
									})}
								</span>
							</span>
						</button>
					</div>
				);
			})}
		</div>
	);
}
