import { readFile, stat } from 'node:fs/promises';
import {
    historyLimits,
    type HistoryList,
    type HistoryPreview,
    type HistorySnapshot,
    type HistoryToken
} from '../shared/history';
import { LocalHistory } from './localHistory';
import type { Session } from './session';

export class HistoryService {
    private tokens = new WeakMap<Session, Map<number, HistoryToken>>();
    private pending = new WeakMap<Session, Promise<void>>();
    private operations = new WeakMap<Session, Promise<unknown>>();

    constructor(readonly store: LocalHistory) {}

    private serial<T>(session: Session, operation: () => Promise<T>): Promise<T> {
        const next = (this.operations.get(session) || Promise.resolve()).then(operation);
        this.operations.set(
            session,
            next.catch(() => {})
        );
        return next;
    }

    private token(value: HistorySnapshot): string {
        return `${value.buffer}:${value.tick}:${value.fileformat}:${value.endOfLine}`;
    }

    private async record(
        value: HistorySnapshot,
        kind = value.modified ? ('draft' as const) : ('saved' as const)
    ): Promise<void> {
        if (!(await this.store.has(value.path)) && value.modified) {
            try {
                if ((await stat(value.path)).size <= historyLimits.fileBytes) {
                    const bytes = await readFile(value.path);
                    let original: string;
                    try {
                        original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    } catch {
                        // The editor can decode other encodings; never archive a lossy disk baseline.
                        await this.store.record(value.path, value, kind);
                        return;
                    }
                    const fileformat = original.includes('\r\n')
                        ? 'dos'
                        : original.includes('\r')
                          ? 'mac'
                          : 'unix';
                    original =
                        fileformat === 'dos'
                            ? original.replaceAll('\r\n', '\n')
                            : fileformat === 'mac'
                              ? original.replaceAll('\r', '\n')
                              : original;
                    if (
                        !original.includes('\0') &&
                        original.split('\n').length <=
                            historyLimits.lines + Number(original.endsWith('\n')) &&
                        Buffer.byteLength(original) <= historyLimits.fileBytes
                    ) {
                        await this.store.record(
                            value.path,
                            {
                                text: original,
                                endOfLine: original.endsWith('\n'),
                                fileformat
                            },
                            'saved'
                        );
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        await this.store.record(value.path, value, kind);
    }

    capture(session: Session): Promise<void> {
        const previous = this.pending.get(session);
        if (previous) {
            return previous;
        }
        const known = this.tokens.get(session) || new Map<number, HistoryToken>();
        this.tokens.set(session, known);
        const capturing = this.serial(session, async () => {
            const values = await session.historySnapshots([...known.values()]);
            for (const value of values) {
                await this.record(value);
                // Failed writes never advance the token, so the next pass can retry.
                known.set(value.buffer, [
                    value.buffer,
                    value.tick,
                    value.fileformat,
                    value.endOfLine
                ]);
            }
            const buffers = new Set(session.state.buffers.map((buffer) => buffer.id));
            for (const buffer of known.keys()) {
                if (!buffers.has(buffer)) {
                    known.delete(buffer);
                }
            }
        });
        this.pending.set(session, capturing);
        void capturing.finally(() => this.pending.delete(session)).catch(() => {});
        return capturing;
    }

    list(session: Session): Promise<HistoryList> {
        return this.serial(session, async () => {
            const current = await session.historyCurrent();
            await this.record(current);
            return { path: current.path, versions: await this.store.list(current.path) };
        });
    }

    preview(session: Session, path: string, id: string): Promise<HistoryPreview> {
        return this.serial(session, async () => {
            const current = await session.historyCurrent();
            if (current.path !== path) {
                throw new Error('The active file changed. Reopen Time Machine.');
            }
            const version = await this.store.version(path, id);
            return {
                path,
                version: {
                    id: version.id,
                    timestamp: version.timestamp,
                    kind: version.kind,
                    bytes: version.bytes,
                    lines: version.lines
                },
                token: this.token(current),
                diff: await session.historyDiff(version.text, current.text),
                identical:
                    version.text === current.text &&
                    version.endOfLine === current.endOfLine &&
                    version.fileformat === current.fileformat
            };
        });
    }

    restore(session: Session, path: string, id: string, token: string): Promise<boolean> {
        return this.serial(session, async () => {
            const current = await session.historyCurrent();
            if (current.path !== path || this.token(current) !== token) {
                throw new Error('The file changed. Refresh the preview before restoring.');
            }
            const version = await this.store.version(path, id);
            await this.record(current);
            const restored = await session.historyRestore(path, token, {
                text: version.text,
                endOfLine: version.endOfLine,
                fileformat: version.fileformat
            });
            // The previous draft was persisted before replacement. The replacement stays unsaved.
            try {
                await this.store.record(path, restored, 'restored');
                return true;
            } catch {
                // Report partial success accurately: the buffer changed and the previous draft is safe.
                return false;
            }
        });
    }
}
