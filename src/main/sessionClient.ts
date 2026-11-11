import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NeovimClient } from 'neovim';
import { getLogger } from 'neovim/lib/utils/logger';

type ClientLogger = NonNullable<
	NonNullable<ConstructorParameters<typeof NeovimClient>[0]>['logger']
>;

const quiet = (): ClientLogger => silentLogger;
const silentLogger = {
	level: 'error',
	info: quiet,
	warn: quiet,
	error: quiet,
	debug: quiet
} as unknown as ClientLogger;
let consoleKept = false;

/**
 * The package's own logger replaces console.log, console.error and the rest for the whole
 * process when it is first created, so that a plugin host cannot write to its RPC channel.
 * Nido talks to Neovim over the child's pipes: create that logger once, keep the console,
 * and give the client a logger that does no work for each notification.
 */
function clientLogger(): ClientLogger {
	if (!consoleKept) {
		consoleKept = true;
		const native = { ...console };
		getLogger();
		Object.assign(console, native);
	}
	return silentLogger;
}

/**
 * The error for a failed request. A message that Lua code raises on purpose, with error() or
 * assert(), is shown to the user as it is: without the request name, the Lua file and line
 * it came from, or the stack traceback. Any other failure, such as indexing nil, keeps them,
 * because they say where the bug is.
 */
export function neovimError(name: string, message: string): Error {
	const raised =
		/^Error executing lua: (?:(?:\[string "[^"\n]*"\]|[^\n]+?\.lua):\d+: )?([\s\S]*?)\nstack traceback:\n\s*\[C\]: in function '(?:error|assert)'/.exec(
			message
		);
	return new Error(raised ? raised[1] : `${name}: ${message}`);
}

/**
 * RPC client for one Neovim process, extending NeovimClient from the `neovim` package.
 * request('nvim_<name>', args) calls a Neovim API function and resolves with its result.
 *
 * Settle RPC callers when the child disconnects; neovim's transport leaves them pending.
 */
export class SessionClient extends NeovimClient {
	private failure?: Error;
	private readonly pending = new Set<(error: Error) => void>();

	constructor(
		private readonly process: ChildProcessWithoutNullStreams,
		onError: (error: Error) => void
	) {
		super({ logger: clientLogger() });
		process.stdin.on('error', (error) => {
			const disconnected = !!this.failure;
			this.cancelRequests(error);
			if (!disconnected) {
				onError(error);
			}
			// A failed writer cannot carry further RPCs, even if the child is still alive.
			process.kill();
		});
		process.on('error', (error) => this.cancelRequests(error));
		process.once('exit', () => this.cancelRequests());
		this.once('disconnect', () => this.cancelRequests());
		this.attach({ reader: process.stdout, writer: process.stdin });
	}

	// Track each request in `pending` so cancelRequests can reject it if Neovim goes away.
	override asyncRequest(name: string, args: unknown[] = []): ReturnType<NeovimClient['request']> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		return new Promise((resolve, reject) => {
			this.pending.add(reject);
			const finish = (error: Error | null, result?: unknown): void => {
				this.pending.delete(reject);
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			};
			void this._isReady
				.then(() => {
					// Startup readiness is asynchronous: check again immediately before writing.
					if (this.failure) {
						finish(this.failure);
						return;
					}
					this.transport.request(
						name,
						args,
						(error: [number, string] | null, result: unknown) => {
							finish(error ? neovimError(name, error[1]) : null, result);
						}
					);
				})
				.catch((error: Error) => finish(error));
		});
	}

	override notify(name: string, args: unknown[]): void {
		if (this.failure) {
			throw this.failure;
		}
		super.notify(name, args);
	}

	// Reject pending requests; later requests fail immediately.
	cancelRequests(error = new Error('Neovim session is closed.')): void {
		this.failure ??= error;
		for (const reject of this.pending) {
			reject(this.failure);
		}
		this.pending.clear();
	}

	quit(): void {
		// Shutdown is the sole write allowed after cancelling regular RPC requests.
		if (
			!this.process.stdin.destroyed &&
			this.process.stdin.writable &&
			this.process.exitCode === null &&
			this.process.signalCode === null
		) {
			super.notify('nvim_command', ['qa!']);
		}
	}
}
