import { open, stat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { workspaceRelative as relative } from './workspacePaths';
import { gitIgnored, gitRoot } from './git';
import type { FileEntry, SearchResults } from '../shared/types';
import { defaultSearchOptions, type SearchOptions } from '../shared/search';
import { SearchMatcher } from './searchMatcher';
import { WorkspaceReplacement } from './workspaceReplacement';

export class SessionSearch {
  private searchMatcher?: SearchMatcher;
  private searchGeneration = 0;
  private searchDirectories = new Map<
    string,
    { mtime: number; checked: number; entries: FileEntry[] }
  >();

  constructor(
    private readonly root: string,
    private readonly path: (relativePath: string) => Promise<string>,
    private readonly files: (relativePath: string, checkIgnored?: boolean) => Promise<FileEntry[]>,
    private readonly replacements: WorkspaceReplacement
  ) {}

  clearDirectories(): void {
    this.searchDirectories.clear();
  }

  cancelFindFiles(): void {
    this.searchGeneration++;
    this.searchMatcher?.close();
    this.replacements.clear();
  }

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
        settings.folder.split('/').some((part) => part === '..' || part.toLowerCase() === '.git'))
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

  private async searchTextFiles(
    query: string,
    options: SearchOptions,
    matcher: SearchMatcher | undefined,
    hashes: Map<string, string>,
    generation: number
  ): Promise<SearchResults> {
    const result: SearchResults = { matches: [], truncated: false };
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
    while (directories.length) {
      if (generation !== this.searchGeneration) {
        return { matches: [], truncated: false };
      }
      const listings = await Promise.all(
        directories
          .splice(-16)
          .reverse()
          .map(async (directory) => {
            try {
              return await this.directoryEntries(directory);
            } catch (error) {
              if (
                directory &&
                ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
                  (error as NodeJS.ErrnoException).code || ''
                )
              ) {
                return [];
              }
              throw error;
            }
          })
      );
      let ignored = new Set<string>();
      if (checkIgnored) {
        ignored = await gitIgnored(
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
          );
      }
      if (generation !== this.searchGeneration) {
        return { matches: [], truncated: false };
      }
      const files: FileEntry[] = [];
      for (const entries of listings) {
        for (const entry of entries) {
          if (ignored.has(entry.path)) {
            continue;
          }
          if (entry.directory) {
            if (!['node_modules', 'dist', 'out', 'build', 'target', '.next'].includes(entry.name)) {
              directories.push(entry.path);
            }
            continue;
          }
          files.push(entry);
        }
      }
      for (let first = 0; first < files.length; first += buffers.length) {
        if (generation !== this.searchGeneration) {
          return { matches: [], truncated: false };
        }
        const matches = await Promise.all(
          files.slice(first, first + buffers.length).map(async (entry, slot) => {
            const buffer = buffers[slot];
            let text: string;
            try {
              const file = await open(await this.path(entry.path), 'r');
              try {
                const info = await file.stat();
                if (!info.isFile() || info.size >= buffer.length) {
                  return [];
                }
                let length = 0;
                while (length < buffer.length) {
                  const { bytesRead } = await file.read(
                    buffer,
                    length,
                    buffer.length - length,
                    null
                  );
                  if (!bytesRead) {
                    break;
                  }
                  length += bytesRead;
                }
                const data = buffer.subarray(0, length);
                if (length === buffer.length || data.includes(0) || !isUtf8(data)) {
                  return [];
                }
                text = data.toString('utf8').replace(/^\uFEFF/, '');
              } finally {
                await file.close();
              }
            } catch (error) {
              if (
                ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(
                  (error as NodeJS.ErrnoException).code || ''
                )
              ) {
                return [];
              }
              throw error;
            }
            if (generation !== this.searchGeneration) {
              return [];
            }
            if (matcher) {
              if (!options.regex && options.caseSensitive && !text.includes(query)) {
                return [];
              }
              const found = await matcher.find(text);
              if (found.length) {
                hashes.set(entry.path, WorkspaceReplacement.hash(text));
              }
              // Columns are UTF-8 byte offsets for Neovim, including wide characters.
              const lines = found.length ? text.split(/\r\n|\n|\r/) : [];
              return found.map((match) => ({
                path: entry.path,
                line: match.line,
                column: Buffer.byteLength(lines[match.line - 1].slice(0, match.index)) + 1,
                text: match.text
              }));
            }
            if (!text.includes(query)) {
              return [];
            }
            const found: SearchResults['matches'] = [];
            const lines = text.split(/\r\n|\n|\r/);
            for (let index = 0; index < lines.length; index++) {
              const column = lines[index].indexOf(query);
              if (column < 0) {
                continue;
              }
              found.push({
                path: entry.path,
                line: index + 1,
                column: Buffer.byteLength(lines[index].slice(0, column)) + 1,
                text: lines[index].slice(Math.max(0, column - 80), column + 220).trim()
              });
              if (found.length === 201) {
                break;
              }
            }
            return found;
          })
        );
        if (generation !== this.searchGeneration) {
          return { matches: [], truncated: false };
        }
        for (const found of matches) {
          for (const match of found) {
            if (result.matches.length === 200) {
              return { ...result, truncated: true };
            }
            result.matches.push(match);
          }
        }
      }
    }
    return generation === this.searchGeneration ? result : { matches: [], truncated: false };
  }

  async findFiles(query = ''): Promise<FileEntry[]> {
    const generation = ++this.searchGeneration;
    const needle = query.toLowerCase();
    const result: FileEntry[] = [];
    const directories = [''];
    while (directories.length && result.length < 100) {
      if (generation !== this.searchGeneration) {
        return [];
      }
      const directory = directories.pop()!;
      let entries: FileEntry[];
      try {
        entries = await this.directoryEntries(directory);
      } catch (error) {
        if (
          directory &&
          ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code || ''
          )
        ) {
          continue;
        }
        throw error;
      }
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
          if (`${entry.name} ${entry.path}`.toLowerCase().includes(needle)) {
            result.push(entry);
          }
          if (result.length >= 100) {
            break;
          }
        } else if (
          !['node_modules', 'dist', 'out', 'build', 'target', '.next'].includes(entry.name)
        ) {
          children.push(entry.path);
        }
      }
      for (let index = children.length - 1; index >= 0; index--) {
        directories.push(children[index]);
      }
    }
    return result;
  }

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
