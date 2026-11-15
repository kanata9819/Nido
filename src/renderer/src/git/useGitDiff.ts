import { useEffect, useState } from 'react';
import type { GitChange, GitStatus } from '../../../shared/types';
import { useErrorMessage, useI18n } from '../i18n';

/**
 * The diff text of the selected change in the Git panel. It is loaded again whenever the
 * selection or the Git status changes.
 */
export function useGitDiff(
	workspaceId: string,
	current: GitChange | undefined,
	status: GitStatus | undefined
): string {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [diffResult, setDiffResult] = useState<{
		workspaceId: string;
		change: GitChange;
		status: GitStatus | undefined;
		value: string;
		failed?: boolean;
	}>();
	// A result only counts for the change and status it was loaded for; until the new one
	// arrives, the preview says it is loading.
	const loaded =
		!!current &&
		diffResult?.workspaceId === workspaceId &&
		diffResult.change === current &&
		diffResult.status === status;
	let diff: string;
	if (!current) {
		diff = t('Select a change to preview its diff.');
	} else if (!loaded) {
		diff = t('Loading diff…');
	} else {
		diff = diffResult.failed ? errorMessage(diffResult.value) : diffResult.value;
	}
	useEffect(() => {
		let cancelled = false;
		if (current) {
			window.nido
				.gitDiff(workspaceId, current.path, current.staged)
				.then((value) => {
					if (!cancelled) {
						setDiffResult({
							workspaceId,
							change: current,
							status,
							value:
								value ||
								'No textual diff (the file may have a mode change or be empty).'
						});
					}
				})
				.catch((failure) => {
					if (!cancelled) {
						setDiffResult({
							workspaceId,
							change: current,
							status,
							value: String(failure),
							failed: true
						});
					}
				});
		}
		return () => {
			cancelled = true;
		};
	}, [workspaceId, current, status]);

	return diff;
}
