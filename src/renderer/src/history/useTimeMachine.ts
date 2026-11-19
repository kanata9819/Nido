import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { HistoryList, HistoryPreview } from '../../../shared/history';
import { remoteErrorText } from '../i18n';

/** A loaded preview of one version; it only counts for the list and version it is for. */
interface Preview {
	list: HistoryList;
	id: string;
	value?: HistoryPreview;
	error?: string;
}

/**
 * Time Machine's state: the versions of the current file, the selected one and its preview,
 * and restoring it. The list (`listRef`) gets focus on opening and keeps the selection in view.
 */
export function useTimeMachine({
	workspaceId,
	listRef,
	onRestored
}: {
	workspaceId: string;
	listRef: RefObject<HTMLDivElement | null>;
	/** Called after a version was restored into the editor. */
	onRestored: () => void;
}): {
	data: HistoryList | undefined;
	selected: string;
	select: (id: string) => void;
	busy: 'list' | 'restore' | null;
	error: string;
	/** The preview of the selected version, once loaded. */
	current: Preview | undefined;
	refresh: () => void;
	restore: () => Promise<void>;
} {
	const [data, setData] = useState<HistoryList>();
	const [selected, setSelected] = useState('');
	const [preview, setPreview] = useState<Preview>();
	const [busy, setBusy] = useState<'list' | 'restore' | null>('list');
	const [error, setError] = useState('');
	// False once the panel has unmounted.
	const alive = useRef(false);
	// Grows with each list request, so a late answer to an older one is ignored.
	const request = useRef(0);
	const current =
		preview && preview.list === data && preview.id === selected ? preview : undefined;

	// Load the versions of the current file.
	const requestHistory = useCallback(
		async (generation: number): Promise<void> => {
			const latest = (): boolean => alive.current && request.current === generation;
			try {
				const result = await window.nido.history(workspaceId);
				if (!latest()) {
					return;
				}
				setData(result);
				// Start on the previous draft so the first view shows an actual change.
				setSelected((old) =>
					result.versions.some((version) => version.id === old)
						? old
						: result.versions[1]?.id || result.versions[0]?.id || ''
				);
			} catch (failure) {
				if (latest()) {
					setData(undefined);
					setPreview(undefined);
					setError(remoteErrorText(failure));
				}
			} finally {
				if (latest()) {
					setBusy(null);
				}
			}
		},
		[workspaceId]
	);
	useEffect(() => {
		alive.current = true;
		listRef.current?.focus();
		void requestHistory(++request.current);
		return () => {
			alive.current = false;
		};
	}, [requestHistory, listRef]);

	// Preview the selected version shortly after the selection settles, so moving quickly
	// through the list does not request every version.
	useEffect(() => {
		if (!data || !selected) {
			return;
		}
		let cancelled = false;
		const show = (result: { value?: HistoryPreview; error?: string }): void => {
			if (!cancelled) {
				setPreview({ list: data, id: selected, ...result });
			}
		};
		const timer = window.setTimeout(
			() =>
				void window.nido.historyPreview(workspaceId, data.path, selected).then(
					(value) => show({ value }),
					(failure) => show({ error: remoteErrorText(failure) })
				),
			75
		);
		listRef.current
			?.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: 'nearest' });
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [workspaceId, data, selected, listRef]);

	const refresh = (): void => {
		setBusy('list');
		setError('');
		void requestHistory(++request.current);
	};

	/** Restore the previewed version into the editor (unsaved). */
	const restore = async (): Promise<void> => {
		const value = current?.value;
		if (busy || !value || value.identical) {
			return;
		}
		setBusy('restore');
		setError('');
		try {
			await window.nido.historyRestore(
				workspaceId,
				value.path,
				value.version.id,
				value.token
			);
			if (alive.current) {
				onRestored();
			}
		} catch (failure) {
			if (alive.current) {
				setError(remoteErrorText(failure));
			}
		} finally {
			if (alive.current) {
				setBusy(null);
			}
		}
	};

	// A failed restore was about the version selected then; choosing another one clears it.
	const select = useCallback((id: string): void => {
		setError('');
		setSelected(id);
	}, []);

	return { data, selected, select, busy, error, current, refresh, restore };
}
