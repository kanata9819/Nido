import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { defaultSearchOptions } from '../../../shared/search';
import { useI18n } from '../i18n';
import styles from '../assets/WorkspaceSearch.module.css';
import { useFocusGuard } from '../hooks/useFocusGuard';
import { useWorkspaceSearch } from '../hooks/useWorkspaceSearch';
import { navigateSearchList as navigate } from './workspaceSearchNavigation';
import ReplacementPreviewPanel from './ReplacementPreviewPanel';
import WorkspaceSearchResults from './WorkspaceSearchResults';

export default function WorkspaceSearch({
	workspaceId,
	onClose
}: {
	workspaceId: string;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const captureFocus = useFocusGuard(workspaceId);
	const [query, setQuery] = useState('');
	const [replacement, setReplacement] = useState('');
	const [replace, setReplace] = useState(false);
	const [options, setOptions] = useState(defaultSearchOptions);
	const queryInput = useRef<HTMLInputElement>(null);
	const replaceInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLDivElement>(null);
	const files = useRef<HTMLDivElement>(null);
	const diff = useRef<HTMLDivElement>(null);
	const applyButton = useRef<HTMLButtonElement>(null);
	const pendingEnter = useRef<string | undefined>(undefined);
	const focusTarget = useRef<'results' | 'files' | 'replace' | undefined>(undefined);
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
	} = useWorkspaceSearch({ workspaceId, query, options, replacement, focus });
	useLayoutEffect(() => {
		const target = focusTarget.current;
		const element =
			target === 'files'
				? files.current
				: target === 'replace'
					? replaceInput.current
					: target === 'results'
						? results.current
						: undefined;
		if (element && !busy) {
			element.focus();
			focusTarget.current = undefined;
		}
	});

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

	useEffect(() => {
		const list = preview ? files.current : results.current;
		list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selection, preview, file]);

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
	const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) {
			return;
		}
		const key = event.key.toLowerCase();
		if (event.key === 'Escape') {
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
			changeOption(
				({ c: 'caseSensitive', w: 'wholeWord', r: 'regex' } as const)[
					key as 'c' | 'w' | 'r'
				]
			);
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
				<label>
					{t('Search in files')}
					<input
						ref={queryInput}
						autoFocus
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
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.keyCode === 229) {
								return;
							}
							if (event.ctrlKey && ['j', 'k'].includes(event.key)) {
								navigate(event, rows.length, setSelection);
							} else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
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
						}}
					/>
				</label>
				<label>
					{t('Search folder')}
					<input
						ref={folderInput}
						value={options.folder}
						disabled={busy}
						placeholder={t('Entire workspace (for example: src)')}
						onChange={(event) => {
							searchChanged();
							setOptions((options) => ({ ...options, folder: event.target.value }));
						}}
					/>
				</label>
				<div className={styles.options}>
					{(
						[
							['caseSensitive', 'Match case', 'Alt+C'],
							['wholeWord', 'Whole word', 'Alt+W'],
							['regex', 'Regular expression', 'Alt+R']
						] as const
					).map(([key, label, shortcut]) => (
						<button
							key={key}
							disabled={busy}
							aria-pressed={options[key]}
							onClick={() => changeOption(key)}
						>
							{t(label)} <kbd>{shortcut}</kbd>
						</button>
					))}
					<button
						disabled={busy}
						aria-pressed={replace}
						onClick={() => {
							invalidate();
							setReplace(!replace);
							if (!replace) {
								focus('replace');
							}
						}}
					>
						{t('Replace')}
					</button>
				</div>
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
					<div className={styles.actions}>
						<button
							disabled={
								busy || loading || !result.token || excluded.size === rows.length
							}
							onClick={() => void prepare()}
						>
							{t('Preview replacement')} <kbd>Ctrl+Enter</kbd>
						</button>
						{preview && (
							<button
								ref={applyButton}
								disabled={busy || !preview.count}
								onClick={() => void apply()}
							>
								{t('Apply replacement')} <kbd>Enter</kbd>
							</button>
						)}
					</div>
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
			<div className={styles.footer} role="status">
				{notice ||
					(busy
						? t('Working…')
						: preview
							? t('{count} replacements in {files} files · Review before applying', {
									count: preview.count,
									files: preview.files.length
								})
							: result.truncated
								? t('Showing the first 200 matching lines.')
								: t('{count} matching lines', { count: rows.length }))}
			</div>
			<div className={styles.footer}>
				{preview
					? t('j/k Files · Enter/l Diff · h Back · Ctrl+Enter Focus apply · Esc Back')
					: t(
							'Esc Results/close · j/k Move · / Search · r Replace · f Folder · Space Include · a All · Ctrl+Enter Preview'
						)}
			</div>
			<div className={styles.footer}>
				{t(
					'Saved UTF-8 files up to 1 MiB · Git ignores respected · Replacements stay unsaved'
				)}
			</div>
		</div>
	);
}
