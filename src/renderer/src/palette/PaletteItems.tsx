import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { Panel, Item } from '../types';
import styles from './Palette.module.css';
import PaletteItem from './PaletteItem';
import { hasOptions, paletteOptionId } from './paletteRows';
import { emptyMessage, hint, placeholder } from './paletteText';
import { useTabSelection } from './useTabSelection';
import { useMeasuredList } from '../ui/useMeasuredList';
import {
	isLeaveTypingKey,
	isStartTypingKey,
	navigateSearchList
} from '../search/workspaceSearchNavigation';

// The filter field and result list shared by the palettes (commands, files, workspaces,
// open files, problems, symbols and text search).
/** An action waiting in the palette for Enter (confirm) or any other key (cancel). */
export interface PaletteConfirmation {
	message: string;
	confirm: () => void;
	cancel: () => void;
}

interface PaletteItemsProps {
	panel: Exclude<Panel, null>;
	filtered: Item[];
	selection: number;
	query: string;
	loading: boolean;
	message?: string;
	setQuery: (value: string) => void;
	setSelection: React.Dispatch<React.SetStateAction<number>>;
	confirmation?: PaletteConfirmation;
	/** Closes the palette; Ctrl+C on the list calls it, like Escape. */
	onClose?: () => void;
}

const problemHeight = (): number => 46;

/**
 * A palette's filter field and results. A palette opens on its list, as in Vim's Normal mode:
 * j/k move, Enter runs the selected item, and i, a or / start typing in the filter field.
 * Escape or Ctrl+C in the field returns to the list, keeping the filter; on the list they close
 * the palette. While results are still loading, Enter is remembered and runs the first result
 * for that query once loaded.
 */
