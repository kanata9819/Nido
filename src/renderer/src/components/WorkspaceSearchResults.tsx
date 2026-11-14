import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SearchResults } from '../../../shared/types';
import { useI18n } from '../i18n';
import styles from '../assets/WorkspaceSearch.module.css';
import { navigateSearchList as navigate } from './workspaceSearchNavigation';

/** A search match with its index in the results and the text shown for it. */
type Row = SearchResults['matches'][number] & { index: number; title: string };

/**
 * The matches of a workspace text search. Enter opens a match; / r f move to the search,
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
				if (event.key === '/') {
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
			{rows.map((row) => (
				<div
					key={`${row.path}:${row.line}`}
					id={`search-result-${row.index}`}
					role="option"
					aria-selected={row.index === selection}
					className={`${row.index === selection ? styles.selected : ''} ${replace && excluded.has(row.index) ? styles.excluded : ''}`}
					onClick={() => {
						if (locked.current) {
							return;
						}
						if (!replace) {
							open(row.index);
							return;
						}
						setSelection(row.index);
						results.current?.focus();
					}}
					onDoubleClick={() => open(row.index)}
				>
					{replace && (
						<span aria-label={t(excluded.has(row.index) ? 'Excluded' : 'Included')}>
							{excluded.has(row.index) ? '☐' : '☑'}
						</span>
					)}
					<span>
						<strong>{row.title}</strong>
						<small>{row.text}</small>
					</span>
				</div>
			))}
			{!rows.length && (
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
