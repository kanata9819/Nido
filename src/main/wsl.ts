import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseWslPath, validWslDistribution, wslHostPath } from '../shared/wsl';

const exec = promisify(execFile);
const preparing = new Map<string, Promise<WslRuntime>>();

interface WslRuntime {
    nvim: string;
    node: string;
    resources: string;
}

export function decodeWslOutput(value: Buffer): string {
    return value
        .toString(value.includes(0) ? 'utf16le' : 'utf8')
        .replace(/^\uFEFF/, '')
        .trim();
}

export function wslArguments(distribution: string, cwd: string, args: string[]): string[] {
    if (!validWslDistribution(distribution)) {
        throw new Error('Invalid WSL distribution.');
    }
    return ['--distribution', distribution, '--cd', cwd, '--exec', ...args];
}

export async function wslDistributions(): Promise<string[]> {
    if (process.platform !== 'win32') {
        return [];
    }
    try {
        const { stdout } = await exec('wsl.exe', ['--list', '--quiet'], {
            encoding: 'buffer',
            windowsHide: true,
            timeout: 15000
        });
        return decodeWslOutput(stdout)
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter(Boolean);
    } catch (error) {
        const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
            `WSL is unavailable. Install WSL and a Linux distribution, then retry. ${
                failure.stderr?.length
                    ? decodeWslOutput(failure.stderr)
                    : failure.stdout?.length
                      ? decodeWslOutput(failure.stdout)
                      : failure.message
            }`
        );
    }
}

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
        task.child.stdin?.end(input);
        return decodeWslOutput((await task).stdout);
    } catch (error) {
        const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
            `WSL (${distribution}): ${
                failure.stderr?.length
                    ? decodeWslOutput(failure.stderr)
                    : failure.stdout?.length
                      ? decodeWslOutput(failure.stdout)
                      : failure.message
            }`
        );
    }
}

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

export async function trashWslFile(path: string): Promise<void> {
    const remote = parseWslPath(path);
    if (!remote) {
        throw new Error('Expected a WSL file path.');
    }
    await run(remote.distribution, '~', ['gio', 'trash', '--', remote.path]);
}

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
