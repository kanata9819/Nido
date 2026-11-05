import { useCallback, useState } from 'react';

const remoteErrorPrefix = /^Error: Error invoking remote method '[^']+': Error: /;

export interface ErrorNotice {
	notice: { message: string } | undefined;
	error: string;
	dismissError: () => void;
	report: (message: string) => void;
}

/** Owns the single app-level error notice and the IPC error normalisation. */
export function useErrorNotice(): ErrorNotice {
	const [notice, setNotice] = useState<{ message: string }>();
	const setError = useCallback(
		(message: string): void => setNotice(message ? { message } : undefined),
		[]
	);
	const dismissError = useCallback(() => setError(''), [setError]);
	const report = useCallback(
		(message: string): void => setError(message.replace(remoteErrorPrefix, '')),
		[setError]
	);
	return { notice, error: notice?.message || '', dismissError, report };
}
