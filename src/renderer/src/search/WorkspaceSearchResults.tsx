import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SearchResults } from '../../../shared/types';
import { useI18n } from '../i18n';
import { useListViewport } from '../ui/useListViewport';
import { virtualRows } from '../ui/virtualRows';
import styles from './WorkspaceSearch.module.css';
import { navigateSearchList as navigate } from './workspaceSearchNavigation';

/** A search match with its index in the results and the text shown for it. */
type Row = SearchResults['matches'][number] & { index: number; title: string };

const rowHeight = 52;
const overscan = 8;

/**
 * The matches of a workspace text search. Enter opens a match; i a / r f move to the search,
 * replace and folder fields. While replacing, Space excludes a match and a toggles them all.
 */
export default function WorkspaceSearchResults({
	rows,
	selection,
	setSelection,
	excluded,
	setExcluded,
	results,
	queryInput,
	replaceInput,
	folderInput,
	locked,
	replace,
	setReplace,
	focus,
	open,
	loading,
	query
}: {
	rows: Row[];
	selection: number;
	setSelection: Dispatch<SetStateAction<number>>;
	excluded: Set<number>;
	setExcluded: Dispatch<SetStateAction<Set<number>>>;
	results: RefObject<HTMLDivElement | null>;
	queryInput: RefObject<HTMLInputElement | null>;
	replaceInput: RefObject<HTMLInputElement | null>;
	folderInput: RefObject<HTMLInputElement | null>;
	locked: RefObject<boolean>;
	replace: boolean;
	setReplace: Dispatch<SetStateAction<boolean>>;
	focus: (target: 'results' | 'files' | 'replace') => void;
	open: (index: number) => void;
	loading: boolean;
	query: string;
}): React.JSX.Element {
	const t = useI18n();
	const { viewport, scrolled } = useListViewport(results, true, rowHeight, {
		top: 0,
		height: 300
	});
	const indices = virtualRows(viewport, rows.length, rowHeight, overscan, {
		selected: selection
	});
	// Include or exclude a match from the replacement.
	const toggle = (index: number): void =>
		setExcluded((old) => {
			const next = new Set(old);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	return (
		<div
			ref={results}
			className={styles.list}
			tabIndex={0}
			role="listbox"
			aria-label={t('Search results')}
			aria-activedescendant={rows[selection] ? `search-result-${selection}` : undefined}
			onScroll={(event) => scrolled(event.currentTarget)}
			onKeyDown={(event) => {
				if (
					event.nativeEvent.isComposing ||
					event.keyCode === 229 ||
					navigate(event, rows.length, setSelection)
				) {
					return;
				}
				if (event.ctrlKey || event.altKey || event.metaKey) {
					return;
				}
				// i, a (except while replacing, where it toggles all) and / start typing the search.
				if (['/', 'i'].includes(event.key) || (!replace && event.key === 'a')) {
					event.preventDefault();
					queryInput.current?.focus();
				} else if (event.key === 'r') {
					event.preventDefault();
					if (replaceInput.current) {
						replaceInput.current.focus();
					} else {
						setReplace(true);
						focus('replace');
					}
				} else if (event.key === 'f') {
					event.preventDefault();
					folderInput.current?.focus();
				} else if (replace && event.key === ' ') {
					event.preventDefault();
					toggle(selection);
				} else if (replace && event.key === 'a') {
					event.preventDefault();
					setExcluded((old) =>
						old.size ? new Set() : new Set(rows.map((row) => row.index))
					);
				} else if (event.key === 'Enter') {
					event.preventDefault();
					open(selection);
				}
			}}
		>
			{rows.length ? (
				<div
					role="presentation"
					className={styles.resultRows}
					style={{ height: rows.length * rowHeight }}
				>
					{indices.map((index) => {
						const row = rows[index];
						return (
							<div
								key={`${row.path}:${row.line}`}
								id={`search-result-${row.index}`}
								role="option"
								aria-selected={row.index === selection}
								aria-posinset={index + 1}
								aria-setsize={rows.length}
								style={{ top: index * rowHeight, height: rowHeight }}
								className={`${row.index === selection ? styles.selected : ''} ${replace && excluded.has(row.index) ? styles.excluded : ''}`}
								onClick={(event) => {
									if (locked.current) {
										return;
									}
									if (!replace) {
										if (event.detail <= 1) {
											open(row.index);
										}
										return;
									}
									setSelection(row.index);
									results.current?.focus();
								}}
								onDoubleClick={() => {
									if (replace && !locked.current) {
										open(row.index);
									}
								}}
							>
								{replace && (
									<button
										type="button"
										role="checkbox"
										tabIndex={-1}
										aria-checked={!excluded.has(row.index)}
										className={styles.include}
										aria-label={t(
											excluded.has(row.index) ? 'Excluded' : 'Included'
										)}
										onClick={(event) => {
											event.stopPropagation();
											if (!locked.current) {
												toggle(row.index);
												setSelection(row.index);
												results.current?.focus();
											}
										}}
										onDoubleClick={(event) => event.stopPropagation()}
									>
										{excluded.has(row.index) ? '☐' : '☑'}
									</button>
								)}
								<span>
									<strong title={row.title}>{row.title}</strong>
									<small>{row.text}</small>
								</span>
							</div>
						);
					})}
				</div>
			) : (
				<p>
					{loading
						? t('Looking through your project…')
						: query
							? t('No matching lines.')
							: t('Enter text to search this workspace.')}
				</p>
			)}
		</div>
	);
}
