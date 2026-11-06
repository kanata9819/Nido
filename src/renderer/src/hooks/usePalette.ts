import { useCallback, useState } from 'react';
import type { FileEntry } from '../../../shared/types';
import type { Panel } from '../types';
import { useFileSearch } from './useFileSearch';

export interface PaletteState {
	panel: Panel;
	closePanel: () => void;
	folderKind: 'editor' | 'terminal';
	showFolders: (kind: 'editor' | 'terminal') => void;
	query: string;
	setQuery: (value: string) => void;
	selection: number;
	setSelection: React.Dispatch<React.SetStateAction<number>>;
	showPanel: (value: Panel) => void;
	fileList: FileEntry[];
	loading: boolean;
}

/**
 * Owns the overlay panel (command palette, file finder, folder picker, ...) along with
 * its query, selection and file search results.
 */
export function usePalette({
	active,
	report,
	onShow,
	toggleMarkdown
}: {
	active: string;
	report: (message: string) => void;
	/** Called whenever a panel is requested, before it opens. */
	onShow: () => void;
	/** The markdown "panel" is a side preview rather than an overlay. */
	toggleMarkdown: () => void;
}): PaletteState {
	const [panel, setPanel] = useState<Panel>(null);
	const [folderKind, setFolderKind] = useState<'editor' | 'terminal'>('editor');
	const [query, setQueryState] = useState('');
	const [selection, setSelection] = useState(0);
	const {
		fileList,
		loading,
		reset: resetFileSearch
	} = useFileSearch(panel, active, query, report);

	const closePanel = useCallback(() => setPanel(null), []);
	const showPanel = useCallback(
		(value: Panel): void => {
			onShow();
			setQueryState('');
			setSelection(0);
			if (value === 'markdown') {
				setPanel(null);
				toggleMarkdown();
				return;
			}
			setPanel(value);
			if (value === 'files') {
				resetFileSearch();
			}
		},
		[onShow, toggleMarkdown, resetFileSearch]
	);
	const showFolders = useCallback((kind: 'editor' | 'terminal'): void => {
		setFolderKind(kind);
		setPanel('folders');
	}, []);
	const setQuery = useCallback(
		(value: string): void => {
			setQueryState(value);
			if (panel === 'files') {
				resetFileSearch();
			}
		},
		[panel, resetFileSearch]
	);

	return {
		panel,
		closePanel,
		folderKind,
		showFolders,
		query,
		setQuery,
		selection,
		setSelection,
		showPanel,
		fileList,
		loading
	};
}
