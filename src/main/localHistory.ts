import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { historyLimits, type HistoryContent, type HistoryVersion } from '../shared/history';

interface Revision extends HistoryVersion, HistoryContent {}
interface HistoryFile {
    version: 1;
    path: string;
    revisions: Revision[];
}

export class LocalHistory {
    private pending: Promise<unknown> = Promise.resolve();
    private ready?: Promise<void>;
    private entries = new Map<string, { bytes: number; time: number }>();

    constructor(
        private readonly directory: string,
        private readonly limits: {
            versions: number;
            historyBytes: number;
            totalBytes: number;
            files: number;
        } = historyLimits
    ) {}

    private key(path: string): string {
        const normalized = resolve(path).replaceAll('\\', '/');
        return createHash('sha256')
            .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
            .digest('hex');
    }

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

    private async read(path: string): Promise<HistoryFile> {
        await this.initialize();
        const file = join(this.directory, `${this.key(path)}.json`);
        try {
            if ((await stat(file)).size > this.limits.historyBytes) {
                throw new Error('Local history exceeds its storage limit.');
            }
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
            return data;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { version: 1, path, revisions: [] };
            }
            throw error;
        }
    }

    async list(path: string): Promise<HistoryVersion[]> {
        await this.pending;
        return (await this.read(path)).revisions.map(({ id, timestamp, kind, bytes, lines }) => ({
            id,
            timestamp,
            kind,
            bytes,
            lines
        }));
    }

    async has(path: string): Promise<boolean> {
        await this.pending;
        await this.initialize();
        return this.entries.has(`${this.key(path)}.json`);
    }

    async version(path: string, id: string): Promise<Revision> {
        await this.pending;
        const revision = (await this.read(path)).revisions.find((revision) => revision.id === id);
        if (!revision) {
            throw new Error('This history version is no longer available. Refresh Time Machine.');
        }
        return revision;
    }

    record(
        path: string,
        content: HistoryContent,
        kind: HistoryVersion['kind']
    ): Promise<HistoryVersion> {
        const writing = this.pending.then(async () => {
            if (
                Buffer.byteLength(content.text) > historyLimits.fileBytes ||
                content.text.split('\n').length > historyLimits.lines + 1 ||
                content.text.includes('\0')
            ) {
                throw new Error('Time Machine supports text files up to 1 MB and 20,000 lines.');
            }
            const data = await this.read(path);
            const previous = data.revisions[0];
            if (
                previous &&
                previous.text === content.text &&
                previous.endOfLine === content.endOfLine &&
                previous.fileformat === content.fileformat
            ) {
                return previous;
            }
            const revision: Revision = {
                text: content.text,
                endOfLine: content.endOfLine,
                fileformat: content.fileformat,
                id: randomUUID(),
                timestamp: Date.now(),
                kind,
                bytes: Buffer.byteLength(content.text),
                lines: Math.max(1, content.text.split('\n').length - Number(content.endOfLine))
            };
            data.revisions.unshift(revision);
            data.revisions.length = Math.min(data.revisions.length, this.limits.versions);
            let serialized = JSON.stringify(data);
            const budget = Math.min(this.limits.historyBytes, this.limits.totalBytes);
            while (Buffer.byteLength(serialized) > budget && data.revisions.length > 1) {
                data.revisions.pop();
                serialized = JSON.stringify(data);
            }
            if (Buffer.byteLength(serialized) > budget) {
                throw new Error('Local history storage is full.');
            }
            const name = `${this.key(path)}.json`;
            const destination = join(this.directory, name);
            // An interrupted write leaves the previously committed history intact.
            await writeFile(`${destination}.tmp`, serialized, { encoding: 'utf8', mode: 0o600 });
            await rename(`${destination}.tmp`, destination);
            this.entries.set(name, { bytes: Buffer.byteLength(serialized), time: Date.now() });
            let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
            const oldest = [...this.entries]
                .filter(([file]) => file !== name)
                .sort((a, b) => a[1].time - b[1].time);
            for (const [file, entry] of oldest) {
                if (total <= this.limits.totalBytes && this.entries.size <= this.limits.files) {
                    break;
                }
                // Only hash-named files discovered in this dedicated history directory are pruned.
                await rm(join(this.directory, file));
                this.entries.delete(file);
                total -= entry.bytes;
            }
            return revision;
        });
        this.pending = writing.catch(() => {});
        return writing;
    }
}
