import { open, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { workspaceRelative as relative } from './workspacePaths';
import { gitIgnored, gitRoot } from './git';
import type { FileEntry, SearchResults } from '../shared/types';
import { defaultSearchOptions, type SearchOptions } from '../shared/search';
import { SearchMatcher } from './searchMatcher';
import { searchLineEnding } from './searchLines';
import { WorkspaceReplacement } from './workspaceReplacement';

/** Folders of dependencies and build output that text and file search never enter. */
const skippedDirectories = ['node_modules', 'dist', 'out', 'build', 'target', '.next'];

/** Whether a file system error has one of `codes`, such as ENOENT. */
function hasErrorCode(error: unknown, ...codes: string[]): boolean {
	return codes.includes((error as NodeJS.ErrnoException).code || '');
}

/**
 * Read a UTF-8 text file into `buffer`. Returns undefined for files that are missing, locked,
 * too large for the buffer, binary (contain NUL) or not valid UTF-8. Resolving the path counts
 * as reading, so a file that disappears meanwhile is skipped.
 */
async function readTextFile(
	path: () => Promise<string>,
	buffer: Buffer
): Promise<string | undefined> {
	try {
		const file = await open(await path(), 'r');
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size >= buffer.length) {
				return undefined;
			}
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
				if (!bytesRead) {
					break;
				}
				length += bytesRead;
			}
			const data = buffer.subarray(0, length);
			if (length === buffer.length || data.includes(0) || !isUtf8(data)) {
				return undefined;
			}
			return data.toString('utf8').replace(/^\uFEFF/, '');
		} finally {
			await file.close();
		}
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY')) {
			return undefined;
		}
		throw error;
	}
}

/**
 * Plain case-sensitive search, used by the quick search without options. Returns the first
 * match on each line, up to 201 lines so the caller can tell that results were truncated.
 */
function literalMatches(path: string, text: string, query: string): SearchResults['matches'] {
	if (!text.includes(query)) {
		return [];
	}
	const found: SearchResults['matches'] = [];
	const lines = text.split(searchLineEnding(text));
	for (let index = 0; index < lines.length; index++) {
		const column = lines[index].indexOf(query);
		if (column < 0) {
			continue;
		}
		found.push({
			path,
			line: index + 1,
			// Columns are UTF-8 byte offsets for Neovim, including wide characters.
			column: Buffer.byteLength(lines[index].slice(0, column)) + 1,
			text: lines[index].slice(Math.max(0, column - 80), column + 220).trim()
		});
		if (found.length === 201) {
			break;
		}
	}
	return found;
}

/**
 * Workspace text search and file search (the quick open list). A new search cancels the one
 * running; `searchGeneration` tells a cancelled search to stop and return nothing.
 */
export class SessionSearch {
	private searchMatcher?: SearchMatcher;
	private searchGeneration = 0;
	// Recently listed folders, reused for up to 2 seconds while their mtime is unchanged, so
	// typing a file search query does not list the whole workspace again for every key.
	private searchDirectories = new Map<
		string,
		{ mtime: number; checked: number; entries: FileEntry[] }
	>();

	constructor(
		private readonly root: string,
		private readonly path: (relativePath: string) => Promise<string>,
		private readonly files: (
			relativePath: string,
			checkIgnored?: boolean
		) => Promise<FileEntry[]>,
		private readonly replacements: WorkspaceReplacement
	) {}

	/** Forget cached folder listings, after files were created, moved or deleted. */
	clearDirectories(): void {
		this.searchDirectories.clear();
	}

	/** Cancel the running search and forget the results a replacement could refer to. */
	cancelFindFiles(): void {
		this.searchGeneration++;
		this.searchMatcher?.close();
		this.replacements.clear();
	}

