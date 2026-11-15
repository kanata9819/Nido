import { useI18n } from '../i18n';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Command, FolderOpen, FileCode2, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import type { Panel, Item } from '../types';
import styles from '../assets/Palette.module.css';
import FileIcon from './FileIcon';
import { commandKeys } from '../paletteShortcuts';
import {
	isLeaveTypingKey,
	isStartTypingKey,
	navigateSearchList
} from './workspaceSearchNavigation';

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

/** Whether a palette's rows are listbox options (Problems and symbols). */
const hasOptions = (panel: Exclude<Panel, null>): boolean =>
	panel === 'problems' || panel === 'symbols';

/** The id of a Problems or symbols row, which aria-activedescendant refers to. */
const paletteOptionId = (panel: Exclude<Panel, null>, index: number): string =>
	`${panel === 'problems' ? 'problem' : 'symbol'}-${index}`;

/** The icon of an item in palettes that have no file to show an icon for. */
function itemIcon(panel: Exclude<Panel, null>, severity: number | undefined): React.JSX.Element {
	switch (panel) {
		case 'problems':
			switch (severity) {
				case 1:
					return <CircleAlert size={18} />;
				case 2:
					return <TriangleAlert size={18} />;
				default:
					return <Info size={18} />;
			}
		case 'workspaces':
			return <FolderOpen size={18} />;
		case 'symbols':
		case 'search':
			return <FileCode2 size={18} />;
		default:
			return <Command size={17} />;
	}
}

