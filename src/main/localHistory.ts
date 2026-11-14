import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { historyLimits, type HistoryContent, type HistoryVersion } from '../shared/history';
import { parseWslPath } from '../shared/wsl';

// The on-disk store of Time Machine. Each file with a history has one JSON file named by the
// hash of its path, holding its newest versions first.

/** A stored version together with its text. */
interface Revision extends HistoryVersion, HistoryContent {}
/** The contents of one history file. */
interface HistoryFile {
	version: 1;
	path: string;
	revisions: Revision[];
}
/** A parsed history file, with each revision's JSON kept for the next write. */
interface CachedHistory {
	size: number;
	mtimeMs: number;
	data: HistoryFile;
	encoded: Map<string, { json: string; bytes: number }>;
}

interface EncodedHistory {
	serialized: string;
	/** Bytes of `serialized`, counted while encoding. */
	bytes: number;
	encodings: CachedHistory['encoded'];
}

/** The line count of text that Time Machine can record; throws for larger or binary text. */
function checkedLineCount(content: HistoryContent): number {
	const lines = content.text.split('\n').length;
	if (
		Buffer.byteLength(content.text) > historyLimits.fileBytes ||
		lines > historyLimits.lines + 1 ||
		content.text.includes('\0')
	) {
		throw new Error('Time Machine supports text files up to 4 MiB and 100,000 lines.');
	}
	return lines;
}

// Number of parsed history files kept in memory.
const cachedFiles = 3;
// Parsed revisions and their encodings roughly double a file in memory.
const cachedBytes = 48 * 1024 * 1024;

/** The history files in one folder, with the limits from historyLimits. */
export class LocalHistory {
	// The tail of the write queue.
	private pending: Promise<unknown> = Promise.resolve();
	private ready?: Promise<void>;
	// Size and last write time of every history file, for pruning.
	private entries = new Map<string, { bytes: number; time: number }>();
	// Recently validated files, reused only while size and mtime match, so external edits and
	// damage are still detected without re-parsing large histories on every capture.
	private cache = new Map<string, CachedHistory>();

	constructor(
		private readonly directory: string,
		private readonly limits: {
			versions: number;
			historyBytes: number;
			totalBytes: number;
			files: number;
		} = historyLimits
	) {}

	/** The history file name for a path. Windows paths compare case-insensitively; WSL paths do not. */
	private key(path: string): string {
		const normalized = resolve(path).replaceAll('\\', '/');
		const remote = parseWslPath(path);
		return createHash('sha256')
			.update(
				remote
					? `wsl://${remote.distribution.toLowerCase()}${remote.path}`
					: process.platform === 'win32'
						? normalized.toLowerCase()
						: normalized
			)
			.digest('hex');
	}

	/** Create the folder and index the existing history files, once. */
	private initialize(): Promise<void> {
		this.ready ??= (async () => {
			await mkdir(this.directory, { recursive: true });
			const names = await readdir(this.directory);
			await Promise.all(
				names
					.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
					.map(async (name) => {
						const info = await stat(join(this.directory, name));
						this.entries.set(name, { bytes: info.size, time: info.mtimeMs });
					})
			);
		})().catch((error) => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	/** The history of a file, validated; an empty history when there is none yet. */
	private async read(path: string): Promise<HistoryFile> {
		await this.initialize();
		const name = `${this.key(path)}.json`;
		const file = join(this.directory, name);
		try {
			const info = await stat(file);
			if (info.size > this.limits.historyBytes) {
				throw new Error('Local history exceeds its storage limit.');
			}
			const cached = this.cache.get(name);
			if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
				this.remember(name, cached);
				return { ...cached.data, revisions: [...cached.data.revisions] };
			}
			this.cache.delete(name);
			const data = JSON.parse(await readFile(file, 'utf8')) as HistoryFile;
			if (
				!data ||
				data.version !== 1 ||
				typeof data.path !== 'string' ||
				this.key(data.path) !== this.key(path) ||
				!Array.isArray(data.revisions) ||
				data.revisions.length > this.limits.versions ||
				!data.revisions.every(
					(revision) =>
						revision &&
						typeof revision.id === 'string' &&
						/^[a-f0-9-]{36}$/.test(revision.id) &&
						Number.isSafeInteger(revision.timestamp) &&
						revision.timestamp > 0 &&
						['saved', 'draft', 'restored'].includes(revision.kind) &&
						typeof revision.text === 'string' &&
						Buffer.byteLength(revision.text) <= historyLimits.fileBytes &&
						typeof revision.endOfLine === 'boolean' &&
						['unix', 'dos', 'mac'].includes(revision.fileformat) &&
						Number.isSafeInteger(revision.bytes) &&
						revision.bytes >= 0 &&
						Number.isSafeInteger(revision.lines) &&
						revision.lines >= 1
				)
			) {
				throw new Error('Local history is damaged. Existing history was preserved.');
			}
			this.remember(name, {
				size: info.size,
				mtimeMs: info.mtimeMs,
				data,
				encoded: new Map()
			});
			return { ...data, revisions: [...data.revisions] };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.cache.delete(name);
				return { version: 1, path, revisions: [] };
			}
			throw error;
		}
	}

	/** Cache a parsed file as the most recently used, evicting the oldest beyond the limits. */
	private remember(name: string, entry: CachedHistory): void {
		this.cache.delete(name);
		this.cache.set(name, entry);
		let total = 0;
		for (const cached of this.cache.values()) {
			total += cached.size;
		}
		for (const [key, cached] of this.cache) {
			if (this.cache.size <= cachedFiles && total <= cachedBytes) {
				break;
			}
			this.cache.delete(key);
			total -= cached.size;
		}
	}

