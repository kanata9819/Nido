import type { Indentation, MarkdownSnapshot, Workspace } from '../shared/types';
import { hostPath } from '../shared/wsl';
import type { SessionClient } from './sessionClient';
import type { SessionInteraction } from './sessionInteraction';

// Buffer-level queries and commands: switching, closing, dirty checks, line endings.
export class SessionBuffers {
	constructor(
		private readonly client: SessionClient,
		private readonly interaction: SessionInteraction,
		private readonly workspace: Workspace
	) {}

	/**
	 * The current Markdown buffer for the preview. The token is the buffer and its changedtick;
	 * when it equals `known` the text is left out, since the preview already has it.
	 */
	async markdownPreview(known = ''): Promise<MarkdownSnapshot> {
		const snapshot = (await this.client.request('nvim_exec_lua', [
			`if vim.bo.filetype ~= 'markdown' then
  error('Open a Markdown file to preview.')
end
local known = ...
local buffer = vim.api.nvim_get_current_buf()
local token = buffer .. ':' .. vim.api.nvim_buf_get_changedtick(buffer)
return {token=token, path=vim.api.nvim_buf_get_name(buffer),
  text=token ~= known and table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\\n') or nil}`,
			[known]
		])) as MarkdownSnapshot;
		return { ...snapshot, path: hostPath(this.workspace.root, snapshot.path) };
	}

	/** Convert the current file to LF or CRLF line endings. */
	async setLineEnding(format: 'LF' | 'CRLF'): Promise<void> {
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', ["require('nido_eol').convert(...)", [format]])
		);
	}

	/** Change the indentation of the current file; `rewrite` also converts existing lines. */
	async setIndentation(indentation: Indentation, rewrite = false): Promise<void> {
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', [
				"require('nido_indentation').set(...)",
				[indentation.spaces, indentation.size, rewrite]
			])
		);
	}

	/** Whether any file buffer has unsaved changes. */
	async modified(): Promise<boolean> {
		return (await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', [
				`for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
  if (vim.bo[buffer].buftype == '' or vim.bo[buffer].buftype == 'acwrite') and vim.bo[buffer].modified then
    return true
  end
end
return false`,
				[]
			])
		)) as boolean;
	}

	async selectBuffer(buffer: number): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(() => this.client.request('nvim_set_current_buf', [buffer]));
	}

	/** Close a tab; `force` discards unsaved changes. */
	async closeBuffer(buffer: number, force = false): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', [
				"require('nido_buffers').close(...)",
				[buffer, force]
			])
		);
	}

	/** Move a tab to the position of tab `target`. */
	async moveBuffer(buffer: number, target: number): Promise<void> {
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', [
				"require('nido_buffers').move(...)",
				[buffer, target]
			])
		);
	}

	/** Reopen the most recently closed tab. */
	async reopenBuffer(): Promise<void> {
		this.interaction.cancelPrefetch();
		await this.interaction.command(() =>
			this.client.request('nvim_exec_lua', ["require('nido_buffers').reopen()", []])
		);
	}

	async bufferModified(buffer: number): Promise<boolean> {
		return (await this.interaction.command(() =>
			this.client.request('nvim_get_option_value', ['modified', { buf: buffer }])
		)) as boolean;
	}
}
