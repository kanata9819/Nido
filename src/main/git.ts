import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChange, GitStatus, GitCommitEntry, GitBranchEntry } from '../shared/types';

const exec = promisify(execFile);

export async function gitHistory(cwd: string, skip: number): Promise<GitCommitEntry[]> {
    if (!Number.isSafeInteger(skip) || skip < 0) {
        throw new Error('Invalid history offset.');
    }
    // An unborn repository has no commits, but other Git errors must still be reported.
    const refs = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (refs.trim() !== 'true') {
        throw new Error('Open a Git working tree.');
    }
    try {
        await git(cwd, ['rev-parse', '--verify', 'HEAD']);
    } catch {
        return [];
    }
    const fields = (
        await git(cwd, [
            'log',
            '-z',
            '--max-count=100',
            `--skip=${skip}`,
            '--format=%H%x00%an%x00%aI%x00%s',
            'HEAD',
            '--'
        ])
    ).split('\0');
    const commits: GitCommitEntry[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
        commits.push({
            hash: fields[i],
            author: fields[i + 1],
            date: fields[i + 2],
            subject: fields[i + 3]
        });
    }
    return commits;
}

function commitHash(hash: string): string {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) {
        throw new Error('Invalid commit.');
    }
    return hash;
}

export async function gitCommitFiles(cwd: string, hash: string): Promise<string[]> {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return (
        await git(root, [
            'show',
            '--format=',
            '--first-parent',
            '--no-renames',
            '--name-only',
            '-z',
            commitHash(hash),
            '--'
        ])
    )
        .split('\0')
        .filter(Boolean);
}

export async function gitCommitDiff(cwd: string, hash: string, path: string): Promise<string> {
    if (!(await gitCommitFiles(cwd, hash)).includes(path)) {
        throw new Error('File is not part of this commit.');
    }
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return git(root, [
        'show',
        '--format=',
        '--first-parent',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--unified=2147483647',
        commitHash(hash),
        '--',
        path
    ]);
}

export async function gitBranches(cwd: string): Promise<GitBranchEntry[]> {
    const output = await git(cwd, [
        'for-each-ref',
        '--sort=refname',
        '--format=%(refname)%00%(HEAD)%00%(symref)',
        'refs/heads',
        'refs/remotes'
    ]);
    return output
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
            const [ref, head, symbolic] = line.split('\0');
            if (symbolic?.trim()) {
                return [];
            }
            return [
                {
                    name: ref.replace(/^refs\/(heads|remotes)\//, ''),
                    current: head === '*',
                    remote: ref.startsWith('refs/remotes/')
                }
            ];
        });
}

export async function gitSwitch(cwd: string, name: string, create: boolean): Promise<void> {
    if (!name || name.startsWith('-') || name.length > 1000) {
        throw new Error('Invalid branch name.');
    }
    if (create) {
        await git(cwd, ['check-ref-format', `refs/heads/${name}`]);
        await git(cwd, ['switch', '-c', name]);
        return;
    }
    const branches = await gitBranches(cwd);
    const branch = branches.find(
        (item) => `refs/${item.remote ? 'remotes' : 'heads'}/${item.name}` === name
    );
    if (!branch) {
        throw new Error('Branch no longer exists. Refresh the list.');
    }
    await git(
        cwd,
        branch.remote ? ['switch', '--track', name] : ['switch', '--no-guess', branch.name]
    );
}

async function git(
    cwd: string,
    args: string[],
    allowExitOne = false,
    input?: string
): Promise<string> {
    try {
        const task = exec('git', ['--no-pager', '--literal-pathspecs', ...args], {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            timeout: 60_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        if (input !== undefined) task.child.stdin?.end(input);
        const { stdout } = await task;
        return stdout;
    } catch (error) {
        const failure = error as Error & {
            code?: number | string;
            stdout?: string;
            stderr?: string;
        };
        if (allowExitOne && failure.code === 1) {
            return failure.stdout || '';
        }
        throw new Error(
            failure.code === 'ENOENT'
                ? 'Git is not installed or is not on PATH.'
                : failure.stderr?.trim() || failure.message
        );
    }
}

export async function gitIgnored(cwd: string, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const output = await git(
        cwd,
        ['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'],
        true,
        `${paths.join('\0')}\0`
    );
    return new Set(output.split('\0').filter(Boolean));
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    let branch: string;
    try {
        branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
        branch = `${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()} (detached)`;
    }
    const records = (
        await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ).split('\0');
    const changes: GitChange[] = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record) {
            continue;
        }
        const status = record.slice(0, 2);
        const path = record.slice(3);
        const original = /[RC]/.test(status) ? records[++i] : undefined;
        if (status[0] !== ' ' && status !== '??') {
            changes.push({ path, original, status: status[0], staged: true });
        }
        if (status[1] !== ' ') {
            changes.push({ path, original, status: status[1], staged: false });
        }
    }
    return { root, branch, changes };
}

async function selectedChange(
    cwd: string,
    path: string,
    staged: boolean
): Promise<{ root: string; change: GitChange }> {
    const status = await gitStatus(cwd);
    const change = status.changes.find((item) => item.path === path && item.staged === staged);
    if (!change) {
        throw new Error('This change no longer exists. Refresh the changes list.');
    }
    return { root: status.root, change };
}

export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<string> {
    const { root, change } = await selectedChange(cwd, path, staged);
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=2147483647'];
    if (change.status === '?') {
        return git(root, ['diff', ...options, '--no-index', '--', '/dev/null', change.path], true);
    }
    return git(root, [
        'diff',
        ...options,
        ...(staged ? ['--cached'] : []),
        '--',
        change.path,
        ...(change.original ? [change.original] : [])
    ]);
}

export async function gitStage(cwd: string, path: string, staged: boolean): Promise<void> {
    const { root, change } = await selectedChange(cwd, path, staged);
    const paths = [change.path, ...(change.original ? [change.original] : [])];
    if (!staged) {
        await git(root, ['add', '-A', '--', ...paths]);
        return;
    }
    let hasHead = true;
    try {
        await git(root, ['rev-parse', '--verify', 'HEAD']);
    } catch {
        hasHead = false;
    }
    await git(
        root,
        hasHead ? ['reset', 'HEAD', '--', ...paths] : ['rm', '--cached', '-f', '--', ...paths]
    );
}

export async function gitStageAll(cwd: string): Promise<void> {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    await git(root, ['add', '-A', '--', '.']);
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
    if (!message.trim() || message.length > 10_000) {
        throw new Error('Enter a commit message (up to 10,000 characters).');
    }
    const status = await gitStatus(cwd);
    if (!status.changes.some((change) => change.staged)) {
        throw new Error('Stage changes before committing.');
    }
    return git(status.root, ['commit', '-m', message.trim()]);
}
