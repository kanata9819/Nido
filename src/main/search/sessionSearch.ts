import { open, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { workspaceRelative as relative } from '../workspace/workspacePaths';
import { gitIgnored, gitWorkTreeRoot } from '../git/git';
import { GitIgnoreReader } from '../git/gitProcess';
import type { FileEntry, SearchResults } from '../../shared/types';
import { defaultSearchOptions, type SearchOptions } from '../../shared/search';
import { SearchMatcher } from './searchMatcher';
import { searchLineEnding } from './searchLines';
import { WorkspaceReplacement } from './workspaceReplacement';

/** Folders of dependencies and build output that text and file search never enter. */
const skippedDirectories = ['node_modules', 'dist', 'out', 'build', 'target', '.next'];
const quickOpenConcurrency = 8;
const cachedDirectories = 512;
const cachedEntries = 32_768;

type DirectoryRead = { entries: FileEntry[] } | { error: unknown };

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
	private ignoreReader?: GitIgnoreReader;
	private searchGeneration = 0;
	private readonly quickOpenReads = new Set<Promise<DirectoryRead>>();
	private searchEntryCount = 0;
	// Keep recent directory listings while rechecking their mtime on every search.
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
		this.searchDirectories = new Map();
		this.searchEntryCount = 0;
	}

	/** Cancel the running search and forget the results a replacement could refer to. */
	cancelFindFiles(): void {
		this.startSearch();
		this.searchMatcher?.close();
		this.replacements.clear();
	}

	private startSearch(): number {
		this.ignoreReader?.close();
		this.ignoreReader = undefined;
		return ++this.searchGeneration;
	}

	/**
	 * Search the text of the workspace's files (skipping ignored and build folders), up to 200
	 * matching lines. Without `options` this is a plain case-sensitive search that no replacement
	 * can refer to. With `options`, results get a token for WorkspaceReplacement.
	 */
	async searchText(query: string, options?: SearchOptions): Promise<SearchResults> {
		const generation = this.startSearch();
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
		const ignores = new GitIgnoreReader(this.root);
		this.ignoreReader = ignores;
		const hashes = new Map<string, string>();
		try {
			const result = await this.searchTextFiles(
				query,
				settings,
				matcher,
				hashes,
				generation,
				ignores
			);
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
			ignores.close();
			if (this.ignoreReader === ignores) {
				this.ignoreReader = undefined;
			}
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
		generation: number,
		ignores: GitIgnoreReader
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
		const parallelReads = 8;
		const buffers: Buffer[] = [];
		const directories = [options.folder];
		const checkIgnored = await gitWorkTreeRoot(this.root).then(
			() => true,
			() => false
		);
		if (cancelled()) {
			return { matches: [], truncated: false };
		}
		if (checkIgnored && options.folder) {
			const paths = [options.folder];
			const ignored = await ignores.check(paths);
			if (
				cancelled() ||
				(ignored ?? (await gitIgnored(this.root, paths))).has(options.folder)
			) {
				return result;
			}
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
			const ignored = checkIgnored
				? await this.ignoredEntries(listings, ignores, cancelled)
				: new Set<string>();
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
			// Allocate only the slots this search uses, and reuse them across batches.
			for (let first = 0; first < files.length; first += parallelReads) {
				if (cancelled()) {
					return { matches: [], truncated: false };
				}
				const matches = await Promise.all(
					files
						.slice(first, first + parallelReads)
						.map((entry, slot) =>
							this.searchFile(
								entry,
								(buffers[slot] ??= Buffer.allocUnsafe(1024 * 1024 + 1)),
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
	private async ignoredEntries(
		listings: FileEntry[][],
		ignores: GitIgnoreReader,
		cancelled: () => boolean
	): Promise<Set<string>> {
		const paths = listings.flat().map((entry) => entry.path);
		const ignored = await ignores.check(paths);
		if (ignored || cancelled()) {
			return ignored ?? new Set();
		}
		return (
			gitIgnored(this.root, paths)
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
		const generation = this.startSearch();
		// Windows paths use backslashes, but a query such as src/main is typed with slashes.
		const comparable = (text: string): string => text.toLowerCase().replaceAll('\\', '/');
		const needle = comparable(query);
		const result: FileEntry[] = [];
		const directories = [''];
		const pending = new Map<string, Promise<DirectoryRead>>();
		while (directories.length && result.length < 100) {
			if (generation !== this.searchGeneration) {
				return [];
			}
			// Read upcoming siblings together, but consume them in the original depth-first order.
			if (needle) {
				for (const path of directories.slice(-quickOpenConcurrency).reverse()) {
					if (pending.size === quickOpenConcurrency) {
						break;
					}
					if (!pending.has(path)) {
						pending.set(path, this.quickOpenDirectory(path, generation));
					}
				}
			}
			const path = directories.pop()!;
			const listing = await (pending.get(path) ?? this.quickOpenDirectory(path, generation));
			pending.delete(path);
			if (generation !== this.searchGeneration) {
				return [];
			}
			if ('error' in listing) {
				throw listing.error;
			}
			const children: string[] = [];
			let inspected = 0;
			for (const entry of listing.entries) {
				if (++inspected % 512 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (generation !== this.searchGeneration) {
						return [];
					}
				}
				if (!entry.directory) {
					if (!needle || comparable(`${entry.name} ${entry.path}`).includes(needle)) {
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

	/** Limit directory I/O even while reads from an obsolete query are finishing. */
	private async quickOpenDirectory(path: string, generation: number): Promise<DirectoryRead> {
		while (
			generation === this.searchGeneration &&
			this.quickOpenReads.size >= quickOpenConcurrency
		) {
			await Promise.race(this.quickOpenReads);
		}
		if (generation !== this.searchGeneration) {
			return { entries: [] };
		}
		const read = this.searchableEntries(path).then(
			(entries) => ({ entries }),
			(error: unknown) => ({ error })
		);
		this.quickOpenReads.add(read);
		const result = await read;
		this.quickOpenReads.delete(read);
		return result;
	}

	/** List a folder for searching, from the cache when it is still fresh. */
	private async directoryEntries(directory: string): Promise<FileEntry[]> {
		const cache = this.searchDirectories;
		const info = await stat(await this.path(directory));
		const cached = cache.get(directory);
		const entries =
			cached && cached.mtime === info.mtimeMs && Date.now() - cached.checked < 2000
				? cached.entries
				: await this.files(directory, false);
		// A listing started before an in-app rename must not refill the invalidated cache.
		if (cache !== this.searchDirectories) {
			return entries;
		}
		this.searchEntryCount -= cache.get(directory)?.entries.length ?? 0;
		cache.delete(directory);
		if (entries.length <= 2000) {
			cache.set(directory, {
				mtime: info.mtimeMs,
				checked: cached?.entries === entries ? cached.checked : Date.now(),
				entries
			});
			this.searchEntryCount += entries.length;
			for (const [oldPath, old] of cache) {
				if (cache.size <= cachedDirectories && this.searchEntryCount <= cachedEntries) {
					break;
				}
				this.searchEntryCount -= old.entries.length;
				cache.delete(oldPath);
			}
		}
		return entries;
	}
}
