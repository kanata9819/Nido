import type { ReferencePreview, Workspace } from '../shared/types';
import { editorPath } from '../shared/wsl';
import type { SessionClient } from './sessionClient';
import type { SessionEvents } from './sessionEvents';
import type { SessionInteraction } from './sessionInteraction';

// Jumping to results from the references, symbols and problems panels.
export class SessionNavigation {
	constructor(
		private readonly client: SessionClient,
		private readonly interaction: SessionInteraction,
		private readonly events: SessionEvents,
		private readonly workspace: Workspace
	) {}

	// Requests carry the list's version; Lua refuses an index into a list that has since changed.
	async openReference(index: number, version: number): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(async () => {
			await this.interaction.restoreScroll();
			await this.client.request('nvim_exec_lua', [
				"require('nido_references').open(...)",
				[index, version]
			]);
		});
	}

	/** Request the current buffer's symbols. Returns the request's version. */
	async findSymbols(): Promise<number> {
		return this.client.request('nvim_exec_lua', ["return require('nido_symbols').find()", []]);
	}

	async openSymbol(index: number, version: number): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', [
				"require('nido_symbols').open(...)",
				[index, version]
			])
		);
	}

	/** Jump to a diagnostic from the Problems panel and center it in the window. */
	async openProblem(index: number, version: number): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(async () => {
			const problem = this.events.state.problems?.[index - 1];
			if (!problem || version !== this.events.state.diagnosticsVersion) {
				throw new Error('Problems have changed. Select the item again.');
			}
			await this.interaction.restoreScroll();
			await this.client.request('nvim_exec_lua', [
				`local path, line, column = ...
vim.cmd("normal! m'")
require('nido_eol').open(path)
line = math.min(line, vim.api.nvim_buf_line_count(0))
local text = vim.api.nvim_buf_get_lines(0, line-1, line, false)[1] or ''
vim.api.nvim_win_set_cursor(0, {line, math.min(column-1, #text)})
vim.cmd('normal! zv')
require('nido_scroll').center()`,
				[editorPath(this.workspace.root, problem.path), problem.line, problem.column]
			]);
		});
	}

	/** Highlighted lines around a reference, for the preview beside the references list. */
	async previewReference(index: number, version: number): Promise<ReferencePreview> {
		return this.client.request('nvim_exec_lua', [
			"return require('nido_references').preview(...)",
			[index, version]
		]);
	}

	/**
	 * Syntax-highlight two versions of a file's text (for diffs) with the highlighting of the
	 * filetype `path` would have.
	 */
	async highlightSources(
		path: string,
		before: string,
		after: string
	): Promise<ReferencePreview['lines'][]> {
		// Large previews remain readable without monopolizing Neovim's input thread.
		if (before.length + after.length > 128000) {
			return [[], []];
		}
		return this.client.request('nvim_exec_lua', [
			`local path, before, after = ...
local language = vim.filetype.match({filename=path})
local function highlight(source)
  if source == '' then
    return {}
  end
  return require('nido_references').highlight_text(vim.split(source, '\\n', {plain=true}), language)
end
return {highlight(before), highlight(after)}`,
			[editorPath(this.workspace.root, path), before, after]
		]);
	}
}
