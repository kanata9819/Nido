import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
	GitChange,
	GitStatus,
	GitCommitEntry,
	GitBranchEntry,
	GitRemoteAction,
	GitRemoteInfo,
	GitSyncState
} from '../../shared/types';
import { parseWslPath, wslHostPath } from '../../shared/wsl';
import { gitInvocation } from './gitProcess';

// Git commands for the Git panel and Git browser. Every command runs the git executable, or
// git inside WSL for a WSL workspace, and returns parsed results.
const exec = promisify(execFile);
// The preview parser needs the leading space on unchanged blank lines in a unified diff.
const diffConfig = ['-c', 'diff.suppressBlankEmpty=false'];
const knownWorkTrees = new Map<string, { config: string; root: string; checked: number }>();

/** The top folder of the repository containing `cwd`. */
export async function gitRoot(cwd: string): Promise<string> {
	const remote = parseWslPath(cwd);
	const output = await git(cwd, ['rev-parse', '--show-toplevel']);
	// Remove Git's line ending without dropping whitespace in the directory name.
	const root = output.replace(!remote && process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
	return remote ? wslHostPath(remote.distribution, root) : root;
}

/** Reuse a verified native repository root while its Git configuration stays current. */
export async function gitWorkTreeRoot(cwd: string): Promise<string> {
	if (
		parseWslPath(cwd) ||
		process.env.GIT_DIR ||
		process.env.GIT_WORK_TREE ||
		process.env.GIT_COMMON_DIR
	) {
		return gitRoot(cwd);
	}
	// Linked worktrees, nested workspace folders and non-Git folders still use Git discovery.
	const dotGit = join(cwd, '.git');
	const info = await stat(join(dotGit, 'config')).catch(() => undefined);
	if (!info?.isFile()) {
		return gitRoot(cwd);
	}
	const overrides = Object.entries(process.env).filter(([name]) =>
		name.startsWith('GIT_CONFIG_')
	);
	const environment = createHash('sha256').update(JSON.stringify(overrides)).digest('hex');
	const config = `${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}:${environment}`;
	const cached = knownWorkTrees.get(cwd);
	if (cached?.config === config && Date.now() - cached.checked < 60_000) {
		return cached.root;
	}
	const root = await gitRoot(cwd);
	knownWorkTrees.delete(cwd);
	knownWorkTrees.set(cwd, { config, root, checked: Date.now() });
	if (knownWorkTrees.size > 64) {
		knownWorkTrees.delete(knownWorkTrees.keys().next().value!);
	}
	return root;
}

/** One page and the total for `anchor` (the first page's HEAD), or the current HEAD. */
export async function gitHistory(
	cwd: string,
	skip: number,
	anchor?: string
): Promise<{ commits: GitCommitEntry[]; total: number }> {
	if (!Number.isSafeInteger(skip) || skip < 0) {
		throw new Error('Invalid history offset.');
	}
	// An unborn repository has no commits, but other Git errors must still be reported.
	const refs = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
	if (refs.trim() !== 'true') {
		throw new Error('Open a Git working tree.');
	}
	let head: string;
	if (anchor !== undefined) {
		head = commitHash(anchor);
	} else {
		try {
			head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
		} catch {
			return { commits: [], total: 0 };
		}
	}
	const [output, count] = await Promise.all([
		git(cwd, [
			'log',
			'-z',
			'--max-count=100',
			`--skip=${skip}`,
			'--format=%H%x00%an%x00%aI%x00%s',
			head,
			'--'
		]),
		git(cwd, ['rev-list', '--count', head, '--'])
	]);
	const fields = output.split('\0');
	const commits: GitCommitEntry[] = [];
	for (let i = 0; i + 3 < fields.length; i += 4) {
		commits.push({
			hash: fields[i],
			author: fields[i + 1],
			date: fields[i + 2],
			subject: fields[i + 3]
		});
	}
	return { commits, total: Number(count.trim()) };
}

/** `hash` when it is a full SHA-1 or SHA-256 commit hash; throws otherwise. */
function commitHash(hash: string): string {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) {
		throw new Error('Invalid commit.');
	}
	return hash;
}

