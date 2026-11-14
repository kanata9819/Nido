import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseWslPath, validWslDistribution, wslHostPath } from '../shared/wsl';

// Runs commands inside WSL distributions through wsl.exe: listing distributions, resolving
// folders, moving files to the trash, and installing the runtime Neovim needs there.
const exec = promisify(execFile);
// Runtime setups in progress per distribution, so concurrent workspaces share one setup.
const preparing = new Map<string, Promise<WslRuntime>>();

/** Linux paths of Neovim, Node.js and Nido's resources inside a distribution. */
interface WslRuntime {
	nvim: string;
	node: string;
	resources: string;
}

/** Decode wsl.exe output. Some of its commands print UTF-16, which contains NUL bytes. */
export function decodeWslOutput(value: Buffer): string {
	return value
		.toString(value.includes(0) ? 'utf16le' : 'utf8')
		.replace(/^\uFEFF/, '')
		.trim();
}

/** The most useful text from a failed wsl.exe run: its stderr, else its stdout, else the error. */
function failureDetail(error: unknown): string {
	const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
	return failure.stderr?.length
		? decodeWslOutput(failure.stderr)
		: failure.stdout?.length
			? decodeWslOutput(failure.stdout)
			: failure.message;
}

/** wsl.exe arguments that run `args` in `distribution` with `cwd` as working directory. */
export function wslArguments(distribution: string, cwd: string, args: string[]): string[] {
	if (!validWslDistribution(distribution)) {
		throw new Error('Invalid WSL distribution.');
	}
	return ['--distribution', distribution, '--cd', cwd, '--exec', ...args];
}

/** Names of the installed WSL distributions. Empty off Windows. */
export async function wslDistributions(executable = 'wsl.exe'): Promise<string[]> {
	if (process.platform !== 'win32') {
		return [];
	}
	try {
		const { stdout } = await exec(executable, ['--list', '--quiet'], {
			encoding: 'buffer',
			windowsHide: true,
			timeout: 15000
		});
		return decodeWslOutput(stdout)
			.split(/\r?\n/)
			.map((name) => name.trim())
			.filter(Boolean);
	} catch (error) {
		throw new Error(
			`WSL is unavailable. Install WSL and a Linux distribution, then retry. ${failureDetail(error)}`
		);
	}
}

/** Run a command in a distribution and return its output; `input` is written to its stdin. */
async function run(
	distribution: string,
	cwd: string,
	args: string[],
	input?: string
): Promise<string> {
	try {
		const task = exec('wsl.exe', wslArguments(distribution, cwd, args), {
			encoding: 'buffer',
			windowsHide: true,
			timeout: input ? 300000 : 20000,
			maxBuffer: 1024 * 1024
		});
		// WSL can exit before it has read the script; its exit status reports the failure.
		task.child.stdin?.on('error', () => {});
		task.child.stdin?.end(input);
		return decodeWslOutput((await task).stdout);
	} catch (error) {
		throw new Error(`WSL (${distribution}): ${failureDetail(error)}`);
	}
}

/** The UNC path of a folder in a distribution, with links resolved. Empty `path` means home. */
export async function resolveWslFolder(distribution: string, path = ''): Promise<string> {
	const remote = parseWslPath(path);
	if (remote && remote.distribution.toLowerCase() !== distribution.toLowerCase()) {
		throw new Error('The folder belongs to another WSL distribution.');
	}
	const requested = remote?.path ?? path;
	if (requested && requested !== '~' && !requested.startsWith('/')) {
		throw new Error('Enter an absolute Linux folder path.');
	}
	// Resolve on Linux: a failed --cd can otherwise fall back to the home directory.
	const actual = await run(distribution, '~', [
		'sh',
		'-c',
		'if [ -n "$1" ] && [ "$1" != "~" ]; then cd -- "$1" || exit; fi; pwd -P',
		'nido',
		requested
	]);
	return wslHostPath(distribution, actual);
}

/** Move a file inside WSL to its trash with `gio trash`. */
export async function trashWslFile(path: string): Promise<void> {
	const remote = parseWslPath(path);
	if (!remote) {
		throw new Error('Expected a WSL file path.');
	}
	await run(remote.distribution, '~', ['gio', 'trash', '--', remote.path]);
}

/**
 * Make sure a distribution has the runtime Nido needs (wsl-runtime.sh installs it when
 * missing) and return its paths. The script prints KEY=value lines.
 */
export async function prepareWsl(distribution: string, resources: string): Promise<WslRuntime> {
	const key = `${distribution}\0${resources}`;
	let pending = preparing.get(key);
	if (!pending) {
		pending = (async () => {
			const script = await readFile(resolve(resources, 'nido/wsl-runtime.sh'), 'utf8');
			const output = await run(
				distribution,
				'~',
				['sh', '-s'],
				script.replaceAll('\r\n', '\n')
			);
			const fields = new Map(
				output.split(/\r?\n/).map((line) => {
					const separator = line.indexOf('=');
					return [line.slice(0, separator), line.slice(separator + 1)];
				})
			);
			const nvim = fields.get('NIDO_NVIM');
			const node = fields.get('NIDO_NODE');
			if (!nvim?.startsWith('/') || !node?.startsWith('/')) {
				throw new Error('WSL editor setup did not return its runtime paths.');
			}
			const mountedResources = await run(distribution, '~', [
				'wslpath',
				'-a',
				'-u',
				resources
			]);
			return { nvim, node, resources: mountedResources };
		})();
		preparing.set(key, pending);
		void pending.finally(() => preparing.delete(key)).catch(() => {});
	}
	return pending;
}
