import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { defaultSearchOptions } from '../../../shared/search';
import { useI18n } from '../i18n';
import styles from './WorkspaceSearch.module.css';
import { useFocusGuard } from '../app/useFocusGuard';
import { useWorkspaceSearch } from './useWorkspaceSearch';
import { isLeaveTypingKey, navigateSearchList as navigate } from './workspaceSearchNavigation';
import ReplacementPreviewPanel from './ReplacementPreviewPanel';
import WorkspaceSearchResults from './WorkspaceSearchResults';
import { ReplacementActions, SearchFooter, SearchOptionButtons } from './SearchControls';

/**
 * Each workspace's last search, so reopening the panel continues it: the query, options and
 * replacement, and the result that was selected, ready for j to go on to the next one.
 */
const lastSearches = new Map<
	string,
	{
		query: string;
		options: typeof defaultSearchOptions;
		replacement: string;
		replace: boolean;
		selection: number;
	}
>();

/** Alt+C, Alt+W and Alt+R: the option each toggles. */
const optionShortcuts = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' } as const;

/**
 * Workspace text search with replace (Ctrl+Shift+F). Search state and requests live in
 * useWorkspaceSearch; this component handles the fields, focus and keyboard.
 */
export default function WorkspaceSearch({
	workspaceId,
	onClose
}: {
	workspaceId: string;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const captureFocus = useFocusGuard(workspaceId);
	const [last] = useState(() => lastSearches.get(workspaceId));
	const [query, setQuery] = useState(last?.query ?? '');
	const [replacement, setReplacement] = useState(last?.replacement ?? '');
	const [replace, setReplace] = useState(last?.replace ?? false);
	const [options, setOptions] = useState(last?.options ?? defaultSearchOptions);
	const queryInput = useRef<HTMLInputElement>(null);
	const replaceInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLDivElement>(null);
	const files = useRef<HTMLDivElement>(null);
	const diff = useRef<HTMLDivElement>(null);
	const applyButton = useRef<HTMLButtonElement>(null);
	// An Enter pressed while results were loading, remembered for the query it was pressed for.
	const pendingEnter = useRef<string | undefined>(undefined);
	// Where to move focus after the next render, once the element exists and nothing is busy.
	// The search opens on its results, as in Vim's Normal mode; i, a or / start typing.
	const focusTarget = useRef<'results' | 'files' | 'replace' | undefined>('results');
	const focus = (target: 'results' | 'files' | 'replace'): void => {
		focusTarget.current = target;
	};
	const {
		selection,
		setSelection,
		excluded,
		setExcluded,
		loading,
		setLoading,
		busy,
		locked,
		error,
		notice,
		result,
		preview,
		setPreview,
		file,
		setFile,
		failure,
		invalidate: invalidateSearch,
		reset,
		prepare,
		apply
	} = useWorkspaceSearch({
		workspaceId,
		query,
		options,
		replacement,
		focus,
		restoreSelection: last?.selection
	});
	useEffect(() => {
		lastSearches.set(workspaceId, { query, options, replacement, replace, selection });
	}, [workspaceId, query, options, replacement, replace, selection]);
	// Move focus to the requested element after each render.
	useLayoutEffect(() => {
		const target = focusTarget.current;
		const element = target
			? { files: files.current, replace: replaceInput.current, results: results.current }[
					target
				]
			: undefined;
		if (element && !busy) {
			element.focus();
			focusTarget.current = undefined;
		}
	});

	// Open a match in the editor, and close the search unless focus moved elsewhere meanwhile.
	const open = (index: number): void => {
		const match = result.matches[index];
		if (!match) {
			return;
		}
		const canFocus = captureFocus();
		void window.nido
			.openFile(workspaceId, match.path, match.line, match.column)
			.then(() => {
				if (canFocus()) {
					onClose();
				}
			})
			.catch(failure);
	};

	// Run the Enter pressed while loading once its search completes.
	useEffect(() => {
		if (!loading && pendingEnter.current === query) {
			pendingEnter.current = undefined;
			if (document.activeElement === queryInput.current && !replace) {
				open(selection);
			}
		}
		// Opening is tied to the completed search, not unrelated focus changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loading, result]);

	// Keep the selected row in view.
	useEffect(() => {
		const list = preview ? files.current : results.current;
		list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selection, preview, file]);

	// Discard a replacement preview after the search changed, keeping focus in the panel.
	const invalidate = (): void => {
		if (
			preview &&
			[files.current, diff.current, applyButton.current].includes(
				document.activeElement as HTMLDivElement
			)
		) {
			focus('results');
		}
		invalidateSearch();
	};
	// The query, folder or an option changed: the results and preview no longer apply.
	const searchChanged = (): void => {
		invalidate();
		pendingEnter.current = undefined;
		reset();
	};
	const changeOption = (key: 'caseSensitive' | 'regex' | 'wholeWord'): void => {
		if (locked.current) {
			return;
		}
		searchChanged();
		setOptions((options) => ({ ...options, [key]: !options[key] }));
	};
	const rows = useMemo(
		() =>
			result.matches.map((match, index) => ({
				...match,
				index,
				title: `${match.path}:${match.line}:${match.column}`
			})),
		[result]
	);
	/** Move through the results from the query field; Enter opens the selected match. */
	const queryKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) {
			return;
		}
		if (
			(event.ctrlKey && ['j', 'k'].includes(event.key)) ||
			['ArrowDown', 'ArrowUp'].includes(event.key)
		) {
			navigate(event, rows.length, setSelection);
		} else if (event.key === 'Enter' && !event.ctrlKey) {
			event.preventDefault();
			if (replace) {
				results.current?.focus();
			} else if (loading) {
				pendingEnter.current = query;
			} else {
				open(selection);
			}
		}
	};
	const toggleReplace = (): void => {
		invalidate();
		setReplace(!replace);
		if (!replace) {
			focus('replace');
		}
	};
	const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) {
			return;
		}
		const key = event.key.toLowerCase();
		// Escape, or Ctrl+C when no text is selected, steps back: out of a field, then closes.
		if (isLeaveTypingKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			if (locked.current) {
				return;
			}
			if (preview) {
				setPreview(undefined);
				focus('results');
			} else if (event.target !== results.current) {
				pendingEnter.current = undefined;
				results.current?.focus();
			} else {
				onClose();
			}
			return;
		}
		if (locked.current) {
			return;
		}
		if (event.altKey && !event.ctrlKey && !event.metaKey && ['c', 'w', 'r'].includes(key)) {
			event.preventDefault();
			changeOption(optionShortcuts[key as keyof typeof optionShortcuts]);
		} else if (event.ctrlKey && event.key === 'Enter') {
			event.preventDefault();
			if (preview) {
				applyButton.current?.focus();
			} else if (replace) {
				void prepare();
			}
		}
	};

	return (
		<div
			className={styles.search}
			data-workspace-search
			onKeyDownCapture={(event) => {
				if (locked.current && event.key !== 'Tab') {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			onKeyDown={keyboard}
			aria-busy={busy || loading}
		>
			<div className={styles.fields}>
				{/* The dialog's title already says what the field is for; the label stays for
				    screen readers, and the placeholder shows the rest. */}
				<label>
					<span className={styles.hiddenLabel}>{t('Search in files')}</span>
					<input
						ref={queryInput}
						value={query}
						disabled={busy}
						placeholder={t('Type text to grep…')}
						onChange={(event) => {
							searchChanged();
							setLoading(!!event.target.value);
							setQuery(event.target.value);
						}}
						onBlur={() => {
							pendingEnter.current = undefined;
						}}
						onKeyDown={queryKeyDown}
					/>
				</label>
				<label>
					<span className={styles.hiddenLabel}>{t('Search folder')}</span>
					<input
						ref={folderInput}
						data-field="folder"
						value={options.folder}
						disabled={busy}
						placeholder={t('Entire workspace (for example: src)')}
						onChange={(event) => {
							searchChanged();
							setOptions((options) => ({ ...options, folder: event.target.value }));
						}}
					/>
				</label>
				<SearchOptionButtons
					options={options}
					replace={replace}
					busy={busy}
					changeOption={changeOption}
					toggleReplace={toggleReplace}
				/>
				{replace && (
					<label>
						{t('Replace with')}
						<input
							ref={replaceInput}
							value={replacement}
							disabled={busy}
							onChange={(event) => {
								invalidate();
								setReplacement(event.target.value);
							}}
							onKeyDown={(event) => {
								if (
									event.key === 'Enter' &&
									!event.ctrlKey &&
									!event.nativeEvent.isComposing &&
									event.keyCode !== 229
								) {
									event.preventDefault();
									results.current?.focus();
								}
							}}
						/>
					</label>
				)}
				{replace && (
					<ReplacementActions
						canPreview={
							!busy && !loading && !!result.token && excluded.size !== rows.length
						}
						preview={preview}
						busy={busy}
						applyButton={applyButton}
						prepare={() => void prepare()}
						apply={() => void apply()}
					/>
				)}
			</div>
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}
			<div className={styles.body}>
				{preview ? (
					<ReplacementPreviewPanel
						preview={preview}
						file={file}
						setFile={setFile}
						files={files}
						diff={diff}
					/>
				) : (
					<WorkspaceSearchResults
						rows={rows}
						selection={selection}
						setSelection={setSelection}
						excluded={excluded}
						setExcluded={setExcluded}
						results={results}
						queryInput={queryInput}
						replaceInput={replaceInput}
						folderInput={folderInput}
						locked={locked}
						replace={replace}
						setReplace={setReplace}
						focus={focus}
						open={open}
						loading={loading}
						query={query}
					/>
				)}
			</div>
			<SearchFooter
				notice={notice}
				busy={busy}
				preview={preview}
				truncated={result.truncated}
				count={rows.length}
				replace={replace}
			/>
		</div>
	);
}
