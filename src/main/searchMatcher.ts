import { Worker } from 'node:worker_threads';
import type { SearchOptions } from '../shared/search';
import { searchLineEnding } from './searchLines';

// Matches search text (plain text, whole word or regular expression) against file contents in
// a worker thread, for workspace text search and replacement.

/** The first match on a line. */
export interface LineMatch {
	line: number;
	/** UTF-16 offset, retained for callers working with JavaScript strings. */
	index: number;
	/** One-based UTF-8 byte column for Neovim. */
	column: number;
	text: string;
}

// User regular expressions run outside Electron's main thread. A slow expression
// can be cancelled without blocking input, IPC, or other workspaces.
const matcherWorker = String.raw`
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, source, flags, text, ending, replacement, selected, regex }) => {
  try {
    const pattern = new RegExp(source, flags);
    const parts = text.split(new RegExp('(' + ending + ')'));
    if (selected) {
      let count = 0;
      for (const line of selected) {
        const index = (line - 1) * 2;
        if (parts[index] === undefined) throw new Error('Search results changed. Search again.');
        const matches = [...parts[index].matchAll(pattern)];
        if (!matches.length) throw new Error('Search results changed. Search again.');
        count += matches.length;
        parts[index] = parts[index].replace(pattern, regex ? replacement : () => replacement);
      }
      parentPort.postMessage({ id, value: { text: parts.join(''), count } });
    } else {
      const matches = [];
      for (let index = 0; index < parts.length; index += 2) {
        // A final line ending does not introduce another editable Neovim row.
        if (index > 0 && index === parts.length - 1 && parts[index] === '') break;
        pattern.lastIndex = 0;
        const match = pattern.exec(parts[index]);
        if (match) matches.push({ line: index / 2 + 1, index: match.index,
          column: Buffer.byteLength(parts[index].slice(0, match.index)) + 1,
          text: parts[index].slice(Math.max(0, match.index - 80), match.index + 220).trim() });
        if (matches.length === 201) break;
      }
      parentPort.postMessage({ id, value: matches });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});`;

// Keep one healthy idle worker for consecutive searches; never retain a busy regex.
let idleWorker: Worker | undefined;
let idleTimer: NodeJS.Timeout | undefined;

/** One search's pattern, running in its own worker until close(). */
export class SearchMatcher {
	private worker?: Worker;
	private sequence = 0;
	private closed = false;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private readonly source: string;
	private readonly flags: string;

	constructor(
		query: string,
		private options: SearchOptions
	) {
		const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		this.source = options.wholeWord
			? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
			: source;
		this.flags = options.caseSensitive ? 'gu' : 'giu';
		try {
			new RegExp(source, this.flags);
			new RegExp(this.source, this.flags);
		} catch {
			throw new Error('Invalid regular expression.');
		}
	}

	/** Send a job to the worker. A job running longer than 2 seconds closes the matcher. */
	private request<T>(value: Record<string, unknown>): Promise<T> {
		if (this.closed) {
			return Promise.reject(new Error('Search cancelled.'));
		}
		if (!this.worker) {
			clearTimeout(idleTimer);
			this.worker = idleWorker ?? new Worker(matcherWorker, { eval: true });
			idleWorker = undefined;
			this.worker.removeAllListeners();
			this.worker.ref();
			this.worker.on('message', ({ id, value, error }) => {
				const pending = this.pending.get(id);
				if (!pending) {
					return;
				}
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if (error) {
					pending.reject(new Error(error));
				} else {
					pending.resolve(value);
				}
			});
			this.worker.on('error', (error) => this.close(error));
			this.worker.on('exit', () => this.close(new Error('Search worker exited.')));
		}
		const id = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => this.close(new Error('Search expression took too long. Simplify it.')),
				2000
			);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.worker!.postMessage({
				id,
				source: this.source,
				flags: this.flags,
				regex: this.options.regex,
				...value
			});
		});
	}

	/** The first match on each line of `text` (up to 201 lines, to detect truncation). */
	find(text: string): Promise<LineMatch[]> {
		return this.request({ text, ending: searchLineEnding(text) });
	}

	/** Replace every match on the selected (one-based) lines; throws when a line no longer matches. */
	replace(
		text: string,
		selected: number[],
		replacement: string
	): Promise<{ text: string; count: number }> {
		return this.request({ text, ending: searchLineEnding(text), selected, replacement });
	}

	/**
	 * Cancel pending jobs. A worker that finished cleanly is kept idle for 10 seconds, so the next
	 * search starts without creating one.
	 */
	close(error?: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const worker = this.worker;
		this.worker = undefined;
		worker?.removeAllListeners();
		const reusable = worker && !error && this.pending.size === 0;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error('Search cancelled.'));
		}
		this.pending.clear();
		if (reusable) {
			clearTimeout(idleTimer);
			void idleWorker?.terminate();
			worker.unref();
			idleWorker = worker;
			const discard = (): void => {
				if (idleWorker === worker) {
					clearTimeout(idleTimer);
					idleWorker = undefined;
				}
			};
			worker.on('error', discard);
			worker.on('exit', discard);
			idleTimer = setTimeout(() => {
				void idleWorker?.terminate();
				idleWorker = undefined;
			}, 10_000);
			idleTimer.unref();
		} else {
			void worker?.terminate();
		}
	}
}
