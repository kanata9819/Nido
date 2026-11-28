import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { FileEntry } from '../../../shared/types';
import type { Panel } from '../types';
import { onNidoEvent } from '../nidoEvents';

/**
 * The files matching `query` while the file palette is open. Coalesce query changes for one frame,
 * and refresh when files change or the window gains focus.
 */
export function useFileSearch(
	panel: Panel,
	active: string,
	query: string,
	report: (message: string) => void,
	setSelection: Dispatch<SetStateAction<number>>
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
		let latestFiles: FileEntry[] | undefined;
		const refresh = (): void => {
			window.clearTimeout(timer);
			const current = ++generation;
			setLoading(true);
			window.nido
				.findFiles(active, query)
				.then((files) => {
					if (!cancelled && current === generation) {
						const previous = latestFiles;
						latestFiles = files;
						if (previous) {
							// An unchanged query can refresh after a file is added or removed.
							// Keep the selected path even if it now appears at a different index.
							setSelection((index) => {
								const path = previous[index]?.path;
								const position = files.findIndex((file) => file.path === path);
								return position < 0
									? Math.max(0, Math.min(index, files.length - 1))
									: position;
							});
						}
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
		const timer = window.setTimeout(refresh, 16);
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
	}, [panel, active, query, report, setSelection]);

	return { fileList, loading, reset };
}
