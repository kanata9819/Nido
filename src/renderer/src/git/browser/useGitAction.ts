import { useRef, useState } from 'react';

/**
 * Run one Git action at a time and keep its error. `working` is true while one runs; GitPanel
 * also sets it through `setWorking` for its own actions. `run` resolves to whether the action
 * ran and succeeded, so a caller can stop after a failure.
 */
export function useGitAction(): {
	run: (action: () => Promise<void>) => Promise<boolean>;
	working: boolean;
	setWorking: (working: boolean) => void;
	error: string;
	setError: (error: string) => void;
} {
	const [working, setWorking] = useState(false);
	const [error, setError] = useState('');
	// Set while an action runs, so a second one cannot start before React re-renders.
	const locked = useRef(false);
	async function run(action: () => Promise<void>): Promise<boolean> {
		if (locked.current) {
			return false;
		}
		locked.current = true;
		setWorking(true);
		setError('');
		try {
			await action();
			return true;
		} catch (failure) {
			setError(String(failure));
			return false;
		} finally {
			locked.current = false;
			setWorking(false);
		}
	}
	return { run, working, setWorking, error, setError };
}