/** Paths of the files a commit changed. */
export async function gitCommitFiles(cwd: string, hash: string): Promise<string[]> {
	const root = await gitRoot(cwd);
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

/** The diff of one file in a commit, with the whole file as context for the preview. */
export async function gitCommitDiff(cwd: string, hash: string, path: string): Promise<string> {
	if (!(await gitCommitFiles(cwd, hash)).includes(path)) {
		throw new Error('File is not part of this commit.');
	}
	const root = await gitRoot(cwd);
	return git(root, [
		...diffConfig,
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

/** Local and remote branches. Symbolic refs such as origin/HEAD are left out. */
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

/**
 * Switch branches. With `create`, `name` is a new branch name; otherwise it is the full ref of
 * an existing branch, and a remote branch is checked out as a new tracking branch.
 */
export async function gitSwitch(cwd: string, name: string, create: boolean): Promise<void> {
	if (!name || name.startsWith('-') || name.length > 1000) {
		throw new Error('Invalid branch name.');
	}
	if (create) {
		try {
			await git(cwd, ['check-ref-format', `refs/heads/${name}`]);
		} catch (error) {
			// Git rejects the name without a message; the failed command line is no help.
			throw (error as Error).message.startsWith('Git is not installed')
				? error
				: new Error('Invalid branch name.');
		}
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

/**
 * Push only the checked-out branch, to its upstream when it has one, or else to `origin`, setting
 * that as its upstream. An upstream of another name (as for a branch made from origin/main or
 * origin/develop) is not pushed to: like Git's default push, the branch is published under its
 * own name instead, so a pull request never updates the branch it was started from. Returns the
 * published branch and remote.
 */
export async function gitPushBranch(
	cwd: string,
	base?: string,
	expectedBranch?: string
): Promise<{ branch: string; remote: string }> {
	const { branch, remote, upstream } = await branchDestination(cwd);
	if (expectedBranch !== undefined && branch !== expectedBranch) {
		throw new Error('The checked-out branch changed. Reopen the GitHub panel and try again.');
	}
	if (base && branch === base) {
		throw new Error('Switch to a branch other than the base first.');
	}
	if (upstream && (!remote || !upstream.startsWith('refs/heads/'))) {
		throw new Error('Invalid branch name.');
	}
	const target = {
		branch,
		remote: remote || 'origin',
		upstream: upstream === `refs/heads/${branch}` ? upstream : ''
	};
	await pushBranch(cwd, target);
	return { branch, remote: target.remote };
}

export async function gitPushRemoteUrl(cwd: string, remote: string): Promise<string> {
	return (await git(cwd, ['remote', 'get-url', '--push', '--', remote])).trim();
}

/** Delete just this remote branch, if its tip still matches the merged commit. */
export async function gitDeleteBranchAtHead(
	cwd: string,
	remote: string,
	branch: string,
	expectedHead: string
): Promise<void> {
	const ref = `refs/heads/${branch}`;
	await git(cwd, [
		'-c',
		'credential.helper=',
		'-c',
		'credential.helper=!gh auth git-credential',
		'push',
		'--no-follow-tags',
		`--force-with-lease=${ref}:${expectedHead}`,
		'--',
		remote,
		`:${ref}`
	]);
}

async function branchDestination(cwd: string): Promise<GitRemoteInfo> {
	const branch = (await git(cwd, ['branch', '--show-current'])).trim();
	if (!branch) {
		return { branch: '', remote: '', upstream: '' };
	}
	const record = (
		await git(cwd, [
			'for-each-ref',
			'--format=%(upstream:remotename)%00%(upstream:remoteref)',
			`refs/heads/${branch}`
		])
	).trim();
	const [remote = '', upstream = ''] = record.split('\0');
	return { branch: record ? branch : '', remote, upstream };
}

async function pushBranch(cwd: string, { branch, remote, upstream }: GitRemoteInfo): Promise<void> {
	if (!branch) {
		throw new Error('Check out a branch first.');
	}
	const ref = `refs/heads/${branch}`;
	const destination = upstream
		? ['--', remote, `${ref}:${upstream}`]
		: ['--set-upstream', '--', remote, `${ref}:${ref}`];
	await git(cwd, ['push', '--no-follow-tags', ...destination]);
}

/**
 * The remote controls for this working tree. An ambiguous publishing destination stays unset.
 * A branch that tracks a remote branch of another name (such as one made from origin/main)
 * counts as unpublished: like Git's default push, Push must not update that other branch, so
 * it publishes the branch under its own name instead.
 */
export async function gitRemoteInfo(cwd: string): Promise<GitRemoteInfo | undefined> {
	const remotes = (await git(cwd, ['remote'])).trim().split(/\r?\n/).filter(Boolean);
	if (!remotes.length) {
		return undefined;
	}
	const target = await branchDestination(cwd);
	if (target.upstream && target.upstream !== `refs/heads/${target.branch}`) {
		target.upstream = '';
	}
	const remote =
		target.remote ||
		(remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '');
	const usable = !target.upstream || (target.remote && target.upstream.startsWith('refs/heads/'));
	return { ...target, remote: usable && remotes.includes(remote) ? remote : '' };
}

/**
 * How the branch of `info` compares with the remote branch it pushes to and pulls from, as of
 * the last fetch. Undefined while the branch is unpublished or its remote branch is not fetched.
 */
export async function gitSyncState(
	cwd: string,
	info: GitRemoteInfo | undefined
): Promise<GitSyncState | undefined> {
	if (!info?.branch || !info.remote || !info.upstream) {
		return undefined;
	}
	const local = `refs/heads/${info.branch}`;
	const tracking = (await git(cwd, ['for-each-ref', '--format=%(upstream)', local])).trim();
	if (!tracking.startsWith('refs/remotes/')) {
		return undefined;
	}
	let head: string;
	try {
		head = (
			await git(cwd, ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`])
		).trim();
	} catch {
		return undefined;
	}
	const [counts, outgoing] = await Promise.all([
		git(cwd, ['rev-list', '--left-right', '--count', `${local}...${head}`, '--']),
		git(cwd, ['rev-list', '--max-count=1000', `${head}..${local}`, '--'])
	]);
	const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
	return {
		upstream: tracking.replace(/^refs\/remotes\//, ''),
		head,
		ahead,
		behind,
		outgoing: outgoing.split(/\s+/).filter(Boolean)
	};
}

/** Run a remote action, returning the number of commits added to the branch by a pull. */
export async function gitRemoteAction(
	cwd: string,
	action: GitRemoteAction,
	expected: GitRemoteInfo
): Promise<number | undefined> {
	if (action === 'fetch') {
		await git(cwd, ['fetch', '--all']);
		return undefined;
	}
	const target = await gitRemoteInfo(cwd);
	if (
		!target ||
		target.branch !== expected.branch ||
		target.remote !== expected.remote ||
		target.upstream !== expected.upstream
	) {
		throw new Error('The Git branch or remote changed. Refresh and try again.');
	}
	if (!target.branch || !target.remote || (action === 'pull' && !target.upstream)) {
		throw new Error('Choose a branch with a remote first.');
	}
	if (action === 'push') {
		await pushBranch(cwd, target);
		return undefined;
	}
	const branch = `refs/heads/${target.branch}`;
	const before = (await git(cwd, ['rev-parse', '--verify', '--quiet', branch], true)).trim();
	await git(cwd, [
		'pull',
		'--ff-only',
		'--no-rebase',
		'--no-autostash',
		'--',
		target.remote,
		target.upstream
	]);
	if (before) {
		// The pull has already changed the branch. Refresh the editor even if counting fails.
		const count = await git(cwd, ['rev-list', '--count', `${before}..${branch}`, '--']).catch(
			() => undefined
		);
		return count === undefined ? undefined : Number(count.trim());
	}
	return undefined;
}

/**
 * Run git and return its stdout. Never prompts for credentials. `allowExitOne` treats exit
 * status 1 as success (git diff --no-index and check-ignore use it for "differences found" and
 * "nothing ignored"). `input` is written to git's stdin.
 */
async function git(
	cwd: string,
	args: string[],
	allowExitOne = false,
	input?: string
): Promise<string> {
	try {
		// Background reads must not compete with staging for an optional index refresh.
		// Git mutations still acquire their required locks.
		const command = gitInvocation(cwd, args);
		const task = exec(command.file, command.args, {
			...command.options,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			timeout: 60_000
		});
		if (input !== undefined) {
			// Git can exit before it has read all of its input, such as outside a repository.
			// Its exit status reports that; an unhandled pipe error would crash the app.
			task.child.stdin?.on('error', () => {});
			task.child.stdin?.end(input);
		}
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

/** The paths among `paths` that .gitignore excludes. */
export async function gitIgnored(cwd: string, paths: string[]): Promise<Set<string>> {
	if (!paths.length) {
		return new Set();
	}
	const remote = parseWslPath(cwd);
	const normalized = remote ? paths.map((path) => path.replaceAll('\\', '/')) : paths;
	const output = await git(
		cwd,
		['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'],
		true,
		`${normalized.join('\0')}\0`
	);
	const ignored = new Set(output.split('\0').filter(Boolean));
	return new Set(paths.filter((_path, index) => ignored.has(normalized[index])));
}

/**
 * The branch and changed files. A file changed both in the index and in the work tree appears
 * twice: once staged and once unstaged.
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
	return readStatus(await gitWorkTreeRoot(cwd));
}

async function readStatus(root: string, paths?: string[]): Promise<GitStatus> {
	const output = await git(root, [
		'status',
		'--porcelain=v2',
		...(!paths ? ['--branch', '--no-ahead-behind'] : []),
		'-z',
		'--untracked-files=all',
		...(paths ? ['--', ...paths] : [])
	]);
	const records = output.split('\0');
	const changes: GitChange[] = [];
	let branch = '';
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.startsWith('# branch.head ')) {
			branch = record.slice('# branch.head '.length);
			continue;
		}
		if (record.startsWith('? ')) {
			changes.push({ path: record.slice(2), status: '?', staged: false });
			continue;
		}
		// Fixed fields precede the path, which can itself contain spaces, tabs or newlines.
		const fields = /^1 /.test(record)
			? 8
			: /^2 /.test(record)
				? 9
				: /^u /.test(record)
					? 10
					: 0;
		if (!fields) {
			continue;
		}
		let start = 0;
		for (let field = 0; field < fields; field++) {
			start = record.indexOf(' ', start) + 1;
		}
		const status = record.slice(2, 4);
		const path = record.slice(start);
		const original = record[0] === '2' ? records[++i] : undefined;
		if (status[0] !== '.') {
			changes.push({
				path,
				original: /[RC]/.test(status[0]) ? original : undefined,
				status: status[0],
				staged: true
			});
		}
		if (status[1] !== '.') {
			// The second path belongs to the side that renamed/copied the file. Later
			// edits at its new name must not stage the old name as well.
			changes.push({
				path,
				original: /[RC]/.test(status[1]) ? original : undefined,
				status: status[1],
				staged: false
			});
		}
	}
	if (branch === '(detached)') {
		// Porcelain also prints this sentinel for a branch literally named "(detached)".
		branch = await git(root, ['symbolic-ref', '--short', 'HEAD']).then(
			(value) => value.trim(),
			async () => `${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()} (detached)`
		);
	}
	return { root, branch, changes };
}

/** The change for `path` on the chosen side; throws when it is gone since the list was shown. */
async function selectedChange(
	cwd: string,
	path: string,
	staged: boolean,
	recent?: GitStatus
): Promise<{ root: string; change: GitChange }> {
	const root = await (recent ? gitWorkTreeRoot(cwd) : gitRoot(cwd));
	const find = ({ changes }: GitStatus): GitChange | undefined =>
		changes.find((item) => item.path === path && item.staged === staged);
	const previous = recent?.root === root ? find(recent) : undefined;
	// A recent list supplies both sides of a rename. Refresh just those paths for previews;
	// fall back to the full status if the selected entry has changed since the list was read.
	const scoped = previous
		? find(await readStatus(root, previous.original ? [path, previous.original] : [path]))
		: undefined;
	const change =
		scoped && scoped.status === previous?.status && scoped.original === previous.original
			? scoped
			: find(await readStatus(root));
	if (!change) {
		throw new Error('This change no longer exists. Refresh the changes list.');
	}
	return { root, change };
}

/** The diff of one change, with the whole file as context. Untracked files diff against nothing. */
export async function gitDiff(
	cwd: string,
	path: string,
	staged: boolean,
	recent?: GitStatus
): Promise<string> {
	const { root, change } = await selectedChange(cwd, path, staged, recent);
	const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=2147483647'];
	if (change.status === '?') {
		return git(
			root,
			[...diffConfig, 'diff', ...options, '--no-index', '--', '/dev/null', change.path],
			true
		);
	}
	return git(root, [
		...diffConfig,
		'diff',
		...options,
		...(staged ? ['--cached'] : []),
		'--',
		change.path,
		...(change.original ? [change.original] : [])
	]);
}

/**
 * Stage an unstaged change, or unstage a staged one (`staged` true). Before the first commit
 * there is no HEAD to reset to, so unstaging removes the file from the index instead.
 */
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

/** Stage every change in the repository. */
export async function gitStageAll(cwd: string): Promise<void> {
	const root = await gitRoot(cwd);
	await git(root, ['add', '-A', '--', '.']);
}

/** Commit the staged changes and return git's output. */
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
