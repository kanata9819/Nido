import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { open } from 'node:fs/promises';
import type { NeovimClient } from 'neovim';
import type { SearchMatch } from '../shared/types';
import type { ReplacementPreview, ReplacementResult, SearchOptions } from '../shared/search';
import { editorPath } from '../shared/wsl';
import { SearchMatcher } from './searchMatcher';

const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const stale = 'Search results changed. Search again.';

interface ReplacementFile {
	path: string;
	original: string;
	changed: string;
	hash: string;
	count: number;
}

function context(text: string, selected: number[]): string {
	const lines = text.split(/\r\n|\n|\r/);
	const rows = new Set<number>();
	for (const line of selected) {
		for (let row = Math.max(0, line - 3); row < Math.min(lines.length, line + 2); row++) {
			rows.add(row);
		}
	}
	let previous = -1;
	return [...rows]
		.sort((a, b) => a - b)
		.map((row) => {
			const gap = row > previous + 1 ? '…\n' : '';
			previous = row;
			return `${gap}${row + 1}  ${lines[row]}`;
		})
		.join('\n');
}

/** The search that a replacement applies to, with each matched file's content hash. */
interface SearchSnapshot {
	token: string;
	query: string;
	options: SearchOptions;
	matches: SearchMatch[];
	hashes: Map<string, string>;
}

function checkReplacement(replacement: string, selected: number[], matches: SearchMatch[]): void {
	if (
		typeof replacement !== 'string' ||
		replacement.length > 1000 ||
		/[\r\n\0]/.test(replacement)
	) {
		throw new Error('Enter a single-line replacement up to 1,000 characters.');
	}
	if (
		!Array.isArray(selected) ||
		!selected.length ||
		selected.length > 200 ||
		selected.some((index) => !Number.isInteger(index) || !matches[index])
	) {
		throw new Error('Choose matching lines to replace.');
	}
}

/** The selected match lines, grouped by file. */
function linesByFile(selected: number[], matches: SearchMatch[]): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (const index of new Set(selected)) {
		const { path, line } = matches[index];
		const lines = groups.get(path) || [];
		lines.push(line);
		groups.set(path, lines);
	}
	return groups;
}

export class WorkspaceReplacement {
	private snapshot?: SearchSnapshot;
	private preview?: { token: string; files: ReplacementFile[] };
	private generation = 0;
	private matcher?: SearchMatcher;

	constructor(
		private root: string,
		private client: NeovimClient,
		private path: (path: string) => Promise<string>
	) {}

	clear(): void {
		this.generation++;
		this.snapshot = undefined;
		this.preview = undefined;
		this.matcher?.close();
		this.matcher = undefined;
	}

	complete(
		query: string,
		options: SearchOptions,
		matches: SearchMatch[],
		hashes: Map<string, string>
	): string {
		const token = randomUUID();
		this.snapshot = { token, query, options, matches, hashes };
		return token;
	}

	static hash(text: string): string {
		return digest(text);
	}

	private async read(path: string): Promise<{ text: string; hash: string }> {
		const file = await open(await this.path(path), 'r');
		try {
			const bytes = Buffer.alloc(1024 * 1024 + 1);
			let size = 0;
			while (size < bytes.length) {
				const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
				if (!bytesRead) {
					break;
				}
				size += bytesRead;
			}
			const data = bytes.subarray(0, size);
			if (size === bytes.length || data.includes(0) || !isUtf8(data)) {
				throw new Error(stale);
			}
			return { text: data.toString('utf8').replace(/^\uFEFF/, ''), hash: digest(data) };
		} finally {
			await file.close();
		}
	}

	/**
	 * Replace the selected matches in memory and show the result in the open buffers without
	 * saving. Returns a preview whose token apply() accepts.
	 */
	async prepare(
		token: string,
		replacement: string,
		selected: number[]
	): Promise<ReplacementPreview> {
		const snapshot = this.snapshot;
		if (!snapshot || snapshot.token !== token) {
			throw new Error(stale);
		}
		checkReplacement(replacement, selected, snapshot.matches);
		const generation = ++this.generation;
		this.preview = undefined;
		this.matcher?.close();
		const matcher = new SearchMatcher(snapshot.query, snapshot.options);
		this.matcher = matcher;
		try {
			const { files, previews } = await this.replaceInFiles(
				linesByFile(selected, snapshot.matches),
				matcher,
				replacement,
				snapshot.hashes
			);
			if (generation !== this.generation) {
				throw new Error(stale);
			}
			await this.edit(files, false);
			if (generation !== this.generation) {
				throw new Error(stale);
			}
			const previewToken = randomUUID();
			this.preview = { token: previewToken, files };
			return {
				token: previewToken,
				count: files.reduce((count, file) => count + file.count, 0),
				files: previews
			};
		} finally {
			matcher.close();
			if (this.matcher === matcher) {
				this.matcher = undefined;
			}
		}
	}

