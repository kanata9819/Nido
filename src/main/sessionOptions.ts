import type { Workspace } from '../shared/types';
import type { SessionClient } from './sessionClient';

// Editor option toggles that are applied to every editor window in Neovim.
export class SessionOptions {
	constructor(
		private readonly client: SessionClient,
		private readonly workspace: Workspace
	) {}

	async setClipboardSharing(enabled: boolean): Promise<void> {
		await this.client.request('nvim_set_option_value', [
			'clipboard',
			enabled ? 'unnamedplus' : '',
			{}
		]);
	}

	async setRelativeLineNumbers(enabled: boolean): Promise<void> {
		if (this.workspace.kind === 'terminal') {
			return;
		}
		await this.client.request('nvim_exec_lua', [
			`local enabled = ...
vim.go.relativenumber = enabled
for _, win in ipairs(vim.api.nvim_list_wins()) do
  if vim.api.nvim_win_get_config(win).relative == '' then
    vim.api.nvim_set_option_value('relativenumber', enabled, {win=win})
  end
end`,
			[enabled]
		]);
	}

	async setMethodSeparators(enabled: boolean): Promise<void> {
		if (this.workspace.kind === 'terminal') {
			return;
		}
		await this.client.request('nvim_exec_lua', [
			"require('nido_sticky').set_method_separators(...)",
			[enabled]
		]);
	}

	async setWordWrap(enabled: boolean): Promise<void> {
		if (this.workspace.kind === 'terminal') {
			return;
		}
		await this.client.request('nvim_exec_lua', [
			`local enabled = ...
vim.go.wrap = enabled
for _, win in ipairs(vim.api.nvim_list_wins()) do
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.api.nvim_win_get_config(win).relative == ''
      and vim.bo[buf].buftype == '' then
    vim.api.nvim_set_option_value('wrap', enabled, {win=win})
  end
end`,
			[enabled]
		]);
	}

	async setEditorConfig(enabled: boolean): Promise<void> {
		if (this.workspace.kind === 'terminal') {
			return;
		}
		await this.client.request('nvim_exec_lua', [
			"require('nido_editorconfig').set_enabled(...)",
			[enabled]
		]);
	}
}
