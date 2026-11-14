import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Watches the folders expanded in the explorer and reports which ones need listing again.
// Native file system notifications are used where they work; elsewhere (UNC and WSL paths, or
// when a watcher fails) folders are polled and compared by their stamp.

/** What polling compares to detect a change: the folder's and its .gitignore's file stats. */
interface DirectoryStamp {
	listing: string;
	ignore?: string;
}

/** A watched folder. `path` is relative to the workspace root; '' is the root itself. */
interface Directory {
	path: string;
	initialized: boolean;
	polling: boolean;
	stamp?: DirectoryStamp;
	watcher?: FSWatcher;
}

/** Run `action` for every item, at most `limit` at a time. */
async function forEachConcurrently<T>(
	items: T[],
	action: (item: T) => Promise<void>,
	limit = 4
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				await action(items[next++]);
			}
		})
	);
}

/**
 * On Windows one recursive watcher on the root covers every expanded folder. Elsewhere each
 * folder gets its own watcher. Changes are batched and reported to `changed` every 250 ms.
 */
export class DirectoryWatcher {
	private readonly directories = new Map<string, Directory>();
	private readonly dirty = new Set<string>();
	private pending = Promise.resolve();
	private batch?: ReturnType<typeof setTimeout>;
	private poll?: ReturnType<typeof setTimeout>;
	private polling = false;
	private stopped = false;
	private readonly recursive = process.platform === 'win32';

	constructor(
		private readonly resolveDirectory: (path: string) => Promise<string>,
		private readonly changed: (paths: string[]) => void,
		private readonly usePolling = false
	) {}

