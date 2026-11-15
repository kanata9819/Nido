// Values from the renderer are untrusted: each IPC handler checks the type and size of its
// arguments with these before use. Each throws an Error the renderer shows when one is invalid.
import { terminalShells, type Indentation, type TerminalShell } from '../../shared/types';
import type { DebugAction } from '../../shared/types';
import type { Session } from '../session/session';

/** A string of at most 4 million characters. */
export function text(value: unknown): string {
	if (typeof value !== 'string' || value.length > 4_000_000) {
		throw new Error('Invalid text.');
	}
	return value;
}

/** A whole number from 1 to `max`. */
export function integer(value: unknown, max = 1_000_000): number {
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
		throw new Error('Invalid number.');
	}
	return Number(value);
}

/** A boolean value; throws `message` otherwise. */
export function boolean(value: unknown, message: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(message);
	}
	return value;
}

/** The terminal shell the renderer chose, checked against the known shells. */
export function shellChoice(value: unknown = 'auto'): TerminalShell {
	if (!terminalShells.includes(value as TerminalShell)) {
		throw new Error('Invalid terminal shell.');
	}
	return value as TerminalShell;
}

const debugActions: readonly DebugAction[] = [
	'start',
	'breakpoint',
	'over',
	'into',
	'out',
	'pause',
	'stop',
	'launch',
	'variable'
];

export function debugAction(value: unknown): DebugAction {
	if (typeof value !== 'string' || !debugActions.includes(value as DebugAction)) {
		throw new Error('Invalid debug action');
	}
	return value as DebugAction;
}

/** Spaces or tabs, 1 to 16 columns wide. */
export function indentation(value: unknown): Indentation {
	const candidate = value as Partial<Indentation> | null;
	if (
		typeof candidate !== 'object' ||
		candidate === null ||
		typeof candidate.spaces !== 'boolean' ||
		!Number.isInteger(candidate.size) ||
		candidate.size! < 1 ||
		candidate.size! > 16
	) {
		throw new Error('Invalid indentation');
	}
	return { spaces: candidate.spaces, size: candidate.size! };
}

/** Scroll distances: whole rows unless `pixel`, and at most 1000 rows or columns. */
export function scrollDistance(lines: unknown, pixel: boolean, columns: unknown): void {
	if (
		typeof lines !== 'number' ||
		!Number.isFinite(lines) ||
		(!pixel && !Number.isInteger(lines)) ||
		Math.abs(lines) > 1000 ||
		typeof columns !== 'number' ||
		!Number.isInteger(columns) ||
		Math.abs(columns) > 1000
	) {
		throw new Error('Invalid scroll distance');
	}
}

/**
 * Find the Session for a workspace ID. A terminal ID resolves to that terminal's Session.
 */
export function sessionFinder(sessions: Map<string, Session>): (id: unknown) => Session {
	return (id) => {
		const found =
			typeof id === 'string'
				? sessions.get(id) ||
					[...sessions.values()].find((s) => s.terminal?.workspace.id === id)?.terminal
				: undefined;
		if (!found) {
			throw new Error('Workspace is no longer running.');
		}
		return found;
	};
}
