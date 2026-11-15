import { useState } from 'react';
import { useI18n } from '../i18n';
import type { Panel } from '../types';
import type { SleepBlocker, Workspace } from '../../../shared/types';
import type { SleepResult } from '../workspace/useWorkspaceSleep';

/** Blockers that sleeping on request can clear, after the user confirms. */
const resolvableBlockers: SleepBlocker[] = ['terminal', 'modified'];

/** Why a workspace cannot sleep, for the blockers that sleeping cannot clear by itself. */
const sleepBlockerMessages: Record<SleepBlocker, string> = {
	modified: '{name} cannot sleep: it has unsaved changes. Save them first.',
	terminal: '{name} cannot sleep while its terminal runs.',
	debug: '{name} cannot sleep while Run and Debug is running. Stop it first.',
	mode: '{name} cannot sleep while it is outside Normal mode or waiting for a key. Switch to it and press Esc first.',
	unavailable: '{name} cannot sleep.'
};

/** What confirming will do before sleeping, for the blockers it clears. */
function sleepConfirmationMessage(blockers: SleepBlocker[]): string {
	if (blockers.includes('terminal') && blockers.includes('modified')) {
		return '{name}: its terminal will be closed and its unsaved changes saved before it sleeps.';
	}
	return blockers.includes('terminal')
		? '{name}: its terminal will be closed before it sleeps.'
		: '{name}: its unsaved changes will be saved before it sleeps.';
}

/** A question shown in the workspace list, answered with Enter or Esc. */
export interface Confirmation {
	message: string;
	confirm: () => void;
	cancel: () => void;
}

/**
 * Sleeping a workspace from the workspace list. When only a running terminal or unsaved files
 * keep it awake, the list asks first whether to close and save them (Enter), or to cancel
 * (Esc, or choosing another workspace). Other blockers are reported.
 */
export function useSleepConfirmation({
	workspaces,
	panel,
	sleep,
	run,
	report
}: {
	workspaces: Workspace[];
	panel: Panel;
	sleep: (id: string, resolve?: boolean) => Promise<SleepResult>;
	run: (promise: Promise<unknown>) => void;
	report: (message: string) => void;
}): { requestSleep: (id: string) => void; confirmation: Confirmation | undefined } {
	const t = useI18n();
	const [pending, setPending] = useState<{
		id: string;
		name: string;
		blockers: SleepBlocker[];
	}>();
	const requestSleep = (id: string, resolve = false): void => {
		const name = workspaces.find((w) => w.id === id)?.name ?? '';
		setPending(undefined);
		run(
			sleep(id, resolve).then((result) => {
				if (!Array.isArray(result)) {
					return;
				}
				const blocking = result.filter((blocker) => !resolvableBlockers.includes(blocker));
				if (blocking.length || resolve) {
					// Report the first thing confirming cannot clear.
					report(t(sleepBlockerMessages[blocking[0] ?? result[0]], { name }));
				} else {
					setPending({ id, name, blockers: result });
				}
			})
		);
	};
	// The question belongs to the workspace list and to a workspace that is still open.
	if (pending && (panel !== 'workspaces' || !workspaces.some((w) => w.id === pending.id))) {
		setPending(undefined);
	}
	return {
		requestSleep: (id) => requestSleep(id),
		confirmation: pending && {
			message: t(sleepConfirmationMessage(pending.blockers), { name: pending.name }),
			confirm: () => requestSleep(pending.id, true),
			cancel: () => setPending(undefined)
		}
	};
}
