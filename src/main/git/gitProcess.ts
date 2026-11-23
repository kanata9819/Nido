import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseWslPath } from '../../shared/wsl';
import { wslArguments } from '../platform/wsl';

interface GitInvocation {
	file: string;
	args: string[];
	options: { cwd?: string; env: NodeJS.ProcessEnv; windowsHide: boolean };
}

/** Run Git on the same side of the Windows/WSL boundary as the repository. */
export function gitInvocation(
	cwd: string,
	args: string[],
	env: Record<string, string> = {}
): GitInvocation {
	const remote = parseWslPath(cwd);
	const overrides = { GIT_TERMINAL_PROMPT: '0', ...env };
	const gitArgs = ['--no-pager', '--literal-pathspecs', '--no-optional-locks', ...args];
	return {
		file: remote ? 'wsl.exe' : 'git',
		args: remote
			? wslArguments(remote.distribution, remote.path, [
					'env',
					...Object.entries(overrides).map(([key, value]) => `${key}=${value}`),
					'git',
					...gitArgs
				])
			: gitArgs,
		options: {
			...(!remote ? { cwd } : {}),
			env: { ...process.env, ...overrides },
			windowsHide: true
		}
	};
}

function startIgnoreProcess(cwd: string): ChildProcessByStdio<Writable, Readable, null> {
	const command = gitInvocation(
		cwd,
		['--no-literal-pathspecs', 'check-ignore', '--verbose', '--non-matching', '-z', '--stdin'],
		{ GIT_FLUSH: '1' }
	);
	const child = spawn(command.file, command.args, {
		...command.options,
		stdio: ['pipe', 'pipe', 'ignore']
	});
	// Its output ending early rejects the pending batch, including on a failed spawn.
	child.on('error', () => {});
	child.stdin.on('error', () => {});
	child.stdout.setEncoding('utf8');
	return child;
}

/** One check-ignore process for the successive batches of a workspace search. */
export class GitIgnoreReader {
	private readonly wsl: boolean;
	private child?: ReturnType<typeof startIgnoreProcess>;
	private output?: AsyncIterator<string>;
	private closed = false;

	constructor(private readonly cwd: string) {
		this.wsl = !!parseWslPath(cwd);
	}

	/** Each path is echoed with its matching pattern, including negations and empty matches. */
	async check(paths: string[]): Promise<Set<string>> {
		if (!paths.length) {
			return new Set();
		}
		if (this.closed) {
			throw new Error('Git ignore reader is closed.');
		}
		const child = (this.child ??= startIgnoreProcess(this.cwd));
		const output = (this.output ??= child.stdout[Symbol.asyncIterator]());
		const normalized = this.wsl ? paths.map((path) => path.replaceAll('\\', '/')) : paths;
		const timeout = setTimeout(() => this.close(), 60_000);
		try {
			child.stdin.write(`${normalized.join('\0')}\0`);
			const fields: string[] = [];
			let tail = '';
			while (fields.length < paths.length * 4) {
				const chunk = await output.next();
				if (chunk.done) {
					throw new Error('Git ignore output ended early.');
				}
				const parts = (tail + chunk.value).split('\0');
				tail = parts.pop()!;
				for (const field of parts) {
					fields.push(field);
				}
			}
			const ignored = new Set<string>();
			for (const [index, path] of paths.entries()) {
				const offset = index * 4;
				if (fields[offset + 3] !== normalized[index]) {
					throw new Error('Unexpected path in Git ignore output.');
				}
				const pattern = fields[offset + 2];
				if (pattern && !pattern.startsWith('!')) {
					ignored.add(path);
				}
			}
			return ignored;
		} catch (error) {
			this.close();
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	close(): void {
		this.closed = true;
		this.child?.stdin.end();
		this.child?.kill();
	}
}
