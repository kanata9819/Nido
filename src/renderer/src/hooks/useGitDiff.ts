import { useEffect, useState } from 'react';
import type { GitChange, GitStatus } from '../../../shared/types';
import { useErrorMessage, useI18n } from '../i18n';

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
	const diff = !current
		? t('Select a change to preview its diff.')
		: diffResult?.workspaceId === workspaceId &&
			  diffResult.change === current &&
			  diffResult.status === status
			? diffResult.failed
				? errorMessage(diffResult.value)
				: diffResult.value
			: t('Loading diff…');
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
