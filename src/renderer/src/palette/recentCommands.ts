// The commands run most recently, which the command palette lists first. They are saved in
// localStorage by their untranslated title.
import type { Item } from '../types';

const storageKey = 'nido.recentCommands';
/** How many recent commands the palette lifts to the top. */
const limit = 5;

/** The ids of the most recently run commands, newest first. */
export function recentCommandIds(): string[] {
	try {
		const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '[]');
		return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

/** Remember that the command `id` ran. */
export function rememberCommand(id: string): void {
	try {
		const recent = [id, ...recentCommandIds().filter((other) => other !== id)].slice(0, limit);
		globalThis.localStorage?.setItem(storageKey, JSON.stringify(recent));
	} catch {
		// Ordering by recent use is a convenience; the command still runs.
	}
}

/**
 * The commands with the recently run ones first, newest first and marked `recent`; the rest
 * keep their order.
 */
export function byRecentUse(commands: Item[], recent: string[]): Item[] {
	const first = recent.flatMap((id) => {
		const command = commands.find((candidate) => candidate.id === id);
		return command ? [{ ...command, recent: true }] : [];
	});
	return [...first, ...commands.filter((command) => !command.id || !recent.includes(command.id))];
}
