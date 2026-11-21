// Draws the rows of a diff pane: separators, the lines of one side, and inline lines.
import type { ReferencePreview } from '../../../../shared/types';
import type { Translator } from '../../../../shared/i18n';
import type { DiffRow } from './splitDiff';
import type { DiffEmphasis, DiffViewRow } from './diffView';
import type { SideSource } from './diffModel';
import type { HighlightedSides } from './useDiffHighlight';
import type { Side } from './usePaneSync';
import styles from '../Git.module.css';

type Spans = ReferencePreview['lines'][number];

/** What drawing a row needs to know about the whole diff. */
export interface DiffRowContext {
	rows: DiffRow[];
	sources: [SideSource, SideSource];
	emphasis: (index: number) => DiffEmphasis | undefined;
	highlighted: HighlightedSides | undefined;
	/** The diff row of the change selected with n/N, if any. */
	selectedRow: number | undefined;
	/** The first drawn row of each diff row; only that one is marked as the selected change. */
	firstPositions: Map<number, number>;
	t: Translator;
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
 * A line's text: highlighted when highlighting has loaded, plain otherwise, with the changed
 * part of a replaced line marked. A space keeps empty rows at full height.
 */
function lineContent(context: DiffRowContext, side: Side, index: number): React.ReactNode {
	const line = context.rows[index][side];
	if (!line) {
		return ' ';
	}
	const sideIndex = side === 'before' ? 0 : 1;
	const spans = context.highlighted?.[sideIndex]?.[
		context.sources[sideIndex].positions[index]
	] || [{ text: line.text, color: '' }];
	const range = context.emphasis(index)?.[side];
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

function separator(
	entry: Extract<DiffViewRow, { kind: 'separator' }>,
	position: number,
	t: Translator
): React.JSX.Element {
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

/** The class, line numbers and text of a row in a split pane, or of an inline row. */
function lineParts(
	context: DiffRowContext,
	entry: Exclude<DiffViewRow, { kind: 'separator' }>,
	side: Side
): { className: string; numbers: React.ReactNode; content: React.ReactNode } {
	if (entry.kind === 'row') {
		const { row } = entry;
		const line = row[side];
		const numbers = <span>{line?.number}</span>;
		if (row.heading) {
			return { className: styles.hunk, numbers, content: row.heading };
		}
		const className = line?.changed
			? side === 'before'
				? styles.removed
				: styles.added
			: !line
				? styles.emptyLine
				: '';
		return { className, numbers, content: lineContent(context, side, entry.index) };
	}
	return {
		className:
			entry.side === 'both' ? '' : entry.side === 'before' ? styles.removed : styles.added,
		numbers: (
			<>
				<span>{entry.before}</span>
				<span>{entry.after}</span>
			</>
		),
		content: lineContent(context, entry.side === 'before' ? 'before' : 'after', entry.index)
	};
}

/** One drawn row in a pane: a separator, a line of one side, or an inline line. */
export function renderDiffRow(
	context: DiffRowContext,
	entry: DiffViewRow,
	position: number,
	side: Side
): React.JSX.Element {
	if (entry.kind === 'separator') {
		return separator(entry, position, context.t);
	}
	const active =
		context.selectedRow === entry.index && context.firstPositions.get(entry.index) === position;
	const { className, numbers, content } = lineParts(context, entry, side);
	const line = entry.kind === 'line' ? entry.line : entry.row[side];
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
			<code>
				{content}
				{line?.missingNewline && (
					<span className={styles.missingNewline}>
						{context.t('No newline at end of file')}
					</span>
				)}
			</code>
		</div>
	);
}
