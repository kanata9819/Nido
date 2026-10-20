import { Worker } from 'node:worker_threads';
import type { SearchOptions } from '../shared/search';

export interface LineMatch {
    line: number;
    index: number;
    text: string;
}

// User regular expressions run outside Electron's main thread. A slow expression
// can be cancelled without blocking input, IPC, or other workspaces.
const matcherWorker = String.raw`
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, source, flags, text, replacement, selected, regex }) => {
  try {
    const pattern = new RegExp(source, flags);
    const parts = text.split(/(\r\n|\n|\r)/);
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
          text: parts[index].slice(Math.max(0, match.index - 80), match.index + 220).trim() });
        if (matches.length === 201) break;
      }
      parentPort.postMessage({ id, value: matches });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});`;

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

    private request<T>(value: Record<string, unknown>): Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error('Search cancelled.'));
        }
        if (!this.worker) {
            this.worker = new Worker(matcherWorker, { eval: true });
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
            this.worker.on('exit', () => this.close());
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

    find(text: string): Promise<LineMatch[]> {
        return this.request({ text });
    }

    replace(
        text: string,
        selected: number[],
        replacement: string
    ): Promise<{ text: string; count: number }> {
        return this.request({ text, selected, replacement });
    }

    close(error = new Error('Search cancelled.')): void {
        this.closed = true;
        const worker = this.worker;
        this.worker = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        void worker?.terminate();
    }
}
