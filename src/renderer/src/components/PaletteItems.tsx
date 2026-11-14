import { useI18n } from '../i18n';
import { memo, useEffect, useRef } from 'react';
import { Command, FolderOpen, FileCode2, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import type { Panel, Item } from '../types';
import styles from '../assets/Palette.module.css';
import FileIcon from './FileIcon';

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
}

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
	// Problems and symbols are listboxes navigated with the keyboard; their rows are options
	// with ids that aria-activedescendant refers to.
	const option = panel === 'problems' || panel === 'symbols';
	return (
		<button
			id={option ? `${panel === 'problems' ? 'problem' : 'symbol'}-${index}` : undefined}
			role={option ? 'option' : undefined}
			aria-selected={option ? selected : undefined}
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
				<small>{item.detail}</small>
			</span>
			{item.status && (
				<span className={styles.workspaceStatus} data-status={item.status}>
					{item.status === 'current' ? t('Current') : t('Sleeping')}
				</span>
			)}
			{item.key && <kbd>{item.key}</kbd>}
		</button>
	);
});

/**
 * A palette's filter field and results. Enter runs the selected item; while results are
 * still loading, Enter is remembered and runs the first result for that query once loaded.
 */
export default function PaletteItems({
	panel,
	filtered,
	selection,
	query,
	loading,
	message,
	setQuery,
	setSelection,
	confirmation
}: PaletteItemsProps): React.JSX.Element {
	const t = useI18n();
	const results = useRef<HTMLDivElement>(null);
	const filter = useRef<HTMLInputElement>(null);
	const pendingEnter = useRef<string | undefined>(undefined);
	// Run the Enter pressed while loading, unless the query changed or focus left the field.
	useEffect(() => {
		if (!loading && pendingEnter.current === query) {
			pendingEnter.current = undefined;
			if (document.activeElement === filter.current) {
				filtered[Math.max(0, selection)]?.run();
			}
		}
	}, [loading, query, filtered, selection]);
	// The problems palette is used from its list, so focus it and keep the selection in range.
	useEffect(() => {
		if (panel === 'problems') {
			results.current?.focus();
		}
	}, [panel]);
	useEffect(() => {
		if (panel === 'problems') {
			setSelection((index) => Math.max(0, Math.min(index, filtered.length - 1)));
		}
	}, [panel, filtered.length, setSelection]);
	// Keep the selected problem in view while the list resizes.
	useEffect(() => {
		const node = results.current;
		if (panel !== 'problems' || !node) {
			return;
		}
		const observer = new ResizeObserver(() => {
			node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [panel]);

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

	return (
		<>
			<input
				ref={filter}
				autoFocus={panel !== 'problems'}
				className={styles.paletteInput}
				role={panel === 'symbols' ? 'combobox' : undefined}
				aria-expanded={panel === 'symbols' ? true : undefined}
				aria-autocomplete={panel === 'symbols' ? 'list' : undefined}
				aria-controls={panel === 'symbols' ? 'symbol-results' : undefined}
				aria-activedescendant={
					panel === 'symbols' && filtered[selection] ? `symbol-${selection}` : undefined
				}
				aria-label={panel === 'search' ? t('Search in files') : t('Filter items')}
				placeholder={placeholder()}
				value={query}
				onChange={(event) => {
					pendingEnter.current = undefined;
					setQuery(event.target.value);
					setSelection(0);
				}}
				onBlur={() => {
					pendingEnter.current = undefined;
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
						return;
					}
					// A pending confirmation takes Enter; any other key cancels it and acts as usual.
					if (confirmation) {
						if (event.key === 'Enter') {
							event.preventDefault();
							confirmation.confirm();
							return;
						}
						if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
							confirmation.cancel();
						}
					}
					if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
						event.preventDefault();
						setSelection((n) => Math.min(n + 1, filtered.length - 1));
					} else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
						event.preventDefault();
						setSelection((n) => Math.max(0, n - 1));
					} else if (
						panel === 'workspaces' &&
						event.ctrlKey &&
						!event.shiftKey &&
						!event.altKey &&
						event.key.toLowerCase() === 's'
					) {
						// Ctrl+S puts the selected workspace to sleep; the list stays open.
						event.preventDefault();
						filtered[Math.max(0, selection)]?.sleep?.();
					} else if (event.key === 'Enter') {
						event.preventDefault();
						if (['files', 'search', 'symbols'].includes(panel) && loading) {
							pendingEnter.current = query;
						} else {
							filtered[Math.max(0, selection)]?.run();
						}
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
				tabIndex={panel === 'problems' ? 0 : undefined}
				role={panel === 'problems' || panel === 'symbols' ? 'listbox' : undefined}
				aria-label={
					panel === 'problems'
						? t('Problems')
						: panel === 'symbols'
							? t('File symbols')
							: undefined
				}
				aria-busy={panel === 'symbols' ? loading : undefined}
				aria-activedescendant={
					panel === 'problems' && filtered[selection] ? `problem-${selection}` : undefined
				}
				onKeyDown={(event) => {
					if (
						panel !== 'problems' ||
						event.nativeEvent.isComposing ||
						event.ctrlKey ||
						event.altKey ||
						event.metaKey
					) {
						return;
					}
					if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
						event.preventDefault();
						const last = Math.max(0, filtered.length - 1);
						setSelection((index) => {
							if (event.key === 'Home') {
								return 0;
							}
							if (event.key === 'End') {
								return last;
							}
							const step = ['j', 'ArrowDown'].includes(event.key) ? 1 : -1;
							return Math.max(0, Math.min(last, index + step));
						});
					} else if (event.key === 'Enter') {
						event.preventDefault();
						filtered[selection]?.run();
					} else if (event.key === '/') {
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
				<span>
					{panel === 'problems'
						? t('{count} problems · j/k Select · / Filter', { count: filtered.length })
						: panel === 'workspaces'
							? t('↑ ↓ or Ctrl+j / k to navigate · Ctrl+S Sleep')
							: t('↑ ↓ or Ctrl+j / k to navigate')}
				</span>
				<span>{t('Enter to select · Esc to return')}</span>
			</div>
		</>
	);
}
