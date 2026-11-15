import { useCallback } from 'react';

/**
 * Helpers to run main-process requests from event handlers. `run` reports a failure in the
 * error toast; `runThenFocus` also returns focus to the editor afterward, unless the user
 * moved it meanwhile.
 */
export function useRequests({
	report,
	captureFocus,
	focusEditor
}: {
	report: (message: string) => void;
	captureFocus: () => () => boolean;
	focusEditor: () => void;
}): {
	run: (promise: Promise<unknown>) => void;
	runThenFocus: (request: () => Promise<unknown>) => void;
} {
	const run = useCallback(
		(promise: Promise<unknown>): void => {
			void promise.catch((e) => report(String(e)));
		},
		[report]
	);
	const runThenFocus = useCallback(
		(request: () => Promise<unknown>): void => {
			const canFocus = captureFocus();
			run(
				request().then(() => {
					if (canFocus()) {
						focusEditor();
					}
				})
			);
		},
		[captureFocus, run, focusEditor]
	);
	return { run, runThenFocus };
}
