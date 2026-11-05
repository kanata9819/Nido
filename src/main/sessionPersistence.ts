import { stat } from 'node:fs/promises';
import type { SavedWorkspace, Workspace } from '../shared/types';
import { editorPath, hostPath } from '../shared/wsl';
import { untitledRecoveryLimitMessage } from '../shared/recovery';
import type { SessionClient } from './sessionClient';
import type { SessionInteraction } from './sessionInteraction';

export class SessionPersistence {
	constructor(
		private readonly workspace: Workspace,
		private readonly client: SessionClient,
		private readonly interaction: SessionInteraction,
		private readonly hasTerminal: () => boolean
	) {}

	async snapshot(
		options: { restoreScroll?: boolean; includeUntitled?: boolean } = {}
	): Promise<SavedWorkspace> {
		if (options.restoreScroll !== false) {
			await this.interaction.restoreScroll();
		}
		if (this.workspace.kind === 'terminal') {
			return { root: this.workspace.root, kind: 'terminal', files: [], current: '' };
		}
		const data = (await this.client.request('nvim_exec_lua', [
			`local include_untitled, recovery_scope = ...
      local files, untitled, current_untitled, total = {}, {}, nil, 0
      for _, b in ipairs(require('nido_buffers').list()) do
        local name = vim.api.nvim_buf_get_name(b)
        if vim.bo[b].buflisted and vim.bo[b].buftype == '' and name ~= '' then
          local pos = vim.api.nvim_buf_get_mark(b, '"')
          local wins = vim.fn.win_findbuf(b)
          if #wins > 0 then
            pos = vim.api.nvim_win_get_cursor(wins[1])
            -- Background checkpoints preserve the detached viewport and the editing anchor.
            if wins[1] == vim.api.nvim_get_current_win() then
              pos = require('nido_scroll').cursor() or pos
            end
          end
          table.insert(files, {path=name, line=math.max(1,pos[1]), column=pos[2]})
        elseif include_untitled and vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buflisted
            and vim.bo[b].buftype == '' and name == '' and vim.bo[b].modified then
          local count = vim.api.nvim_buf_line_count(b)
          local bytes = vim.api.nvim_buf_get_offset(b, count)
          total = total + bytes
          if bytes > 8 * 1024 * 1024 or total > 16 * 1024 * 1024 or #untitled >= 100 then
            error('${untitledRecoveryLimitMessage}')
          end
          local pos = vim.api.nvim_buf_get_mark(b, '"')
          local wins = vim.fn.win_findbuf(b)
          if #wins > 0 then
            pos = vim.api.nvim_win_get_cursor(wins[1])
            if wins[1] == vim.api.nvim_get_current_win() then
              pos = require('nido_scroll').cursor() or pos
            end
          end
          local id = vim.b[b].nido_recovery_id
          if not id then
            id = recovery_scope .. ':' .. b
            vim.b[b].nido_recovery_id = id
          end
          table.insert(untitled, {id=id, index=#files + #untitled + 1,
            lines=vim.api.nvim_buf_get_lines(b, 0, -1, false),
            endOfLine=vim.bo[b].endofline, fileformat=vim.bo[b].fileformat,
            line=math.max(1,pos[1]), column=pos[2]})
          if b == vim.api.nvim_get_current_buf() then current_untitled = #untitled - 1 end
        end
      end
      local result = {files=files, current=vim.api.nvim_buf_get_name(0)}
      if #untitled > 0 then result.untitled = untitled end
      if current_untitled then result.currentUntitled = current_untitled end
      return result`,
			[options.includeUntitled !== false, this.workspace.id]
		])) as Omit<SavedWorkspace, 'root'>;
		return {
			root: this.workspace.root,
			terminal: this.hasTerminal(),
			...data,
			current: hostPath(this.workspace.root, data.current),
			files: Array.isArray(data.files)
				? data.files.map((file) => ({
						...file,
						path: hostPath(this.workspace.root, file.path)
					}))
				: []
		};
	}

	async restore(saved: SavedWorkspace): Promise<string[]> {
		const errors: string[] = [];
		const failedFiles: number[] = [];
		for (const [index, file] of saved.files.entries()) {
			try {
				if (!(await stat(file.path)).isFile()) {
					throw new Error('File is unavailable.');
				}
				await this.client.request('nvim_exec_lua', [
					`local path, line, column = ...
          require('nido_eol').open(path)
          line = math.min(line, vim.api.nvim_buf_line_count(0))
          vim.api.nvim_win_set_cursor(0, {line, column})`,
					[editorPath(this.workspace.root, file.path), file.line, file.column]
				]);
			} catch (error) {
				failedFiles.push(index + 1);
				errors.push(`${file.path}: ${String(error)}`);
			}
		}
		if (saved.untitled?.length) {
			await this.client.request('nvim_exec_lua', [
				`local drafts, active = ...
        local buffers = {}
        for _, draft in ipairs(drafts) do
          local buffer = vim.api.nvim_create_buf(true, false)
          if draft.id then vim.b[buffer].nido_recovery_id = draft.id end
          vim.api.nvim_buf_set_lines(buffer, 0, -1, false, draft.lines)
          vim.bo[buffer].endofline = draft.endOfLine
          vim.bo[buffer].fileformat = draft.fileformat
          vim.bo[buffer].modified = true
          local line = math.min(draft.line, #draft.lines)
          local column = math.min(draft.column, #draft.lines[line])
          vim.api.nvim_buf_set_mark(buffer, '"', line, column, {})
          table.insert(buffers, buffer)
          if draft.index then require('nido_buffers').place(buffer, draft.index) end
        end
        if active ~= vim.NIL and active ~= nil then
          local buffer = buffers[active + 1]
          vim.api.nvim_set_current_buf(buffer)
          local draft = drafts[active + 1]
          local line = math.min(draft.line, #draft.lines)
          vim.api.nvim_win_set_cursor(0, {line, math.min(draft.column, #draft.lines[line])})
        end`,
				[
					saved.untitled.map((draft, index) => {
						const position = draft.index;
						return position === undefined
							? draft
							: {
									...draft,
									index:
										position -
										failedFiles.filter((file) => file <= position - index - 1)
											.length
								};
					}),
					saved.currentUntitled ?? null
				]
			]);
		}
		if (saved.currentUntitled !== undefined) {
			return errors;
		}
		await this.client.request('nvim_exec_lua', [
			`local b = require('nido_buffers').find(...)
      if b > 0 then
        vim.api.nvim_set_current_buf(b)
      end`,
			[editorPath(this.workspace.root, saved.current)]
		]);
		return errors;
	}
}
