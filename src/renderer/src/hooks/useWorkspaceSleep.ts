import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Workspace } from '../../../shared/types';

/** A background workspace sleeps after this long without being selected. */
export const sleepDelay = 5 * 60 * 1000;
const checkInterval = 30 * 1000;

/**
 * Put background workspaces to sleep after `sleepDelay`, and wake the selected one.
 * Returns the IDs whose wake failed, so the loading indicator can stop for them.
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
}): ReadonlySet<string> {
	// When each background workspace was last selected (or first seen).
	const lastSelected = useRef(new Map<string, number>());
	const sleeping = useRef(new Set<string>());
	const waking = useRef(new Set<string>());
	const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
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
			setFailed(new Set());
		}
	}

	useEffect(() => {
		if (restoring) {
			return;
		}
		const timer = window.setInterval(() => {
			const now = Date.now();
			for (const workspace of latest.current.workspaces) {
				const id = workspace.id;
				if (
					id === latest.current.active ||
					workspace.sleeping ||
					sleeping.current.has(id) ||
					now - (lastSelected.current.get(id) ?? now) < sleepDelay
				) {
					continue;
				}
				sleeping.current.add(id);
				void window.nido
					.sleepWorkspace(id)
					.then((slept) => {
						if (slept) {
							forgetEditor(id);
							setWorkspaces((old) =>
								old.map((w) => (w.id === id ? { ...w, sleeping: true } : w))
							);
						} else {
							// Busy (unsaved edits, a shell, a prompt): try again after another delay.
							lastSelected.current.set(id, Date.now());
						}
					})
					.catch(() => lastSelected.current.set(id, Date.now()))
					.finally(() => sleeping.current.delete(id));
			}
		}, checkInterval);
		return () => window.clearInterval(timer);
	}, [restoring, setWorkspaces, forgetEditor]);

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
				setWorkspaces((old) =>
					old.map((w) => (w.id === id ? { ...w, ...workspace, sleeping: false } : w))
				);
				if (errors.length) {
					report(errors.join('\n'));
				}
			})
			.catch((error) => {
				setFailed((old) => new Set([...old, id]));
				report(String(error));
			})
			.finally(() => waking.current.delete(id));
	}, [restoring, selectedSleeping, active, failed, setWorkspaces, report]);

	return failed;
}
