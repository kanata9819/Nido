import type { HistoryContent, HistorySnapshot, HistoryToken } from '../shared/history';
import type { Workspace } from '../shared/types';
import { editorPath, hostPath } from '../shared/wsl';
import type { SessionClient } from './sessionClient';
import type { SessionInteraction } from './sessionInteraction';

// Reads and restores buffer contents for Time Machine (see historyService.ts). The Lua side
// lives in resources/nido/lua/nido_history.lua.
export class SessionHistory {
	constructor(
		private readonly workspace: Workspace,
		private readonly client: SessionClient,
		private readonly interaction: SessionInteraction,
		private readonly isStopped: () => boolean
	) {}

	/**
	 * Buffers that changed since their token in `tokens` was captured. Returns nothing while
	 * Neovim waits for input (for example a pending operator), since a request could disturb it.
	 */
	async historySnapshots(tokens: HistoryToken[]): Promise<HistorySnapshot[]> {
		if (this.isStopped() || this.workspace.kind === 'terminal') {
			return [];
		}
		let result: HistorySnapshot[];
		try {
			const mode = (await this.client.request('nvim_get_mode', [])) as {
				blocking: boolean;
			};
			if (mode.blocking) {
				return [];
			}
			result = (await this.client.request('nvim_exec_lua', [
				"return require('nido_history').changed(...)",
				[tokens]
			])) as HistorySnapshot[];
		} catch (error) {
			// A workspace closed or put to sleep mid-capture has nothing left to record.
			if (this.isStopped()) {
				return [];
			}
			throw error;
		}
		return Array.isArray(result)
			? result.map((value) => ({
					...value,
					path: hostPath(this.workspace.root, value.path)
				}))
			: [];
	}

	/** The current buffer, for listing its versions. */
	historyCurrent(): Promise<HistorySnapshot> {
		return this.interaction.enqueue(async () => {
			const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
			if (mode.blocking) {
				throw new Error('Finish the current Neovim command before opening Time Machine.');
			}
			return this.historyResult("return require('nido_history').current()", []);
		});
	}

	/** A unified diff between two texts, computed by Neovim. */
	historyDiff(before: string, after: string): Promise<string> {
		return this.client.request('nvim_exec_lua', [
			"return require('nido_history').diff(...)",
			[before, after]
		]);
	}

	/**
	 * Replace the buffer's text with a stored version. `token` must still match the buffer, so
	 * edits made after the preview are not overwritten.
	 */
	historyRestore(path: string, token: string, content: HistoryContent): Promise<HistorySnapshot> {
		return this.interaction.enqueue(async () => {
			const mode = (await this.client.request('nvim_get_mode', [])) as { blocking: boolean };
			if (mode.blocking) {
				throw new Error('Finish the current Neovim command before restoring.');
			}
			return this.historyResult("return require('nido_history').restore(...)", [
				editorPath(this.workspace.root, path),
				token,
				content
			]);
		});
	}

	/** Run a nido_history call that returns a snapshot or `{ error }`, and convert its path. */
	private async historyResult(code: string, args: unknown[]): Promise<HistorySnapshot> {
		const result = (await this.client.request('nvim_exec_lua', [code, args])) as
			HistorySnapshot | { error: string };
		if ('error' in result) {
			throw new Error(result.error);
		}
		return { ...result, path: hostPath(this.workspace.root, result.path) };
	}
}
