import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction
} from 'react';
import type { SleepBlocker, Workspace } from '../../../shared/types';
import { vimKey } from '../keyboard';

/**
 * The outcome of a request to sleep a workspace: it slept, the request did not apply, or
 * what keeps it running.
 */
export type SleepResult = 'slept' | 'ignored' | SleepBlocker[];

/** A background workspace sleeps after this long without being selected. */
export const sleepDelay = 5 * 60 * 1000;
const checkInterval = 30 * 1000;

/**
 * Put background workspaces to sleep after `sleepDelay` (or on request), and wake the
 * selected one.
 * Returns why waking failed, by workspace ID, so the app can show it instead of the
 * loading indicator, and `retry` to try that workspace again.
 */
export function useWorkspaceSleep({
	workspaces,
	setWorkspaces,
	active,
	restoring,
	forgetEditor,
	report
}: {
	workspaces: Workspace[];
	setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
	active: string;
	restoring: boolean;
	/** Forget a slept editor's loaded state so waking shows the loading indicator. */
	forgetEditor: (id: string) => void;
	report: (message: string) => void;
}): {
	failed: ReadonlyMap<string, string>;
	retry: (id: string) => void;
	/** Put a background workspace to sleep now. */
	sleep: (id: string, resolve?: boolean) => Promise<SleepResult>;
} {
	// When each background workspace was last selected (or first seen).
	const lastSelected = useRef(new Map<string, number>());
	const sleeping = useRef(new Set<string>());
	const waking = useRef(new Set<string>());
	// Keys typed while the selected workspace wakes, and the workspaces that just woke.
	const pendingKeys = useRef(new Map<string, string[]>());
	const awakened = useRef(new Set<string>());
	const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map());
	const previous = useRef(active);
	const latest = useRef({ workspaces, active });
	useEffect(() => {
		latest.current = { workspaces, active };
	});

	useEffect(() => {
		const now = Date.now();
		if (previous.current && previous.current !== active) {
			lastSelected.current.set(previous.current, now);
		}
		previous.current = active;
		for (const workspace of workspaces) {
			if (!lastSelected.current.has(workspace.id)) {
				lastSelected.current.set(workspace.id, now);
			}
		}
		for (const id of lastSelected.current.keys()) {
			if (!workspaces.some((workspace) => workspace.id === id)) {
				lastSelected.current.delete(id);
			}
		}
	}, [workspaces, active]);

	// A failed wake is retried the next time the workspace is selected.
	const [failedSelection, setFailedSelection] = useState(active);
	if (failedSelection !== active) {
		setFailedSelection(active);
		if (failed.size) {
			setFailed(new Map());
		}
	}

	/**
	 * Put a background workspace to sleep. Resolves what keeps it running when it cannot
	 * sleep now (unsaved edits, a terminal, a prompt), and `ignored` for the selected
	 * workspace, a sleeping one, or one already being put to sleep. A workspace that did not
	 * sleep is tried again after another delay. With `resolve`, its terminal is closed and
	 * its files saved first.
	 */
	const sleepWorkspace = useCallback(
		async (id: string, resolve = false): Promise<SleepResult> => {
			const workspace = latest.current.workspaces.find((w) => w.id === id);
			if (
				!workspace ||
				id === latest.current.active ||
				workspace.sleeping ||
				sleeping.current.has(id)
			) {
				return 'ignored';
			}
			sleeping.current.add(id);
			try {
				// Ask to clear blockers only when the user confirmed it.
				const result = await (resolve
					? window.nido.sleepWorkspace(id, true)
					: window.nido.sleepWorkspace(id));
				if (result !== true) {
					lastSelected.current.set(id, Date.now());
					return result || 'ignored';
				}
				forgetEditor(id);
				setWorkspaces((old) =>
					old.map((w) => (w.id === id ? { ...w, sleeping: true } : w))
				);
				return 'slept';
			} catch (error) {
				lastSelected.current.set(id, Date.now());
				throw error;
			} finally {
				sleeping.current.delete(id);
			}
		},
		[setWorkspaces, forgetEditor]
	);

	// Every so often, put the workspaces not selected for `sleepDelay` to sleep.
	useEffect(() => {
		if (restoring) {
			return;
		}
		const timer = window.setInterval(() => {
			const now = Date.now();
			for (const workspace of latest.current.workspaces) {
				if (now - (lastSelected.current.get(workspace.id) ?? now) >= sleepDelay) {
					void sleepWorkspace(workspace.id).catch(() => {});
				}
			}
		}, checkInterval);
		return () => window.clearInterval(timer);
	}, [restoring, sleepWorkspace]);

	const selectedSleeping = !!workspaces.find((workspace) => workspace.id === active)?.sleeping;
	useEffect(() => {
		const id = active;
		if (restoring || !selectedSleeping || waking.current.has(id) || failed.has(id)) {
			return;
		}
		waking.current.add(id);
		void window.nido
			.wakeWorkspace(id)
			.then(({ workspace, errors }) => {
				// Typing is held only while this workspace stays selected. Remembering a wake
				// that finished in the background would send the keys of a later, unfinished
				// wake to a workspace that is not running.
				if (latest.current.active === id) {
					awakened.current.add(id);
				}
				setWorkspaces((old) =>
					old.map((w) => (w.id === id ? { ...w, ...workspace, sleeping: false } : w))
				);
				if (errors.length) {
					report(errors.join('\n'));
				}
			})
			.catch((error) => {
				// Electron prefixes the main process error with the IPC channel.
				const message = String(error).replace(
					/^Error: Error invoking remote method '[^']*': (Error: )?/,
					''
				);
				setFailed((old) => new Map(old).set(id, message));
			})
			.finally(() => waking.current.delete(id));
	}, [restoring, selectedSleeping, active, failed, setWorkspaces, report]);

	// The previous workspace's editor input keeps focus until the woken editor mounts.
	// Hold typing meanwhile and deliver it to the woken workspace, never the previous one.
	useEffect(() => {
		const id = active;
		if (restoring || !selectedSleeping) {
			return;
		}
		const pending = pendingKeys.current;
		const woken = awakened.current;
		const focused = document.activeElement;
		if (focused instanceof HTMLTextAreaElement && focused.closest('[data-editor-input]')) {
			focused.blur();
		}
		const keydown = (event: KeyboardEvent): void => {
			// Only typing aimed at nothing in particular is the editor's; keys for a focused
			// control, such as a button or the palette, stay with it.
			if (
				event.defaultPrevented ||
				event.isComposing ||
				(event.target !== document.body && event.target !== document.documentElement)
			) {
				return;
			}
			const key = vimKey(event);
			if (key) {
				event.preventDefault();
				pending.set(id, [...(pending.get(id) ?? []), key]);
			}
		};
		window.addEventListener('keydown', keydown);
		return () => {
			window.removeEventListener('keydown', keydown);
			const keys = pending.get(id);
			pending.delete(id);
			// Runs before the woken editor mounts and takes focus, so typing stays in order.
			if (woken.delete(id) && keys?.length) {
				void window.nido.input(id, keys.join('')).catch((error) => report(String(error)));
			}
		};
	}, [restoring, selectedSleeping, active, report]);

	const retry = useCallback((id: string): void => {
		setFailed((old) => {
			if (!old.has(id)) {
				return old;
			}
			const next = new Map(old);
			next.delete(id);
			return next;
		});
	}, []);

	return { failed, retry, sleep: sleepWorkspace };
}
