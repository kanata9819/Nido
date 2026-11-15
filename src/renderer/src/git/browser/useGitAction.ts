import { useRef, useState } from 'react';

/**
 * Run one Git action at a time and keep its error. `working` is true while one runs; GitPanel
 * also sets it through `setWorking` for its own actions.
 */
export function useGitAction(): {
	run: (action: () => Promise<void>) => Promise<void>;
	working: boolean;
	setWorking: (working: boolean) => void;
	error: string;
	setError: (error: string) => void;
} {
	const [working, setWorking] = useState(false);
	const [error, setError] = useState('');
	// Set while an action runs, so a second one cannot start before React re-renders.
	const locked = useRef(false);
	async function run(action: () => Promise<void>): Promise<void> {
		if (locked.current) {
			return;
		}
		locked.current = true;
		setWorking(true);
		setError('');
		try {
			await action();
		} catch (failure) {
			setError(String(failure));
		} finally {
			locked.current = false;
			setWorking(false);
		}
	}
	return { run, working, setWorking, error, setError };
}
