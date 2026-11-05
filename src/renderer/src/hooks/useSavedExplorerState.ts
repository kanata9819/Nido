import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction
} from 'react';
import { readExplorerState, writeExplorerState } from '../explorerState';

export function useSavedExplorerState(root: string): {
	expanded: Set<string>;
	setExpanded: Dispatch<SetStateAction<Set<string>>>;
	selected: string;
	setSelected: Dispatch<SetStateAction<string>>;
	initialScrollTop: number;
	rememberScroll: (top: number) => void;
} {
	const [saved] = useState(() => readExplorerState(root));
	const [expanded, setExpanded] = useState(() => new Set(saved.expanded));
	const [selected, setSelected] = useState(saved.selected);
	const latest = useRef(saved);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const save = useCallback((): void => {
		if (saveTimer.current !== undefined) {
			clearTimeout(saveTimer.current);
			saveTimer.current = undefined;
			writeExplorerState(root, latest.current);
		}
	}, [root]);
	const scheduleSave = useCallback((): void => {
		// Share one bounded write across selection, expansion and scroll bursts.
		if (saveTimer.current === undefined) {
			saveTimer.current = setTimeout(save, 150);
		}
	}, [save]);
	useEffect(() => {
		latest.current = { ...latest.current, expanded: [...expanded], selected };
		scheduleSave();
	}, [expanded, selected, scheduleSave]);
	const rememberScroll = useCallback(
		(scrollTop: number): void => {
			latest.current = { ...latest.current, scrollTop };
			scheduleSave();
		},
		[scheduleSave]
	);
	useEffect(() => {
		window.addEventListener('pagehide', save);
		window.addEventListener('beforeunload', save);
		return () => {
			window.removeEventListener('pagehide', save);
			window.removeEventListener('beforeunload', save);
			save();
		};
	}, [save]);

	return {
		expanded,
		setExpanded,
		selected,
		setSelected,
		initialScrollTop: saved.scrollTop,
		rememberScroll
	};
}
