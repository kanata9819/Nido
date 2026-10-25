import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

interface Directory {
  path: string;
  initialized: boolean;
  polling: boolean;
  stamp?: string;
  watcher?: FSWatcher;
}

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

  async ready(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.pending;
      await pending;
    } while (pending !== this.pending);
  }

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

  private current(directory: Directory): boolean {
    return !this.stopped && this.directories.get(directory.path) === directory;
  }

  private async prepare(): Promise<void> {
    const directories = [...this.directories.values()].filter(({ initialized }) => !initialized);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, directories.length) }, async () => {
        while (next < directories.length) {
          const directory = directories[next++];
          if (!this.current(directory)) {
            continue;
          }
          directory.initialized = true;
          if (this.recursive && !this.usePolling && directory.path) {
            if (this.directories.get('')?.polling) {
              directory.polling = true;
              directory.stamp = await this.stamp(directory.path);
            }
            this.queue(directory.path);
            continue;
          }
          try {
            const path = await this.resolveDirectory(directory.path);
            if (!this.current(directory)) {
              continue;
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
              continue;
            }
            this.fallback(directory);
            directory.stamp = await this.stamp(directory.path);
          }
          if (this.current(directory)) {
            // Reconcile changes between the preceding listing and watcher attachment.
            this.queue(directory.path);
          }
        }
      })
    );
    this.schedulePoll();
  }

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

  private notifyRecursive(root: Directory, event: string, filename: string | null): void {
    if (!this.current(root)) {
      return;
    }
    if (filename === null) {
      for (const path of this.directories.keys()) {
        this.queue(path);
      }
      return;
    }
    const parent = dirname(filename);
    const directory = this.directories.get(parent === '.' ? '' : parent);
    if (!directory) {
      return;
    }
    const name = basename(filename);
    if (name === '.gitignore' || name === '.git') {
      for (const path of this.directories.keys()) {
        this.queue(path);
      }
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

  private notify(directory: Directory, event: string, filename: string | null): void {
    if (!this.current(directory)) {
      return;
    }
    if (filename === '.gitignore' || filename === '.git' || filename === null) {
      for (const path of this.directories.keys()) {
        this.queue(path);
      }
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

  private async stamp(path: string): Promise<string | undefined> {
    try {
      const directory = await stat(await this.resolveDirectory(path), { bigint: true });
      return directory.isDirectory()
        ? `${directory.dev}:${directory.ino}:${directory.mtimeNs}:${directory.ctimeNs}`
        : undefined;
    } catch {
      return undefined;
    }
  }

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
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, directories.length) }, async () => {
          while (next < directories.length) {
            const directory = directories[next++];
            if (!this.current(directory)) {
              continue;
            }
            const stamp = await this.stamp(directory.path);
            if (this.current(directory) && directory.stamp !== stamp) {
              directory.stamp = stamp;
              this.queue(directory.path);
            }
          }
        })
      );
      this.polling = false;
      this.schedulePoll();
    }, 1500);
    this.poll.unref();
  }
}