export default function PaletteItems({
	panel,
	filtered,
	selection: fallbackSelection,
	query,
	loading,
	message,
	setQuery,
	setSelection: setFallbackSelection,
	confirmation,
	onClose
}: PaletteItemsProps): React.JSX.Element {
	const t = useI18n();
	const results = useRef<HTMLDivElement>(null);
	const filter = useRef<HTMLInputElement>(null);
	const pendingEnter = useRef<string | undefined>(undefined);
	const { selection, setSelection, reorderable, reorderTab, clearTab } = useTabSelection({
		panel,
		filtered,
		fallbackSelection,
		setFallbackSelection
	});
	const virtual = useMeasuredList(
		results,
		filtered,
		selection,
		panel === 'problems' && filtered.length > 80,
		problemHeight
	);
	// Whether the filter field has focus: typing, rather than moving through the list.
	const [typing, setTyping] = useState(false);
	// Run the Enter pressed while loading, unless the query changed or focus left the palette.
	useEffect(() => {
		if (!loading && pendingEnter.current === query) {
			pendingEnter.current = undefined;
			if ([filter.current, results.current].includes(document.activeElement as never)) {
				filtered[Math.max(0, selection)]?.run();
			}
		}
	}, [loading, query, filtered, selection]);
	// Every palette opens on its list; keep the selection in range as the list changes.
	useEffect(() => {
		results.current?.focus();
	}, [panel]);
	useEffect(() => {
		setFallbackSelection((index) => Math.max(0, Math.min(index, filtered.length - 1)));
	}, [panel, filtered.length, setFallbackSelection]);
	// Keep the selected item in view while the list resizes.
	useEffect(() => {
		const node = results.current;
		if (!node) {
			return;
		}
		const observer = new ResizeObserver(() => {
			node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [panel]);

	// A pending confirmation takes Enter; any other key cancels it and acts as usual.
	// Returns whether the key confirmed it.
	const confirmed = (event: React.KeyboardEvent): boolean => {
		if (!confirmation) {
			return false;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			confirmation.confirm();
			return true;
		}
		if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
			confirmation.cancel();
		}
		return false;
	};
	// Keys that work both while typing and on the list. Returns whether the key was handled.
	const shared = (event: React.KeyboardEvent): boolean => {
		if (
			panel === 'workspaces' &&
			event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey &&
			event.key.toLowerCase() === 's'
		) {
			// Ctrl+S puts the selected workspace to sleep; the list stays open.
			event.preventDefault();
			filtered[Math.max(0, selection)]?.sleep?.();
			return true;
		}
		if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
			event.preventDefault();
			if (['files', 'search', 'symbols'].includes(panel) && loading) {
				pendingEnter.current = query;
			} else {
				filtered[Math.max(0, selection)]?.run();
			}
			return true;
		}
		return false;
	};

	const optionId = (index: number): string => paletteOptionId(panel, index);

	return (
		<>
			<input
				ref={filter}
				className={styles.paletteInput}
				data-palette-filter
				role={panel === 'symbols' ? 'combobox' : undefined}
				aria-expanded={panel === 'symbols' ? true : undefined}
				aria-autocomplete={panel === 'symbols' ? 'list' : undefined}
				aria-controls={panel === 'symbols' ? 'symbol-results' : undefined}
				aria-activedescendant={
					panel === 'symbols' && filtered[selection] ? optionId(selection) : undefined
				}
				aria-label={panel === 'search' ? t('Search in files') : t('Filter items')}
				placeholder={placeholder(panel, t)}
				value={query}
				onChange={(event) => {
					pendingEnter.current = undefined;
					setQuery(event.target.value);
					clearTab();
					setFallbackSelection(0);
				}}
				onFocus={() => setTyping(true)}
				onBlur={() => {
					pendingEnter.current = undefined;
					setTyping(false);
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
						return;
					}
					if (confirmed(event)) {
						return;
					}
					if (isLeaveTypingKey(event)) {
						// Back to the list, keeping the filter, as when leaving Insert mode.
						event.preventDefault();
						event.stopPropagation();
						results.current?.focus();
					} else if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
						event.preventDefault();
						setSelection((n) => Math.min(n + 1, filtered.length - 1));
					} else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
						event.preventDefault();
						setSelection((n) => Math.max(0, n - 1));
					} else if (
						event.ctrlKey &&
						!event.shiftKey &&
						!event.altKey &&
						['d', 'u', 'f', 'b'].includes(event.key.toLowerCase())
					) {
						// Use the result viewport for paging while the filter has focus.
						navigateSearchList(event, filtered.length, setSelection, results.current);
					} else {
						shared(event);
					}
				}}
			/>
			{confirmation && (
				<div className={styles.paletteConfirmation} role="alert">
					<span>{confirmation.message}</span>
					<small>{t('Enter to continue · Any other key to cancel')}</small>
				</div>
			)}
			<div
				className={styles.paletteItems}
				id={panel === 'symbols' ? 'symbol-results' : undefined}
				ref={results}
				tabIndex={0}
				role={hasOptions(panel) ? 'listbox' : 'group'}
				aria-label={
					panel === 'problems'
						? t('Problems')
						: panel === 'symbols'
							? t('File symbols')
							: t('Palette results')
				}
				aria-busy={panel === 'symbols' ? loading : undefined}
				aria-keyshortcuts={
					reorderable ? `Shift+J Shift+K${panel === 'workspaces' ? ' X' : ''}` : undefined
				}
				aria-activedescendant={
					hasOptions(panel) && filtered[selection] ? optionId(selection) : undefined
				}
				onScroll={
					virtual.rows ? (event) => virtual.scrolled(event.currentTarget) : undefined
				}
				onBlur={(event) => {
					if (event.relatedTarget !== filter.current) {
						pendingEnter.current = undefined;
					}
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
						return;
					}
					if (confirmed(event) || reorderTab(event) || shared(event)) {
						return;
					}
					if (
						panel === 'workspaces' &&
						event.key === 'x' &&
						!event.ctrlKey &&
						!event.altKey &&
						!event.metaKey &&
						!event.shiftKey
					) {
						event.preventDefault();
						if (!event.repeat && !confirmation) {
							filtered[selection]?.close?.();
						}
					} else if (
						event.ctrlKey &&
						!event.altKey &&
						!event.metaKey &&
						!event.shiftKey &&
						event.key.toLowerCase() === 'c'
					) {
						// Ctrl+C closes the palette, like Escape.
						event.preventDefault();
						onClose?.();
					} else if (navigateSearchList(event, filtered.length, setSelection)) {
						return;
					} else if (isStartTypingKey(event)) {
						event.preventDefault();
						filter.current?.focus();
					}
				}}
			>
				{panel === 'symbols' && message && filtered.length > 0 && (
					<p className={styles.noResults} role="status">
						{t(message)}
					</p>
				)}
				{virtual.rows ? (
					<div
						role="presentation"
						className={styles.virtualRows}
						style={{ height: virtual.height }}
					>
						{virtual.rows.map(({ index, top }) => (
							<div
								key={index}
								role="presentation"
								data-virtual-row={index}
								style={{ top }}
							>
								<PaletteItem
									panel={panel}
									item={filtered[index]}
									index={index}
									selected={index === selection}
									total={filtered.length}
								/>
							</div>
						))}
					</div>
				) : (
					filtered.map((item, i) => (
						<PaletteItem
							key={`${item.title}-${i}`}
							panel={panel}
							item={item}
							index={i}
							selected={i === selection}
						/>
					))
				)}
				{!filtered.length && (
					<p className={styles.noResults}>
						{emptyMessage({ panel, loading, message, query }, t)}
					</p>
				)}
			</div>
			<div className={styles.paletteFooter}>
				<span>{hint({ panel, typing, count: filtered.length }, t)}</span>
				<span>{t('Enter to select · Esc to return')}</span>
			</div>
		</>
	);
}
