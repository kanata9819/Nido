import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChange, GitStatus } from '../shared/types';

const exec = promisify(execFile);

async function git(cwd: string, args: string[], diff = false): Promise<string> {
  try {
    const { stdout } = await exec('git', ['--no-pager', '--literal-pathspecs', ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout;
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (diff && failure.code === 1) {
      return failure.stdout || '';
    }
    throw new Error(
      failure.code === 'ENOENT' ? 'Git is not installed or is not on PATH.' : failure.stderr?.trim() || failure.message
    );
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  let branch: string;
  try {
    branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    branch = `${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()} (detached)`;
  }
  const records = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
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
  const options = ['--no-ext-diff', '--no-textconv', '--no-color'];
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
  await git(root, hasHead ? ['reset', 'HEAD', '--', ...paths] : ['rm', '--cached', '-f', '--', ...paths]);
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
