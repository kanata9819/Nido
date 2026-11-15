import { useEffect, useState } from 'react';
import { useErrorMessage, useI18n } from '../../i18n';
import type { GitCommitEntry } from '../../../../shared/types';

/**
 * The diff of `path` in `commit`, or a message while there is none to show. A loaded result
 * only counts for the commit and file it was loaded for.
 */
export function useCommitDiff(
	workspaceId: string,
	commit: GitCommitEntry | undefined,
	path: string | undefined
): string {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [result, setResult] = useState<{
		workspaceId: string;
		commit: GitCommitEntry;
		path: string;
		value: string;
		failed?: boolean;
	}>();
	useEffect(() => {
		let cancelled = false;
		if (!commit || !path) {
			return;
		}
		const show = (value: string, failed?: boolean): void => {
			if (!cancelled) {
				setResult({ workspaceId, commit, path, value, ...(failed ? { failed } : {}) });
			}
		};
		window.nido
			.gitCommitDiff(workspaceId, commit.hash, path)
			.then((value) => show(value || 'No textual changes.'))
			.catch((failure) => show(String(failure), true));
		return () => {
			cancelled = true;
		};
	}, [workspaceId, commit, path]);
	if (!commit || !path) {
		return t('Select a commit and press Enter to browse its changed files.');
	}
	const loaded =
		result?.workspaceId === workspaceId && result.commit === commit && result.path === path;
	if (!loaded) {
		return t('Loading diff…');
	}
	return result.failed ? errorMessage(result.value) : result.value;
}
