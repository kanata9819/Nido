import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '../../../shared/types';
import type { Panel } from '../types';
import { onNidoEvent } from '../nidoEvents';

/**
 * The files matching `query` while the file palette is open. The search runs 75 ms after the
 * query changes, and again when files change or the window gains focus.
 */
export function useFileSearch(
	panel: Panel,
	active: string,
	query: string,
	report: (message: string) => void
): { fileList: FileEntry[]; loading: boolean; reset: () => void } {
	const [fileList, setFileList] = useState<FileEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const reset = useCallback((): void => {
		setLoading(true);
		setFileList([]);
	}, []);

	useEffect(() => {
		if (panel !== 'files' || !active) {
			return;
		}
		let cancelled = false;
		let generation = 0;
		const refresh = (): void => {
			const current = ++generation;
			setLoading(true);
			window.nido
				.findFiles(active, query)
				.then((files) => {
					if (!cancelled && current === generation) {
						setFileList(files);
					}
				})
				.catch((error) => {
					if (!cancelled && current === generation) {
						report(String(error));
					}
				})
				.finally(() => {
					if (!cancelled && current === generation) {
						setLoading(false);
					}
				});
		};
		const timer = window.setTimeout(refresh, 75);
		const unsubscribe = onNidoEvent((event) => {
			if (event.type === 'filesChanged' && event.id === active) {
				refresh();
			}
		});
		window.addEventListener('focus', refresh);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			unsubscribe();
			window.removeEventListener('focus', refresh);
			void window.nido.cancelFindFiles(active).catch(() => {});
		};
	}, [panel, active, query, report]);

	return { fileList, loading, reset };
}
