import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReferencePreview } from '../../../shared/types';
import { ChevronDown, ChevronUp, Columns2, Rows2 } from 'lucide-react';
import { splitDiff } from './gitDiff';
import {
	diffViewRows,
	rowEmphasis,
	type DiffEmphasis,
	type DiffLayout,
	type DiffViewRow
} from './diffView';
import styles from '../assets/GitPanel.module.css';

// Rows are drawn virtually: only the visible rows and `overscan` rows around them exist.
const rowHeight = 22;
const overscan = 20;
const layoutKey = 'nido.diffLayout';

type Side = 'before' | 'after';
type Spans = ReferencePreview['lines'][number];

/** The saved layout of diffs, side by side unless the inline layout was chosen. */
function savedLayout(): DiffLayout {
	try {
		return localStorage.getItem(layoutKey) === 'unified' ? 'unified' : 'split';
	} catch {
		return 'split';
	}
}

/**
 * Split syntax-highlighted spans so the characters in [start, end) are marked as the changed
 * part of a replaced line.
 */
function emphasize(spans: Spans, [start, end]: [number, number]): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	let offset = 0;
	spans.forEach((span, spanIndex) => {
		const text = span.text;
		const cuts = [0, start - offset, end - offset, text.length]
			.map((cut) => Math.max(0, Math.min(text.length, cut)))
			.filter((cut, index, all) => index === 0 || cut > all[index - 1]);
		for (let part = 0; part < cuts.length - 1; part++) {
			const from = cuts[part];
			const to = cuts[part + 1];
			const marked = offset + from >= start && offset + to <= end && start < end;
			nodes.push(
				<span
					key={`${spanIndex}:${from}`}
					style={{ color: span.color }}
					className={marked ? styles.emphasis : undefined}
				>
					{text.slice(from, to)}
				</span>
			);
		}
		offset += text.length;
	});
	return nodes;
}

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
	// The first drawn row of each diff row, to scroll to a change.
	const displayIndex = useMemo(() => {
		const first = new Map<number, number>();
		display.forEach((entry, position) => {
			if (entry.kind !== 'separator' && !first.has(entry.index)) {
				first.set(entry.index, position);
			}
		});
		return first;
	}, [display]);
	// The text of each side, for syntax highlighting, and for each row its line in that text.
	const sources = useMemo(
		() =>
			(['before', 'after'] as const).map((side) => {
				const lines: string[] = [];
				const positions = rows.map((row) => {
					if (!row[side]) {
						return -1;
					}
					lines.push(row[side].text);
					return lines.length - 1;
				});
				return { text: lines.join('\n'), positions };
			}),
		[rows]
	);
	// The first row of every block of changed rows, for n/N.
	const changes = useMemo(
		() =>
			rows.flatMap((row, index) =>
				(row.before?.changed || row.after?.changed) &&
				!(rows[index - 1]?.before?.changed || rows[index - 1]?.after?.changed)
					? [index]
					: []
			),
		[rows]
	);
	// The longest line, so both panes scroll horizontally the same distance.
	const width = useMemo(
		() =>
			rows.reduce(
				(max, row) =>
					Math.max(
						max,
						row.before?.text.length || 0,
						row.after?.text.length || 0,
						row.heading?.length || 0
					),
				0
			),
		[rows]
	);
	const [viewport, setViewport] = useState({ diff, row: 0 });
	const [height, setHeight] = useState(600);
	const topRow = viewport.diff === diff ? viewport.row : 0;
	const first = Math.max(0, topRow - overscan);
	const last = Math.min(display.length, topRow + Math.ceil(height / rowHeight) + overscan);
	const visible = display.slice(first, last);
	const [selectedChange, setSelectedChange] = useState<{ diff: string; row: number }>();
	const activeChange = selectedChange?.diff === diff ? changes.indexOf(selectedChange.row) : -1;
	const [highlighted, setHighlighted] = useState<{
		workspaceId: string;
		path: string;
		diff: string;
		lines?: ReferencePreview['lines'][];
		error?: string;
	}>();
	const currentHighlight =
		highlighted?.workspaceId === workspaceId &&
		highlighted.path === path &&
		highlighted.diff === diff
			? highlighted
			: undefined;
	const error = currentHighlight?.error || '';
	const before = useRef<HTMLPreElement>(null);
	const after = useRef<HTMLPreElement>(null);
	// The vertical position set by code, so its scroll event is not mirrored back.
	const synchronized = useRef(new WeakMap<HTMLPreElement, number>());
	const horizontalPositions = useRef(new WeakMap<HTMLPreElement, number>());

	/** Scroll both panes to the next (1) or previous (-1) change. */
	function jump(direction: number): void {
		if (!changes.length) {
			return;
		}
		// Without a selected change, start from the first (or for -1 the last) one.
		let next: number;
		if (activeChange >= 0) {
			next = (activeChange + direction + changes.length) % changes.length;
		} else {
			next = direction === 1 ? 0 : changes.length - 1;
		}
		const row = changes[next];
		setSelectedChange({ diff, row });
		scrollToRow(row);
	}

	/** Scroll both panes to show a diff row at the top. */
	function scrollToRow(row: number): void {
		const position = displayIndex.get(row) ?? 0;
		setViewport({ diff, row: position });
		for (const pane of [before.current, after.current]) {
			pane?.scrollTo({ top: position * rowHeight, behavior: 'instant' });
			if (pane) {
				synchronized.current.set(pane, pane.scrollTop);
			}
		}
	}

	// After switching layouts, keep the same diff row at the top and focus stays in the diff.
	const layoutAnchor = useRef<number | undefined>(undefined);
	useLayoutEffect(() => {
		const row = layoutAnchor.current;
		if (row === undefined) {
			return;
		}
		layoutAnchor.current = undefined;
		if (before.current && after.current) {
			before.current.scrollLeft = after.current.scrollLeft;
			horizontalPositions.current.set(before.current, before.current.scrollLeft);
		}
		after.current?.focus({ preventScroll: true });
		scrollToRow(row);
		// Runs only when the layout changes; scrollToRow reads the new rows of this render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [layout]);

	// A diff without any source lines is only a message (loading, an error, a binary file).
	const hasLines = rows.some((row) => row.before || row.after);
	// Track the pane height to know how many rows are visible. The pane appears once a
	// message such as "Loading diff…" gives way to lines.
	useEffect(() => {
		const pane = after.current;
		if (!pane) {
			return;
		}
		setHeight(pane.clientHeight);
		const observer = new ResizeObserver(() => setHeight(pane.clientHeight));
		observer.observe(pane);
		return () => observer.disconnect();
	}, [hasLines]);
	useEffect(() => {
		horizontalPositions.current = new WeakMap();
		before.current?.scrollTo({ top: 0, left: 0 });
		after.current?.scrollTo({ top: 0, left: 0 });
	}, [diff]);
	useEffect(() => {
		let cancelled = false;
		if (!path || !rows.some((row) => row.before || row.after)) {
			return;
		}
		void window.nido.highlightSources(workspaceId, path, sources[0].text, sources[1].text).then(
			(lines) => {
				if (!cancelled) {
					setHighlighted({ workspaceId, path, diff, lines });
				}
			},
			() => {
				if (!cancelled) {
					setHighlighted({
						workspaceId,
						path,
						diff,
						error: 'Syntax highlighting unavailable'
					});
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, [workspaceId, path, diff, rows, sources]);
	// A line's text: highlighted when highlighting has loaded, plain otherwise, with the
	// changed part of a replaced line marked. A space keeps empty rows at full height.
	function lineContent(side: Side, index: number): React.ReactNode {
		const line = rows[index][side];
		if (!line) {
			return ' ';
		}
		const sideIndex = side === 'before' ? 0 : 1;
		const spans = currentHighlight?.lines?.[sideIndex]?.[
			sources[sideIndex].positions[index]
		] || [{ text: line.text, color: '' }];
		const range = (emphasis[index] as DiffEmphasis | undefined)?.[side];
		if (!line.text) {
			return ' ';
		}
		if (range) {
			return emphasize(spans, range);
		}
		return spans.map((span, column) => (
			<span key={column} style={{ color: span.color || undefined }}>
				{span.text || ' '}
			</span>
		));
	}

	/** Switch between the side-by-side and inline layouts, keeping the first visible row. */
	function toggleLayout(): void {
		const next: DiffLayout = layout === 'split' ? 'unified' : 'split';
		const shown = display[topRow];
		setLayout(next);
		try {
			localStorage.setItem(layoutKey, next);
		} catch {
			// The layout is a convenience; it still switches for this diff.
		}
		layoutAnchor.current = shown && shown.kind !== 'separator' ? shown.index : 0;
	}

	/** One drawn row in a pane: a separator, a line of one side, or an inline line. */
	function renderRow(entry: DiffViewRow, position: number, side: Side): React.JSX.Element {
		if (entry.kind === 'separator') {
			return (
				<div key={position} className={`${styles.diffLine} ${styles.separator}`}>
					<span className={styles.gutter} aria-hidden="true">
						⋯
					</span>
					<span className={styles.separatorText}>
						{entry.hidden > 0 && (
							<span>{t('{count} unchanged lines', { count: entry.hidden })}</span>
						)}
						{entry.context && <code>{entry.context}</code>}
					</span>
				</div>
			);
		}
		const active =
			selectedChange?.diff === diff &&
			selectedChange.row === entry.index &&
			displayIndex.get(entry.index) === position;
		let className = '';
		let numbers: React.ReactNode;
		let content: React.ReactNode;
		if (entry.kind === 'row') {
			const { row } = entry;
			const line = row[side];
			if (row.heading) {
				className = styles.hunk;
				content = row.heading;
			} else {
				if (line?.changed) {
					className = side === 'before' ? styles.removed : styles.added;
				} else if (!line) {
					className = styles.emptyLine;
				}
				content = lineContent(side, entry.index);
			}
			numbers = <span>{line?.number}</span>;
		} else {
			if (entry.side !== 'both') {
				className = entry.side === 'before' ? styles.removed : styles.added;
			}
			numbers = (
				<>
					<span>{entry.before}</span>
					<span>{entry.after}</span>
				</>
			);
			content = lineContent(entry.side === 'before' ? 'before' : 'after', entry.index);
		}
		return (
			<div
				key={position}
				data-diff-row={entry.index}
				data-diff-active={active ? 'true' : undefined}
				className={`${styles.diffLine} ${className}`}
			>
				<span className={styles.gutter} aria-hidden="true">
					{numbers}
				</span>
				<code>{content}</code>
			</div>
		);
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

	const panes: Side[] = layout === 'split' ? ['before', 'after'] : ['after'];
	const navigation = changes.length > 0 && (
		<div className={styles.diffNavigation}>
			<span>
				{activeChange < 0
					? t('{count} changes', { count: changes.length })
					: t('Change {current} / {total}', {
							current: activeChange + 1,
							total: changes.length
						})}{' '}
				· n / N
			</span>
			{[
				{
					direction: -1,
					title: t('Previous change (N)'),
					Icon: ChevronUp
				},
				{ direction: 1, title: t('Next change (n)'), Icon: ChevronDown }
			].map(({ direction, title, Icon }) => (
				<button
					key={direction}
					aria-label={title}
					title={title}
					onClick={() => {
						jump(direction);
						after.current?.focus({ preventScroll: true });
					}}
				>
					<Icon size={16} aria-hidden="true" />
				</button>
			))}
		</div>
	);
	const layoutSwitch = (
		<div className={styles.layoutSwitch} role="group" aria-label={t('Diff layout (v)')}>
			{(
				[
					{ value: 'split', title: t('Side by side'), Icon: Columns2 },
					{ value: 'unified', title: t('Inline'), Icon: Rows2 }
				] as const
			).map(({ value, title, Icon }) => (
				<button
					key={value}
					aria-label={title}
					title={`${title} (v)`}
					aria-pressed={layout === value}
					onClick={() => {
						if (layout !== value) {
							toggleLayout();
						}
					}}
				>
					<Icon size={15} aria-hidden="true" />
				</button>
			))}
		</div>
	);

	return (
		<div className={styles.splitDiff} data-layout={layout}>
			{panes.map((side) => (
				<div key={side} className={styles.diffPane}>
					<div className={styles.diffHeading}>
						{layout === 'split' ? (
							<>
								<strong>{side === 'before' ? t('Before') : t('After')}</strong>
								<span>{side === 'before' ? beforeLabel : afterLabel}</span>
							</>
						) : (
							<>
								<strong>{t('Before')}</strong>
								<span>{beforeLabel}</span>
								<span aria-hidden="true">→</span>
								<strong>{t('After')}</strong>
								<span>{afterLabel}</span>
							</>
						)}
						{side === 'after' && (
							<div className={styles.diffTools}>
								{navigation}
								{layoutSwitch}
							</div>
						)}
						{side === 'after' && error && <span role="status">{t(error)}</span>}
					</div>
					<pre
						ref={side === 'before' ? before : after}
						tabIndex={0}
						aria-label={side === 'before' ? t('{label} original', { label }) : label}
						data-git-scroll={side}
						onKeyDown={(event) => {
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
						}}
						onScroll={(event) => {
							const pane = event.currentTarget;
							const other = side === 'before' ? after.current : before.current;
							const left = pane.scrollLeft;
							if (left !== (horizontalPositions.current.get(pane) ?? 0)) {
								horizontalPositions.current.set(pane, left);
								if (other && other.scrollLeft !== left) {
									other.scrollLeft = left;
									// Record the applied offset in case this pane has a shorter scroll range.
									horizontalPositions.current.set(other, other.scrollLeft);
								}
							}
							const expected = synchronized.current.get(pane);
							// A delayed programmatic event must not overwrite a newer gesture in the other pane.
							if (
								expected !== undefined &&
								Math.abs(pane.scrollTop - expected) <= 1
							) {
								return;
							}
							synchronized.current.delete(pane);
							const row = Math.floor(pane.scrollTop / rowHeight);
							setViewport((old) =>
								old.diff === diff && old.row === row ? old : { diff, row }
							);
							if (other && Math.abs(other.scrollTop - pane.scrollTop) > 1) {
								other.scrollTop = pane.scrollTop;
								synchronized.current.set(other, other.scrollTop);
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
							{visible.map((entry, offset) => renderRow(entry, first + offset, side))}
						</div>
					</pre>
				</div>
			))}
		</div>
	);
}