	/**
	 * Apply the replacement to each file's current text. Files that changed since the search
	 * make the whole replacement stale; files left unchanged are omitted.
	 */
	private async replaceInFiles(
		groups: Map<string, number[]>,
		matcher: SearchMatcher,
		replacement: string,
		hashes: Map<string, string>
	): Promise<{ files: ReplacementFile[]; previews: ReplacementPreview['files'] }> {
		const files: ReplacementFile[] = [];
		const previews: ReplacementPreview['files'] = [];
		let bytes = 0;
		for (const [path, lines] of groups) {
			const original = await this.read(path);
			if (digest(original.text) !== hashes.get(path)) {
				throw new Error(stale);
			}
			const changed = await matcher.replace(original.text, lines, replacement);
			bytes += Buffer.byteLength(original.text) + Buffer.byteLength(changed.text);
			if (bytes > 8 * 1024 * 1024) {
				throw new Error('Replacement preview is too large. Narrow the search.');
			}
			if (changed.text === original.text) {
				continue;
			}
			files.push({
				path,
				original: original.text,
				changed: changed.text,
				hash: original.hash,
				count: changed.count
			});
			previews.push({
				path,
				count: changed.count,
				before: context(original.text, lines),
				after: context(changed.text, lines)
			});
		}
		return { files, previews };
	}

	async apply(token: string): Promise<ReplacementResult> {
		const preview = this.preview;
		if (!preview || preview.token !== token) {
			throw new Error(stale);
		}
		// Consume once, before yielding: duplicate key presses cannot apply twice.
		this.preview = undefined;
		const generation = this.generation;
		for (const file of preview.files) {
			if ((await this.read(file.path)).hash !== file.hash) {
				throw new Error(stale);
			}
		}
		if (generation !== this.generation) {
			throw new Error(stale);
		}
		await this.edit(preview.files, true);
		return {
			files: preview.files.length,
			count: preview.files.reduce((count, file) => count + file.count, 0)
		};
	}

	private async edit(files: ReplacementFile[], apply: boolean): Promise<void> {
		await this.client
			.request('nvim_exec_lua', [
				`local files, apply = ...
local api = vim.api
local edits = {}
-- Check every target before editing any buffer. Do not switch the active file,
-- write to disk, or overwrite an existing unsaved buffer.
for _, item in ipairs(files) do
  local buf = require('nido_buffers').find(item.path)
  if apply and (buf < 0 or not api.nvim_buf_is_loaded(buf)) then
    buf = vim.fn.bufadd(item.path)
    vim.fn.bufload(buf)
  end
end
for _, item in ipairs(files) do
  local buf = require('nido_buffers').find(item.path)
  if buf > 0 and api.nvim_buf_is_loaded(buf) then
    local bo = vim.bo[buf]
    assert(not bo.modified, 'Save unsaved target files before replacing.')
    -- A file changed on disk while open in a background tab is reloaded only when its
    -- tab is selected. Read it now; otherwise it never matches what was searched.
    vim.cmd.checktime(buf)
    assert(bo.modifiable and not bo.readonly and bo.buftype == '', 'Target file is read-only.')
    local ending = bo.fileformat == 'dos' and '\\r\\n' or bo.fileformat == 'mac' and '\\r' or '\\n'
    local originalLines = api.nvim_buf_get_lines(buf, 0, -1, false)
    local empty = #originalLines == 1 and originalLines[1] == '' and item.original == ''
    local hasEnding = bo.endofline and not empty
    local current = table.concat(originalLines, ending) .. (hasEnding and ending or '')
    assert(current == item.original, 'Search results changed. Search again.')
    if apply then
      local lines = vim.split(item.changed, ending, {plain=true})
      if hasEnding then table.remove(lines) end
      if #lines == 0 then lines = {''} end
      table.insert(edits, {buf=buf, lines=lines, hasEnding=hasEnding})
    end
  end
end
for _, edit in ipairs(edits) do
  vim.bo[edit.buf].buflisted = true
  vim.bo[edit.buf].endofline = edit.hasEnding
  vim.bo[edit.buf].fixendofline = false
  api.nvim_buf_set_lines(edit.buf, 0, -1, false, edit.lines)
end`,
				[
					files.map((file) => ({
						path: editorPath(this.root, this.root + '/' + file.path),
						original: file.original,
						changed: file.changed
					})),
					apply
				]
			])
			.catch((error: unknown) => {
				for (const message of [
					stale,
					'Save unsaved target files before replacing.',
					'Target file is read-only.'
				]) {
					if (String(error).includes(message)) {
						throw new Error(message);
					}
				}
				throw error;
			});
	}
}