	/**
	 * Search the text of the workspace's files (skipping ignored and build folders), up to 200
	 * matching lines. Without `options` this is a plain case-sensitive search that no replacement
	 * can refer to. With `options`, results get a token for WorkspaceReplacement.
	 */
	async searchText(query: string, options?: SearchOptions): Promise<SearchResults> {
		const generation = ++this.searchGeneration;
		this.searchMatcher?.close();
		this.replacements.clear();
		if (query.length > 1000 || /[\r\n]/.test(query)) {
			throw new Error('Enter a single-line search up to 1,000 characters.');
		}
		const settings = { ...defaultSearchOptions, ...options };
		if (
			(['caseSensitive', 'regex', 'wholeWord'] as const).some(
				(key) => typeof settings[key] !== 'boolean'
			) ||
			typeof settings.folder !== 'string' ||
			settings.folder.length > 1000
		) {
			throw new Error('Invalid search options.');
		}
		settings.folder = settings.folder
			.trim()
			.replaceAll('\\', '/')
			.replace(/^\.\//, '')
			.replace(/\/$/, '');
		if (
			settings.folder &&
			(isAbsolute(settings.folder) ||
				settings.folder
					.split('/')
					.some((part) => part === '..' || part.toLowerCase() === '.git'))
		) {
			throw new Error('Choose a search folder inside this workspace, outside .git.');
		}
		if (settings.folder) {
			const folder = await this.path(settings.folder);
			const canonical = relative(this.root, folder).replaceAll('\\', '/');
			if (
				!(await stat(folder)).isDirectory() ||
				canonical.split('/').some((part) => part.toLowerCase() === '.git')
			) {
				throw new Error('Choose a search folder inside this workspace, outside .git.');
			}
			settings.folder = canonical;
		}
		if (generation !== this.searchGeneration) {
			return { matches: [], truncated: false };
		}
		const matcher = options ? new SearchMatcher(query, settings) : undefined;
		this.searchMatcher = matcher;
		const hashes = new Map<string, string>();
		try {
			const result = await this.searchTextFiles(query, settings, matcher, hashes, generation);
			if (generation !== this.searchGeneration) {
				return { matches: [], truncated: false };
			}
			return options && query
				? {
						...result,
						token: this.replacements.complete(query, settings, result.matches, hashes)
					}
				: result;
		} catch (error) {
			if (generation !== this.searchGeneration) {
				return { matches: [], truncated: false };
			}
			throw error;
		} finally {
			matcher?.close();
			if (this.searchMatcher === matcher) {
				this.searchMatcher = undefined;
			}
		}
	}

	/** Walk the folders and search their files. */
	private async searchTextFiles(
		query: string,
		options: SearchOptions,
		matcher: SearchMatcher | undefined,
		hashes: Map<string, string>,
		generation: number
	): Promise<SearchResults> {
		const result: SearchResults = { matches: [], truncated: false };
		const cancelled = (): boolean => generation !== this.searchGeneration;
		if (!query) {
			return result;
		}
		if (query.length > 1000 || /[\r\n]/.test(query)) {
			throw new Error('Enter a single-line search up to 1,000 characters.');
		}
		// shortcut: search saved UTF-8 files up to 1 MiB and return 200 lines; use a search index for larger projects.
		const buffers = Array.from({ length: 8 }, () => Buffer.allocUnsafe(1024 * 1024 + 1));
		const directories = [options.folder];
		const checkIgnored = await gitRoot(this.root).then(
			() => true,
			() => false
		);
		if (
			checkIgnored &&
			options.folder &&
			(await gitIgnored(this.root, [options.folder])).has(options.folder)
		) {
			return result;
		}
		// Walk the folder breadth-first, up to 16 directories at a time.
		while (directories.length) {
			if (cancelled()) {
				return { matches: [], truncated: false };
			}
			const listings = await Promise.all(
				directories
					.splice(-16)
					.reverse()
					.map((directory) => this.searchableEntries(directory))
			);
			const ignored = checkIgnored ? await this.ignoredEntries(listings) : new Set<string>();
			if (cancelled()) {
				return { matches: [], truncated: false };
			}
			const files: FileEntry[] = [];
			for (const entry of listings.flat()) {
				if (ignored.has(entry.path)) {
					continue;
				}
				if (!entry.directory) {
					files.push(entry);
				} else if (!skippedDirectories.includes(entry.name)) {
					directories.push(entry.path);
				}
			}
			// Read one file per buffer at a time.
			for (let first = 0; first < files.length; first += buffers.length) {
				if (cancelled()) {
					return { matches: [], truncated: false };
				}
				const matches = await Promise.all(
					files
						.slice(first, first + buffers.length)
						.map((entry, slot) =>
							this.searchFile(
								entry,
								buffers[slot],
								query,
								options,
								matcher,
								hashes,
								cancelled
							)
						)
				);
				if (cancelled()) {
					return { matches: [], truncated: false };
				}
				for (const match of matches.flat()) {
					if (result.matches.length === 200) {
						return { ...result, truncated: true };
					}
					result.matches.push(match);
				}
			}
		}
		return cancelled() ? { matches: [], truncated: false } : result;
	}

	/** List a directory to search. A subfolder that disappears or cannot be read is skipped. */
	private async searchableEntries(directory: string): Promise<FileEntry[]> {
		try {
			return await this.directoryEntries(directory);
		} catch (error) {
			if (directory && hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM')) {
				return [];
			}
			throw error;
		}
	}

	/** Paths that Git ignores among the listed entries. */
	private ignoredEntries(listings: FileEntry[][]): Promise<Set<string>> {
		return (
			gitIgnored(
				this.root,
				listings.flat().map((entry) => entry.path)
			)
				// A submodule can reject one group; keep unrelated groups' ignore rules.
				.catch(
					async () =>
						new Set(
							(
								await Promise.all(
									listings.map((entries) =>
										gitIgnored(
											this.root,
											entries.map((entry) => entry.path)
										).catch(() => new Set<string>())
									)
								)
							).flatMap((paths) => [...paths])
						)
				)
		);
	}

	/** Search one file, using `buffer` to read it. Unreadable and non-text files have no matches. */
	private async searchFile(
		entry: FileEntry,
		buffer: Buffer,
		query: string,
		options: SearchOptions,
		matcher: SearchMatcher | undefined,
		hashes: Map<string, string>,
		cancelled: () => boolean
	): Promise<SearchResults['matches']> {
		const text = await readTextFile(() => this.path(entry.path), buffer);
		if (text === undefined || cancelled()) {
			return [];
		}
		if (!matcher) {
			return literalMatches(entry.path, text, query);
		}
		if (!options.regex && options.caseSensitive && !text.includes(query)) {
			return [];
		}
		const found = await matcher.find(text);
		if (found.length) {
			hashes.set(entry.path, WorkspaceReplacement.hash(text));
		}
		return found.map((match) => ({
			path: entry.path,
			line: match.line,
			column: match.column,
			text: match.text
		}));
	}

	/** Up to 100 files whose name or path contains `query`, ignoring case. */
	async findFiles(query = ''): Promise<FileEntry[]> {
		const generation = ++this.searchGeneration;
		// Windows paths use backslashes, but a query such as src/main is typed with slashes.
		const comparable = (text: string): string => text.toLowerCase().replaceAll('\\', '/');
		const needle = comparable(query);
		const result: FileEntry[] = [];
		const directories = [''];
		while (directories.length && result.length < 100) {
			if (generation !== this.searchGeneration) {
				return [];
			}
			const entries = await this.searchableEntries(directories.pop()!);
			if (generation !== this.searchGeneration) {
				return [];
			}
			const children: string[] = [];
			let inspected = 0;
			for (const entry of entries) {
				if (++inspected % 512 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (generation !== this.searchGeneration) {
						return [];
					}
				}
				if (!entry.directory) {
					if (comparable(`${entry.name} ${entry.path}`).includes(needle)) {
						result.push(entry);
					}
					if (result.length >= 100) {
						break;
					}
				} else if (!skippedDirectories.includes(entry.name)) {
					children.push(entry.path);
				}
			}
			for (let index = children.length - 1; index >= 0; index--) {
				directories.push(children[index]);
			}
		}
		return result;
	}

	/** List a folder for searching, from the cache when it is still fresh. */
	private async directoryEntries(directory: string): Promise<FileEntry[]> {
		const info = await stat(await this.path(directory));
		const cached = this.searchDirectories.get(directory);
		const entries =
			cached && cached.mtime === info.mtimeMs && Date.now() - cached.checked < 2000
				? cached.entries
				: await this.files(directory, false);
		this.searchDirectories.delete(directory);
		// shortcut: retain at most 64 small directories; use an index for larger workspaces.
		if (entries.length <= 2000) {
			if (this.searchDirectories.size >= 64) {
				this.searchDirectories.delete(this.searchDirectories.keys().next().value!);
			}
			this.searchDirectories.set(directory, {
				mtime: info.mtimeMs,
				checked: cached?.entries === entries ? cached.checked : Date.now(),
				entries
			});
		}
		return entries;
	}
}
