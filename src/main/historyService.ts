import { readFile, stat } from 'node:fs/promises';
import {
	historyLimits,
	type HistoryContent,
	type HistoryList,
	type HistoryPreview,
	type HistorySnapshot,
	type HistoryToken
} from '../shared/history';
import { LocalHistory } from './localHistory';
import type { Session } from './session';

/**
 * A file's text on disk as a history version, or undefined when it is too large, not valid
 * UTF-8 or binary. `fallbackFormat` is used when the text has no line ending to detect.
 */
async function readDiskVersion(
	path: string,
	fallbackFormat: HistoryContent['fileformat']
): Promise<HistoryContent | undefined> {
	if ((await stat(path)).size > historyLimits.fileBytes) {
		return undefined;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
	} catch {
		// The editor can decode other encodings; never archive a lossy disk baseline.
		return undefined;
	}
	// Read line endings as Neovim does: CRLF only when every line ends in it, so a file with
	// mixed endings keeps its CR characters. Without any LF there is nothing to detect, and
	// the buffer's own format applies.
	const fileformat = text.includes('\n')
		? /(?:^|[^\r])\n/.test(text)
			? 'unix'
			: 'dos'
		: fallbackFormat;
	text =
		fileformat === 'dos'
			? text.replaceAll('\r\n', '\n')
			: fileformat === 'mac'
				? text.replaceAll('\r', '\n')
				: text;
	if (
		text.includes('\0') ||
		text.split('\n').length > historyLimits.lines + Number(text.endsWith('\n')) ||
		Buffer.byteLength(text) > historyLimits.fileBytes
	) {
		return undefined;
	}
	return { text, endOfLine: text.endsWith('\n'), fileformat };
}

/**
 * Time Machine for open workspaces: captures changed buffers into LocalHistory, lists and
 * previews stored versions, and restores one into the editor. Work for one session runs one
 * operation at a time.
 */
export class HistoryService {
	// What was last captured from each buffer, per session (see HistoryToken).
	private tokens = new WeakMap<Session, Map<number, HistoryToken>>();
	// The capture in progress per session; a capture requested meanwhile joins it.
	private pending = new WeakMap<Session, Promise<void>>();
	// The tail of each session's operation queue.
	private operations = new WeakMap<Session, Promise<unknown>>();
	// The latest preview request per session; older ones stop as soon as they notice.
	private previews = new WeakMap<Session, object>();

	constructor(readonly store: LocalHistory) {}

	/** Run `operation` after the session's earlier operations, even ones that failed. */
	private serial<T>(session: Session, operation: () => Promise<T>): Promise<T> {
		const next = (this.operations.get(session) || Promise.resolve()).then(operation);
		this.operations.set(
			session,
			next.catch(() => {})
		);
		return next;
	}

	/** The token that identifies a snapshot's buffer contents, as the Lua side builds it. */
	private token(value: HistorySnapshot): string {
		return `${value.buffer}:${value.tick}:${value.fileformat}:${value.endOfLine}`;
	}

	/** Record a snapshot as a draft (unsaved) or saved version. */
	private async record(
		value: HistorySnapshot,
		kind = value.modified ? ('draft' as const) : ('saved' as const)
	): Promise<void> {
		await this.preserveOriginal(value);
		await this.store.record(value.path, value, kind);
	}

	/**
	 * Before the first version of a modified file is recorded, record the file as it is on
	 * disk, so the state before the unsaved edits can be restored too.
	 */
	private async preserveOriginal(value: HistorySnapshot): Promise<void> {
		if (!value.modified || (await this.store.has(value.path))) {
			return;
		}
		try {
			const original = await readDiskVersion(value.path, value.fileformat);
			if (original) {
				await this.store.record(value.path, original, 'saved');
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	/** Record every buffer of the session that changed since its last capture. */
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

	/** Record the current buffer if it changed, then list its versions. */
	list(session: Session): Promise<HistoryList> {
		return this.serial(session, async () => {
			const current = await session.historyCurrent();
			await this.preserveOriginal(current);
			const versions = await this.store.recordAndList(
				current.path,
				current,
				current.modified ? 'draft' : 'saved'
			);
			return { path: current.path, versions };
		});
	}

	/** A diff between stored version `id` and the current buffer, for the preview. */
	preview(session: Session, path: string, id: string): Promise<HistoryPreview> {
		const request = {};
		this.previews.set(session, request);
		const currentRequest = (): void => {
			if (this.previews.get(session) !== request) {
				throw new Error('History preview was superseded.');
			}
		};
		return this.serial(session, async () => {
			currentRequest();
			const current = await session.historyCurrent();
			currentRequest();
			if (current.path !== path) {
				throw new Error('The active file changed. Reopen Time Machine.');
			}
			const version = await this.store.version(path, id);
			currentRequest();
			const diff = await session.historyDiff(version.text, current.text);
			currentRequest();
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
				diff,
				identical:
					version.text === current.text &&
					version.endOfLine === current.endOfLine &&
					version.fileformat === current.fileformat
			};
		});
	}

	/**
	 * Replace the current buffer with version `id`, after recording the buffer as it is. `token`
	 * comes from the preview; a buffer edited since then is not overwritten. Resolves whether the
	 * restored version could also be recorded.
	 */
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