/** One row of a palette. */
const PaletteItem = memo(function PaletteItem({
	panel,
	item,
	index,
	selected
}: {
	panel: Exclude<Panel, null>;
	item: Item;
	index: number;
	selected: boolean;
}): React.JSX.Element {
	const t = useI18n();
	// Problems and symbols are listboxes; their rows are options with ids that
	// aria-activedescendant refers to. Rows are not tab stops: the list itself has focus.
	const option = hasOptions(panel);
	// Commands show their shortcuts as keys beside them; other rows show their key as is.
	const { text: detail, keys } =
		panel === 'commands'
			? commandKeys(item.detail, item.key)
			: { text: item.detail, keys: item.key ? [item.key] : [] };
	return (
		<button
			id={option ? paletteOptionId(panel, index) : undefined}
			role={option ? 'option' : undefined}
			aria-selected={option ? selected : undefined}
			tabIndex={-1}
			data-severity={item.severity}
			className={selected ? styles.selectedItem : ''}
			data-workspace-status={item.status}
			title={item.status === 'current' ? t('Current workspace · Cannot sleep') : undefined}
			ref={(node) => {
				if (node && selected) {
					node.scrollIntoView({ block: 'nearest' });
				}
			}}
			onClick={item.run}
		>
			<span className={styles.itemIcon}>
				{panel === 'files' || panel === 'buffers' ? (
					<FileIcon path={item.detail} />
				) : (
					itemIcon(panel, item.severity)
				)}
			</span>
			<span>
				<strong>{item.title}</strong>
				{detail && <small>{detail}</small>}
			</span>
			{item.status && (
				<span className={styles.workspaceStatus} data-status={item.status}>
					{item.status === 'current' ? t('Current') : t('Sleeping')}
				</span>
			)}
			{keys.length > 0 && (
				<span className={styles.itemKeys}>
					{keys.map((key) => (
						<kbd key={key}>{key}</kbd>
					))}
				</span>
			)}
		</button>
	);
});

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
	const pendingMove = useRef<{
		source: string | number;
		target: string | number;
		offset: number;
	}>(undefined);
	const [selectedTab, setSelectedTab] = useState<string | number>();
	const selectedIndex =
		selectedTab === undefined ? -1 : filtered.findIndex((item) => item.tab?.id === selectedTab);
	const selection = selectedIndex < 0 ? fallbackSelection : selectedIndex;
	const reorderable = panel === 'workspaces' || panel === 'buffers';
	const setSelection: PaletteItemsProps['setSelection'] = (value) => {
		if (reorderable) {
			const index = typeof value === 'function' ? value(selection) : value;
			setSelectedTab(filtered[index]?.tab?.id);
			setFallbackSelection(index);
		} else {
			setFallbackSelection(value);
		}
	};
	// Whether the filter field has focus: typing, rather than moving through the list.
	const [typing, setTyping] = useState(false);
	useLayoutEffect(() => {
		const move = pendingMove.current;
		if (move) {
			const source = filtered.findIndex((item) => item.tab?.id === move.source);
			const target = filtered.findIndex((item) => item.tab?.id === move.target);
			if (source < 0 || target < 0 || (target - source) * move.offset < 0) {
				pendingMove.current = undefined;
			}
		}
	}, [filtered]);
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

	const reorderTab = (event: React.KeyboardEvent): boolean => {
		if (
			!reorderable ||
			!event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			(event.key !== 'J' && event.key !== 'K')
		) {
			return false;
		}
		event.preventDefault();
		const offset = event.key === 'K' ? -1 : 1;
		const tab = filtered[selection]?.tab;
		const target = filtered[selection + offset]?.tab;
		if (tab && target && !pendingMove.current) {
			// Buffer order is published asynchronously. Wait for it before targeting another row.
			const move = { source: tab.id, target: target.id, offset };
			pendingMove.current = move;
			setSelectedTab(tab.id);
			void tab.moveTo(target.id)?.catch(() => {
				if (pendingMove.current === move) {
					pendingMove.current = undefined;
				}
			});
		}
		return true;
	};

	const placeholder = (): string => {
		switch (panel) {
			case 'files':
				return t('Type a filename…');
			case 'symbols':
				return t('Type a symbol name…');
			case 'search':
				return t('Type text to grep…');
			default:
				return t('Type to search…');
		}
	};
	// Shown instead of the list when nothing matches: progress, an error, or a hint.
	const emptyMessage = (): string => {
		if (loading) {
			return panel === 'symbols' ? t('Loading symbols…') : t('Looking through your project…');
		}
		if (message) {
			return t(message);
		}
		if (panel === 'search') {
			return query ? t('No matching lines.') : t('Enter text to search this workspace.');
		}
		return panel === 'problems' && !query
			? t('No problems reported.')
			: t('No matching items.');
	};
	// The help for the list (Normal mode) and for typing in the filter field.
	const hint = (): string => {
		if (typing) {
			return t('Typing · ↑ ↓ Move · Esc / Ctrl+C Back to the list');
		}
		if (panel === 'problems') {
			return t('{count} problems · j/k Select · i / Filter', { count: filtered.length });
		}
		if (panel === 'workspaces') {
			return t('j/k Select · Shift+J/K Reorder · i / Filter · Ctrl+S Sleep');
		}
		return reorderable
			? t('j/k Select · Shift+J/K Reorder · i / Filter')
			: t('j/k Move · i / Filter');
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
				placeholder={placeholder()}
				value={query}
				onChange={(event) => {
					pendingEnter.current = undefined;
					setQuery(event.target.value);
					setSelectedTab(undefined);
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
				aria-keyshortcuts={reorderable ? 'Shift+J Shift+K' : undefined}
				aria-activedescendant={
					hasOptions(panel) && filtered[selection] ? optionId(selection) : undefined
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
				{filtered.map((item, i) => (
					<PaletteItem
						key={`${item.title}-${i}`}
						panel={panel}
						item={item}
						index={i}
						selected={i === selection}
					/>
				))}
				{!filtered.length && <p className={styles.noResults}>{emptyMessage()}</p>}
			</div>
			<div className={styles.paletteFooter}>
				<span>{hint()}</span>
				<span>{t('Enter to select · Esc to return')}</span>
			</div>
		</>
	);
}