	/** Watch exactly `paths`, starting and stopping watchers as needed. */
	set(paths: string[]): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}
		// One native Windows handle avoids locking ancestors of watched subdirectories.
		const wanted = new Set(paths.length && this.recursive ? ['', ...paths] : paths);
		for (const [path, directory] of this.directories) {
			if (!wanted.has(path)) {
				directory.watcher?.close();
				this.directories.delete(path);
				this.dirty.delete(path);
			}
		}
		for (const path of wanted) {
			if (!this.directories.has(path)) {
				this.directories.set(path, { path, initialized: false, polling: false });
			}
		}
		if (![...this.directories.values()].some(({ polling }) => polling)) {
			clearTimeout(this.poll);
			this.poll = undefined;
		}
		if ([...this.directories.values()].some(({ initialized }) => !initialized)) {
			this.pending = this.pending.then(() => this.prepare());
		}
		return this.pending;
	}

	/** Resolves once every watcher, including ones requested while waiting, has started. */
	async ready(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pending;
			await pending;
		} while (pending !== this.pending);
	}

	/** Stop every watcher and timer. */
	close(): void {
		this.stopped = true;
		clearTimeout(this.batch);
		clearTimeout(this.poll);
		for (const directory of this.directories.values()) {
			directory.watcher?.close();
		}
		this.directories.clear();
		this.dirty.clear();
	}

	/** Whether `directory` is still watched, so results for a removed folder are dropped. */
	private current(directory: Directory): boolean {
		return !this.stopped && this.directories.get(directory.path) === directory;
	}

	/** Start watching (or polling) the folders that are not watched yet. */
	private async prepare(): Promise<void> {
		const directories = [...this.directories.values()].filter(
			({ initialized }) => !initialized
		);
		await forEachConcurrently(directories, async (directory) => {
			if (!this.current(directory)) {
				return;
			}
			directory.initialized = true;
			if (this.recursive && !this.usePolling && directory.path) {
				if (this.directories.get('')?.polling) {
					directory.polling = true;
					directory.stamp = await this.stamp(directory.path);
				}
				this.queue(directory.path);
				return;
			}
			try {
				const path = await this.resolveDirectory(directory.path);
				if (!this.current(directory)) {
					return;
				}
				if (this.usePolling) {
					directory.polling = true;
					directory.stamp = await this.stamp(directory.path);
				} else {
					directory.watcher = watch(
						path,
						{ persistent: false, recursive: this.recursive },
						(event, filename) =>
							this.recursive
								? this.notifyRecursive(directory, event, filename)
								: this.notify(directory, event, filename)
					);
					directory.watcher.on('error', () => {
						if (!this.current(directory)) {
							return;
						}
						this.fallback(directory);
					});
				}
			} catch {
				if (!this.current(directory)) {
					return;
				}
				this.fallback(directory);
				directory.stamp = await this.stamp(directory.path);
			}
			if (this.current(directory)) {
				// Reconcile changes between the preceding listing and watcher attachment.
				this.queue(directory.path);
			}
		});
		this.schedulePoll();
	}

	/** Switch a folder (or, for the recursive root, every folder) from watching to polling. */
	private fallback(directory: Directory): void {
		const affected =
			this.recursive && directory.path === '' ? this.directories.values() : [directory];
		for (const current of affected) {
			current.watcher?.close();
			current.watcher = undefined;
			current.polling = true;
			this.queue(current.path);
		}
		this.schedulePoll();
	}

	/** Handle an event from the recursive root watcher; `filename` is relative to the root. */
	private notifyRecursive(root: Directory, event: string, filename: string | null): void {
		if (!this.current(root)) {
			return;
		}
		if (filename === null) {
			this.queueAll();
			return;
		}
		const parent = dirname(filename);
		const directory = this.directories.get(parent === '.' ? '' : parent);
		if (!directory) {
			return;
		}
		const name = basename(filename);
		if (name === '.gitignore' || name === '.git') {
			this.queueAll();
		} else if (event !== 'rename') {
			return;
		}
		this.queue(directory.path);
		if (event === 'rename' && this.directories.has(filename)) {
			for (const path of this.directories.keys()) {
				if (path === filename || path.startsWith(`${filename}\\`)) {
					this.queue(path);
				}
			}
		}
	}

	/** Handle an event from a single folder's watcher; `filename` is relative to that folder. */
	private notify(directory: Directory, event: string, filename: string | null): void {
		if (!this.current(directory)) {
			return;
		}
		if (filename === '.gitignore' || filename === '.git' || filename === null) {
			this.queueAll();
		} else if (event !== 'rename') {
			// Editing file contents does not change the Explorer's directory listing.
			return;
		}
		if (event === 'rename') {
			const child = filename === null ? undefined : join(directory.path, filename);
			let reattach = false;
			if (child === undefined || this.directories.has(child)) {
				for (const [path, watched] of this.directories) {
					if (
						watched.initialized &&
						path !== directory.path &&
						(child === undefined ||
							path === child ||
							path.startsWith(`${child}/`) ||
							path.startsWith(`${child}\\`))
					) {
						// A recreated directory may have the same name but a different inode.
						watched.watcher?.close();
						this.directories.set(path, { path, initialized: false, polling: false });
						this.queue(path);
						reattach = true;
					}
				}
			}
			if (reattach) {
				this.pending = this.pending.then(() => this.prepare());
			}
		}
		this.queue(directory.path);
	}

	/** Refresh every watched directory, for changes that can affect all of them. */
	private queueAll(): void {
		for (const path of this.directories.keys()) {
			this.queue(path);
		}
	}

	/** Mark a folder as changed; changes are reported together after a short delay. */
	private queue(path: string): void {
		if (this.stopped || !this.directories.has(path)) {
			return;
		}
		this.dirty.add(path);
		// A fixed window also flushes during continuous build or deletion activity.
		this.batch ??= setTimeout(() => {
			this.batch = undefined;
			const paths = [...this.dirty];
			this.dirty.clear();
			if (!this.stopped && paths.length) {
				this.changed(paths);
			}
		}, 250);
		this.batch.unref();
	}

	/** The stamp of a folder, or undefined when it is missing. */
	private async stamp(path: string): Promise<DirectoryStamp | undefined> {
		try {
			const resolved = await this.resolveDirectory(path);
			const [directory, ignore] = await Promise.all([
				stat(resolved, { bigint: true }),
				// Editing an existing ignore file does not change the directory's timestamps.
				stat(join(resolved, '.gitignore'), { bigint: true }).catch(() => undefined)
			]);
			return directory.isDirectory()
				? {
						listing: `${directory.dev}:${directory.ino}:${directory.mtimeNs}:${directory.ctimeNs}`,
						ignore: ignore
							? `${ignore.dev}:${ignore.ino}:${ignore.size}:${ignore.mtimeNs}:${ignore.ctimeNs}`
							: undefined
					}
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** Poll the folders without native notifications every 1.5 seconds. */
	private schedulePoll(): void {
		if (
			this.stopped ||
			this.poll ||
			this.polling ||
			![...this.directories.values()].some(({ polling }) => polling)
		) {
			return;
		}
		this.poll = setTimeout(async () => {
			this.poll = undefined;
			this.polling = true;
			// Poll only directories whose native notifications are unavailable (including UNC/WSL).
			const directories = [...this.directories.values()].filter(({ polling }) => polling);
			await forEachConcurrently(directories, async (directory) => {
				if (!this.current(directory)) {
					return;
				}
				const stamp = await this.stamp(directory.path);
				if (this.current(directory)) {
					const previous = directory.stamp;
					directory.stamp = stamp;
					if (previous?.ignore !== stamp?.ignore) {
						// Ignore rules also affect every expanded descendant's decorations.
						this.queueAll();
					} else if (previous?.listing !== stamp?.listing) {
						this.queue(directory.path);
					}
				}
			});
			this.polling = false;
			this.schedulePoll();
		}, 1500);
		this.poll.unref();
	}
}
