import { useI18n } from '../i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { splitDiff } from './diff/splitDiff';
import { diffViewRows, rowEmphasis, type DiffLayout } from './diff/diffView';
import {
	changeStarts,
	firstPositions,
	hasLines as diffHasLines,
	longestLine,
	savedLayout,
	saveLayout,
	sideSources
} from './diff/diffModel';
import { useDiffHighlight } from './diff/useDiffHighlight';
import { rowHeight, usePaneSync, type Side } from './diff/usePaneSync';
import { renderDiffRow, type DiffRowContext } from './diff/diffRows';
import { DiffNavigation, LayoutSwitch, PaneHeading } from './diff/DiffToolbar';
import styles from './Git.module.css';

// Rows are drawn virtually: only the visible rows and `overscan` rows around them exist.
const overscan = 20;

/**
 * A diff with syntax highlighting, side by side or inline (v switches). Side by side, both
 * panes scroll together. n/N jump between changes, and a separator marks the unchanged lines
 * between hunks.
 */
export default function GitDiff({
	workspaceId,
	path,
	diff,
	label,
	beforeLabel,
	afterLabel
}: {
	workspaceId: string;
	path: string;
	diff: string;
	label: string;
	beforeLabel: string;
	afterLabel: string;
}): React.JSX.Element {
	const t = useI18n();
	const rows = useMemo(() => splitDiff(diff), [diff]);
	const [layout, setLayout] = useState<DiffLayout>(savedLayout);
	const display = useMemo(() => diffViewRows(rows, layout), [rows, layout]);
	const emphasis = useMemo(() => rowEmphasis(rows), [rows]);
	const displayIndex = useMemo(() => firstPositions(display), [display]);
	const hasPath = !!path;
	const sources = useMemo(() => (hasPath ? sideSources(rows) : undefined), [hasPath, rows]);
	const changes = useMemo(() => changeStarts(rows), [rows]);
	const width = useMemo(() => longestLine(rows), [rows]);
	const hasLines = diffHasLines(rows);
	const panes = usePaneSync(diff, hasLines);
	const { before, after, height } = panes;
	const highlight = useDiffHighlight(workspaceId, path, diff, sources);

	// The first drawn row in view, and the drawn rows around it.
	const [viewport, setViewport] = useState({ diff, row: 0 });
	const topRow = viewport.diff === diff ? viewport.row : 0;
	const first = Math.max(0, topRow - overscan);
	const last = Math.min(display.length, topRow + Math.ceil(height / rowHeight) + overscan);
	const visible = display.slice(first, last);

	const [selectedChange, setSelectedChange] = useState<{ diff: string; row: number }>();
	const selectedRow = selectedChange?.diff === diff ? selectedChange.row : undefined;
	const activeChange = selectedRow === undefined ? -1 : changes.indexOf(selectedRow);

	/** Scroll both panes to the next (1) or previous (-1) change. */
	function jump(direction: number): void {
		if (!changes.length) {
			return;
		}
		// Without a selected change, start from the first (or for -1 the last) one.
		const next =
			activeChange >= 0
				? (activeChange + direction + changes.length) % changes.length
				: direction === 1
					? 0
					: changes.length - 1;
		const row = changes[next];
		setSelectedChange({ diff, row });
		scrollToRow(row);
	}

	/** Scroll both panes to show a diff row at the top. */
	function scrollToRow(row: number): void {
		const position = displayIndex(row);
		setViewport({ diff, row: position });
		panes.scrollTo(position);
	}

	// After switching layouts, keep the same diff row at the top and focus stays in the diff.
	const layoutAnchor = useRef<number | undefined>(undefined);
	useLayoutEffect(() => {
		const row = layoutAnchor.current;
		if (row === undefined) {
			return;
		}
		layoutAnchor.current = undefined;
		panes.alignHorizontally();
		after.current?.focus({ preventScroll: true });
		scrollToRow(row);
		// Runs only when the layout changes; scrollToRow reads the new rows of this render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [layout]);

	/** Switch between the side-by-side and inline layouts, keeping the first visible row. */
	function toggleLayout(): void {
		const next: DiffLayout = layout === 'split' ? 'unified' : 'split';
		const shown = display[topRow];
		setLayout(next);
		saveLayout(next);
		layoutAnchor.current = shown && shown.kind !== 'separator' ? shown.index : 0;
	}

	function paneKeyDown(event: React.KeyboardEvent): void {
		if (
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			event.nativeEvent.isComposing ||
			!['n', 'N', 'v'].includes(event.key)
		) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'v') {
			toggleLayout();
		} else {
			jump(event.shiftKey || event.key === 'N' ? -1 : 1);
		}
	}

	// Without lines, the message is centered across the diff instead of repeated in each pane.
	if (!hasLines) {
		return (
			<div
				className={styles.diffMessage}
				tabIndex={0}
				role="region"
				aria-label={label}
				data-git-scroll="after"
			>
				{rows.map((row, index) => (
					<p key={index}>{row.heading}</p>
				))}
			</div>
		);
	}

	const rowContext: DiffRowContext = {
		rows,
		sources,
		emphasis,
		highlighted: highlight.lines,
		selectedPosition: selectedRow === undefined ? undefined : displayIndex(selectedRow),
		t
	};
	const sides: Side[] = layout === 'split' ? ['before', 'after'] : ['after'];
	return (
		<div className={styles.splitDiff} data-layout={layout}>
			{sides.map((side) => (
				<div key={side} className={styles.diffPane}>
					<div className={styles.diffHeading}>
						<PaneHeading
							layout={layout}
							side={side}
							beforeLabel={beforeLabel}
							afterLabel={afterLabel}
						/>
						{side === 'after' && (
							<div className={styles.diffTools}>
								{changes.length > 0 && (
									<DiffNavigation
										count={changes.length}
										active={activeChange}
										jump={(direction) => {
											jump(direction);
											after.current?.focus({ preventScroll: true });
										}}
									/>
								)}
								<LayoutSwitch layout={layout} toggle={toggleLayout} />
							</div>
						)}
						{side === 'after' && highlight.error && (
							<span role="status">{t(highlight.error)}</span>
						)}
					</div>
					<pre
						ref={side === 'before' ? before : after}
						tabIndex={0}
						aria-label={side === 'before' ? t('{label} original', { label }) : label}
						data-git-scroll={side}
						onKeyDown={paneKeyDown}
						onScroll={(event) => {
							const row = panes.scrolled(side, event.currentTarget);
							if (row !== undefined) {
								setViewport((old) =>
									old.diff === diff && old.row === row ? old : { diff, row }
								);
							}
						}}
					>
						<div
							style={{
								height: display.length * rowHeight,
								minWidth: `calc(${width}ch + ${layout === 'split' ? 96 : 140}px)`,
								paddingTop: first * rowHeight
							}}
						>
							{visible.map((entry, offset) =>
								renderDiffRow(rowContext, entry, first + offset, side)
							)}
						</div>
					</pre>
				</div>
			))}
		</div>
	);
}
