import { stat } from 'node:fs/promises';
import type { SavedWorkspace, Workspace } from '../shared/types';
import { editorPath, hostPath } from '../shared/wsl';
import { untitledRecoveryLimitMessage } from '../shared/recovery';
import type { SessionClient } from './sessionClient';
import type { SessionInteraction } from './sessionInteraction';

/**
 * Saves and restores what a workspace has open (files, cursors and unsaved untitled buffers),
 * for workspace checkpoints, sleeping workspaces and the next launch.
 */
export class SessionPersistence {
	/**
	 * The lines last read from each untitled draft, by recovery ID, with the buffer's
	 * changedtick. Checkpoints run every few seconds; a draft that has not changed since
	 * is not read and sent again, which for a large draft paused the editor each time.
	 */
	private drafts = new Map<string, { tick: number; lines: string[] }>();

	constructor(
		private readonly workspace: Workspace,
		private readonly client: SessionClient,
		private readonly interaction: SessionInteraction,
		private readonly hasTerminal: () => boolean
	) {}

	/**
	 * Read the open files and untitled drafts from Neovim. `restoreScroll` first returns a window
	 * scrolled away from its cursor; `includeUntitled` false leaves the drafts out.
	 */
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
			`local include_untitled, recovery_scope, known = ...
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
          local tick = vim.api.nvim_buf_get_changedtick(b)
          table.insert(untitled, {id=id, index=#files + #untitled + 1, tick=tick,
            lines=known[id] ~= tick and vim.api.nvim_buf_get_lines(b, 0, -1, false) or nil,
            endOfLine=vim.bo[b].endofline, fileformat=vim.bo[b].fileformat,
            line=math.max(1,pos[1]), column=pos[2]})
          if b == vim.api.nvim_get_current_buf() then current_untitled = #untitled - 1 end
        end
      end
      local result = {files=files, current=vim.api.nvim_buf_get_name(0)}
      if #untitled > 0 then result.untitled = untitled end
      if current_untitled then result.currentUntitled = current_untitled end
      return result`,
			[
				options.includeUntitled !== false,
				this.workspace.id,
				// Drafts whose lines are already held, with their changedtick.
				Object.fromEntries([...this.drafts].map(([id, { tick }]) => [id, tick]))
			]
		])) as Omit<SavedWorkspace, 'root' | 'untitled'> & {
			untitled?: (Omit<NonNullable<SavedWorkspace['untitled']>[number], 'lines'> & {
				id: string;
				tick: number;
				lines?: string[];
			})[];
		};
		// Drafts that did not change come back without lines; reuse the lines read last time.
		const { untitled: drafts, ...rest } = data;
		if (drafts?.some(({ id, lines }) => !lines && !this.drafts.has(id))) {
			// A concurrent snapshot forgot a draft that this one found unchanged: read all.
			this.drafts.clear();
			return this.snapshot({ ...options, restoreScroll: false });
		}
		const untitled = drafts?.map(({ tick, lines, ...draft }) => {
			const known = lines ?? this.drafts.get(draft.id)!.lines;
			this.drafts.set(draft.id, { tick, lines: known });
			return { ...draft, lines: known };
		});
		if (options.includeUntitled !== false) {
			// Forget drafts that were saved, discarded or closed.
			const current = new Set(untitled?.map(({ id }) => id));
			for (const id of this.drafts.keys()) {
				if (!current.has(id)) {
					this.drafts.delete(id);
				}
			}
		}
		return {
			root: this.workspace.root,
			terminal: this.hasTerminal(),
			...rest,
			...(untitled ? { untitled } : {}),
			current: hostPath(this.workspace.root, data.current),
			files: Array.isArray(data.files)
				? data.files.map((file) => ({
						...file,
						path: hostPath(this.workspace.root, file.path)
					}))
				: []
		};
	}

	/** Reopen saved files and drafts. Returns an error message for each file that failed to open. */
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
					// A draft's index is its tab position among files and drafts. Files that failed to open
					// left no tab, so drafts move up by the number of failed files before them.
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
		// The current buffer was a draft, already selected above; otherwise select the current file.
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
