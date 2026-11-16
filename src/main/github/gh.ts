import { execFile } from 'node:child_process';
import { parseWslPath } from '../../shared/wsl';
import { wslArguments } from '../platform/wsl';

// Runs the GitHub CLI (gh), signed in with the user's own `gh auth login`; Nido stores no
// token. A WSL workspace runs the gh inside its distribution, like git does.

/** The executable to run and its first arguments, which tests replace with a fake gh. */
let executable: [string, string[]] = ['gh', []];

/** Run `command` with `args` first instead of gh, for tests. */
export function useGhExecutable(command: string, args: string[] = []): void {
	executable = [command, args];
}

/** gh failed; `missing` when it is not installed. */
export class GhError extends Error {
	constructor(
		message: string,
		readonly missing = false
	) {
		super(message);
	}
}

/** Run gh with `args` in the folder `cwd`, passing `input` on stdin, and return its output. */
export function gh(cwd: string, args: string[], input?: string): Promise<string> {
	const remote = parseWslPath(cwd);
	// gh must never wait for input that nobody can type, nor page or color its output.
	const env = {
		...process.env,
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
		GH_PAGER: '',
		NO_COLOR: '1',
		CLICOLOR: '0'
	};
	const [command, commandArgs] = remote
		? [
				'wsl.exe',
				wslArguments(remote.distribution, remote.path, [
					'env',
					'GH_PROMPT_DISABLED=1',
					'GH_NO_UPDATE_NOTIFIER=1',
					'GH_PAGER=',
					'NO_COLOR=1',
					'gh',
					...args
				])
			]
		: [executable[0], [...executable[1], ...args]];
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			commandArgs,
			{
				...(!remote ? { cwd } : {}),
				encoding: 'utf8',
				windowsHide: true,
				maxBuffer: 32 * 1024 * 1024,
				timeout: 120_000,
				env
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout);
					return;
				}
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(new GhError('GitHub CLI (gh) is not installed.', true));
					return;
				}
				const message = stderr.trim() || stdout.trim() || error.message;
				reject(new GhError(message.replace(/^(?:error|GraphQL): /i, '')));
			}
		);
		// gh can exit before it reads its input; its exit status reports that.
		child.stdin?.on('error', () => {});
		child.stdin?.end(input ?? '');
	});
}

/** Run gh and parse its JSON output. */
export async function ghJson<T>(cwd: string, args: string[], input?: string): Promise<T> {
	const output = await gh(cwd, args, input);
	try {
		return JSON.parse(output) as T;
	} catch {
		throw new GhError('GitHub CLI returned an unexpected reply.');
	}
}

/** Run a GraphQL request through `gh api graphql`, with `variables` as typed fields. */
export async function ghGraphql<T>(
	cwd: string,
	query: string,
	variables: Record<string, string | number | boolean>
): Promise<T> {
	const args = ['api', 'graphql', '-f', `query=${query}`];
	for (const [name, value] of Object.entries(variables)) {
		// -F turns numbers and booleans into their JSON types; strings stay strings with -f.
		args.push(typeof value === 'string' ? '-f' : '-F', `${name}=${value}`);
	}
	const reply = await ghJson<{ data?: T; errors?: { message: string }[] }>(cwd, args);
	if (reply.errors?.length) {
		throw new GhError(reply.errors.map((error) => error.message).join('\n'));
	}
	if (!reply.data) {
		throw new GhError('GitHub CLI returned an unexpected reply.');
	}
	return reply.data;
}