	/** The listing of revisions, without their text. */
	private versions(revisions: Revision[]): HistoryVersion[] {
		return revisions.map(({ id, timestamp, kind, bytes, lines }) => ({
			id,
			timestamp,
			kind,
			bytes,
			lines
		}));
	}

	/** The stored versions of a file, newest first. */
	async list(path: string): Promise<HistoryVersion[]> {
		await this.pending;
		return this.versions((await this.read(path)).revisions);
	}

	/** Whether a file has any stored versions. */
	async has(path: string): Promise<boolean> {
		await this.pending;
		await this.initialize();
		return this.entries.has(`${this.key(path)}.json`);
	}

	/** One stored version with its text. */
	async version(path: string, id: string): Promise<Revision> {
		await this.pending;
		const revision = (await this.read(path)).revisions.find((revision) => revision.id === id);
		if (!revision) {
			throw new Error('This history version is no longer available. Refresh Time Machine.');
		}
		return revision;
	}

	/** Store a new version of a file and return it. */
	record(
		path: string,
		content: HistoryContent,
		kind: HistoryVersion['kind']
	): Promise<HistoryVersion> {
		return this.commit(path, content, kind, (revision) => revision);
	}

	/** Store a new version of a file and return all of its versions. */
	recordAndList(
		path: string,
		content: HistoryContent,
		kind: HistoryVersion['kind']
	): Promise<HistoryVersion[]> {
		return this.commit(path, content, kind, (_revision, revisions) => this.versions(revisions));
	}

	/**
	 * Add a revision unless it matches the latest one, write the history file, and prune the
	 * oldest files beyond the storage limits. Writes are queued so they never interleave.
	 */
	private commit<T>(
		path: string,
		content: HistoryContent,
		kind: HistoryVersion['kind'],
		result: (revision: Revision, revisions: Revision[]) => T
	): Promise<T> {
		const writing = this.pending.then(async () => {
			const lines = checkedLineCount(content);
			const data = await this.read(path);
			const previous = data.revisions[0];
			if (
				previous &&
				previous.text === content.text &&
				previous.endOfLine === content.endOfLine &&
				previous.fileformat === content.fileformat
			) {
				return result(previous, data.revisions);
			}
			const revision: Revision = {
				text: content.text,
				endOfLine: content.endOfLine,
				fileformat: content.fileformat,
				id: randomUUID(),
				timestamp: Date.now(),
				kind,
				bytes: Buffer.byteLength(content.text),
				lines: Math.max(1, lines - Number(content.endOfLine))
			};
			data.revisions.unshift(revision);
			data.revisions.length = Math.min(data.revisions.length, this.limits.versions);
			const name = `${this.key(path)}.json`;
			const encoded = this.encode(name, data);
			await this.write(name, data, encoded);
			await this.prune(name);
			return result(revision, data.revisions);
		});
		this.pending = writing.catch(() => {});
		return writing;
	}

	/**
	 * Serialize the newest revisions that fit the per-file budget, dropping older ones from
	 * `data`. Each revision is encoded once; repeatedly encoding the whole history stalls the
	 * main process.
	 */
	private encode(name: string, data: HistoryFile): EncodedHistory {
		const budget = Math.min(this.limits.historyBytes, this.limits.totalBytes);
		const prefix =
			JSON.stringify({ version: data.version, path: data.path }).slice(0, -1) +
			',"revisions":[';
		let bytes = Buffer.byteLength(prefix) + 2;
		const known = this.cache.get(name)?.encoded;
		const encodings: CachedHistory['encoded'] = new Map();
		const revisions: string[] = [];
		// Count escaped JSON bytes, including UTF-8 paths and separators, before joining the result.
		for (const item of data.revisions) {
			let encoded = known?.get(item.id);
			if (!encoded) {
				const json = JSON.stringify(item);
				encoded = { json, bytes: Buffer.byteLength(json) };
			}
			const nextBytes = bytes + Number(revisions.length > 0) + encoded.bytes;
			if (nextBytes > budget) {
				if (!revisions.length) {
					throw new Error('Local history storage is full.');
				}
				break;
			}
			revisions.push(encoded.json);
			encodings.set(item.id, encoded);
			bytes = nextBytes;
		}
		data.revisions.length = revisions.length;
		return { serialized: prefix + revisions.join(',') + ']}', bytes, encodings };
	}

	/** Replace the history file and remember it in the cache and the size index. */
	private async write(name: string, data: HistoryFile, encoded: EncodedHistory): Promise<void> {
		const destination = join(this.directory, name);
		this.cache.delete(name);
		// An interrupted write leaves the previously committed history intact.
		await writeFile(`${destination}.tmp`, encoded.serialized, {
			encoding: 'utf8',
			mode: 0o600
		});
		await rename(`${destination}.tmp`, destination);
		const written = await stat(destination);
		this.remember(name, {
			size: written.size,
			mtimeMs: written.mtimeMs,
			data: { ...data, revisions: [...data.revisions] },
			encoded: encoded.encodings
		});
		this.entries.set(name, { bytes: encoded.bytes, time: Date.now() });
	}

	/** Delete the least recently written files, other than `kept`, until within the limits. */
	private async prune(kept: string): Promise<void> {
		let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
		const oldest = [...this.entries]
			.filter(([file]) => file !== kept)
			.sort((a, b) => a[1].time - b[1].time);
		for (const [file, entry] of oldest) {
			if (total <= this.limits.totalBytes && this.entries.size <= this.limits.files) {
				break;
			}
			// Only hash-named files discovered in this dedicated history directory are pruned.
			await rm(join(this.directory, file));
			this.entries.delete(file);
			this.cache.delete(file);
			total -= entry.bytes;
		}
	}
}
