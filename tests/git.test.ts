import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitDiff } from '../src/renderer/src/gitDiff';
import {
    gitStatus,
    gitStage,
    gitStageAll,
    gitDiff,
    gitCommit,
    gitHistory,
    gitCommitFiles,
    gitCommitDiff,
    gitBranches,
    gitSwitch,
    gitIgnored
} from '../src/main/git';

test('stage all includes the whole repository, deletions and literal names but excludes ignored files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-stage-all-'));
    const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    try {
        git('init', '-q');
        git('config', 'user.name', 'Nido Test');
        git('config', 'user.email', 'nido@example.test');
        git('config', 'commit.gpgsign', 'false');
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, '.gitignore'), 'ignored.log\n');
        await writeFile(join(root, 'deleted.txt'), 'delete me\n');
        await writeFile(join(root, 'modified.txt'), 'before\n');
        git('add', '.');
        git('commit', '-qm', 'Initial');
        await rm(join(root, 'deleted.txt'));
        await writeFile(join(root, 'modified.txt'), 'staged version\n');
        await gitStage(root, 'modified.txt', false);
        await writeFile(join(root, 'modified.txt'), 'latest version\n');
        await writeFile(join(root, '[日本語].txt'), 'literal\n');
        await writeFile(join(root, 'nested/new.txt'), 'new\n');
        await writeFile(join(root, 'ignored.log'), 'ignored\n');
        await gitStageAll(join(root, 'nested'));
        const status = await gitStatus(root);
        assert.equal(status.changes.length, 4);
        assert.ok(status.changes.every((change) => change.staged));
        assert.equal(git('show', ':modified.txt'), 'latest version\n');
        assert.ok(
            status.changes.some((change) => change.path === 'deleted.txt' && change.status === 'D')
        );
        assert.ok(status.changes.some((change) => change.path === '[日本語].txt'));
        assert.ok(!git('ls-files').includes('ignored.log'));
        assert.equal(git('log', '--format=%s', '-1').trim(), 'Initial');
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('ignore decorations follow Git rules, exceptions and tracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-ignore-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: root });
        await mkdir(join(root, 'build'));
        await writeFile(join(root, 'tracked.log'), 'tracked\n');
        execFileSync('git', ['add', 'tracked.log'], { cwd: root });
        await writeFile(join(root, '.gitignore'), 'build/\n*.log\n!keep.log\n');
        await writeFile(join(root, 'build', 'output.txt'), 'generated\n');
        await writeFile(join(root, 'debug.log'), 'ignored\n');
        await writeFile(join(root, 'keep.log'), 'kept\n');
        assert.deepEqual(
            await gitIgnored(root, [
                'build',
                'build/output.txt',
                'debug.log',
                'keep.log',
                'tracked.log',
                '.gitignore'
            ]),
            new Set(['build', 'build/output.txt', 'debug.log'])
        );
        assert.deepEqual(await gitIgnored(root, ['keep.log', 'tracked.log']), new Set());
        assert.deepEqual(await gitIgnored(root, []), new Set());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('side-by-side diffs align replacements, additions, deletions and source line numbers', () => {
    const rows = splitDiff(
        'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,4 +1,5 @@\n context\n-old\n+new\n+extra\n tail\n-last\n+end\n+final\n\\ No newline at end of file\n'
    );
    assert.deepEqual(
        rows.map((row) => [row.before?.text, row.after?.text]),
        [
            ['context', 'context'],
            ['old', 'new'],
            [undefined, 'extra'],
            ['tail', 'tail'],
            ['last', 'end'],
            [undefined, 'final']
        ]
    );
    assert.deepEqual(
        rows.map((row) => [row.before?.number, row.after?.number]),
        [
            [1, 1],
            [2, 2],
            [undefined, 3],
            [3, 4],
            [4, 5],
            [undefined, 6]
        ]
    );
    assert.equal(rows[0].before?.changed, undefined);
    assert.equal(rows[1].before?.changed, true);
    assert.deepEqual(splitDiff('@@ -0,0 +1 @@\n+new\n')[0].after, {
        number: 1,
        text: 'new',
        changed: true
    });
    assert.deepEqual(splitDiff('@@ -9 +8,0 @@\n-old\n')[0].before, {
        number: 9,
        text: 'old',
        changed: true
    });
    assert.equal(
        splitDiff('Binary files a/file and b/file differ')[0].heading,
        'Binary files a/file and b/file differ'
    );
});

test('history, first-parent diffs and branch switches preserve conflicting edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-history-'));
    const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    try {
        git('init', '-b', 'main');
        git('config', 'core.autocrlf', 'false');
        git('config', 'user.name', 'Nido Test');
        git('config', 'user.email', 'test@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        assert.deepEqual(await gitHistory(root, 0), []);
        const context = Array.from({ length: 12 }, (_, i) => `context ${i}\n`).join('');
        const initialSource = `initial\n${context}`;
        await writeFile(join(root, '日本語.txt'), initialSource);
        git('add', '.');
        git('commit', '-m', 'Initial subject');
        const initial = (await gitHistory(root, 0))[0];
        assert.equal(initial.subject, 'Initial subject');
        assert.deepEqual(await gitCommitFiles(root, initial.hash), ['日本語.txt']);
        assert.match(await gitCommitDiff(root, initial.hash, '日本語.txt'), /\+initial/);
        await gitSwitch(root, 'feature', true);
        await writeFile(join(root, '日本語.txt'), `feature\n${context}`);
        git('commit', '-am', 'Feature subject');
        assert.equal((await gitHistory(root, 1))[0].hash, initial.hash);
        assert.ok(
            (await gitBranches(root)).some((branch) => branch.name === 'feature' && branch.current)
        );
        await gitSwitch(root, 'refs/heads/main', false);
        await writeFile(join(root, '日本語.txt'), 'unsaved work on disk\n');
        await assert.rejects(gitSwitch(root, 'refs/heads/feature', false), /overwritten/);
        assert.equal(await readFile(join(root, '日本語.txt'), 'utf8'), 'unsaved work on disk\n');
        await writeFile(join(root, '日本語.txt'), initialSource);
        git('merge', '--no-ff', 'feature', '-m', 'Merge feature');
        const merge = (await gitHistory(root, 0))[0];
        assert.match(await gitCommitDiff(root, merge.hash, '日本語.txt'), /\+feature/);
        assert.match(await gitCommitDiff(root, merge.hash, '日本語.txt'), / context 11/);
        await writeFile(join(root, '日本語.txt'), `working\n${context}`);
        assert.match(await gitDiff(root, '日本語.txt', false), / context 11/);
        await gitStage(root, '日本語.txt', false);
        assert.match(await gitDiff(root, '日本語.txt', true), / context 11/);
        git('reset', '--hard', 'HEAD');
        git('update-ref', 'refs/remotes/origin/remote-test', 'HEAD');
        git('config', 'remote.origin.url', root);
        git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
        assert.ok(
            (await gitBranches(root)).some(
                (branch) => branch.remote && branch.name === 'origin/remote-test'
            )
        );
        await gitSwitch(root, 'refs/remotes/origin/remote-test', false);
        assert.equal((await gitStatus(root)).branch, 'remote-test');
        await assert.rejects(gitSwitch(root, '--discard-changes', true), /Invalid/);
        await assert.rejects(gitSwitch(root, '@{-1}', true));
        await assert.rejects(gitCommitDiff(root, initial.hash, '../outside'));
        await assert.rejects(gitCommitFiles(root, '--all'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('Git stages literal paths, preserves working changes and commits only the index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-git-'));
    const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    try {
        git('init');
        git('config', 'user.name', 'Nido Test');
        git('config', 'user.email', 'nido-test@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, '[日本語].txt'), 'first\n');
        await writeFile(join(root, 'other.txt'), 'untouched\n');
        assert.match(await gitDiff(root, '[日本語].txt', false), /\+first/);
        await assert.rejects(gitStage(root, '*', false), /no longer exists/);
        await gitStage(root, '[日本語].txt', false);
        await writeFile(join(root, '[日本語].txt'), 'second\n');
        await gitStage(root, '[日本語].txt', true);
        assert.equal(await readFile(join(root, '[日本語].txt'), 'utf8'), 'second\n');
        await gitStage(root, '[日本語].txt', false);
        await gitCommit(root, 'Initial');
        assert.equal(git('ls-files', '-z'), '[日本語].txt\0');
        await writeFile(join(root, '[日本語].txt'), 'third\n');
        await gitStage(root, '[日本語].txt', false);
        await writeFile(join(root, '[日本語].txt'), 'fourth\n');
        assert.match(await gitDiff(root, '[日本語].txt', true), /\+third/);
        assert.match(await gitDiff(root, '[日本語].txt', false), /\+fourth/);
        await gitStage(root, '[日本語].txt', true);
        assert.equal(await readFile(join(root, '[日本語].txt'), 'utf8'), 'fourth\n');
        await gitStage(root, '[日本語].txt', false);
        await gitCommit(root, 'Update');
        await rename(join(root, '[日本語].txt'), join(root, 'renamed.txt'));
        git('add', '-A', '--', '[日本語].txt', 'renamed.txt');
        const status = await gitStatus(join(root, 'nested'));
        assert.equal(
            status.changes.find((change) => change.path === 'renamed.txt')?.original,
            '[日本語].txt'
        );
        await gitStage(root, 'renamed.txt', true);
        assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'fourth\n');
        await assert.rejects(gitCommit(root, ''), /Enter a commit message/);
        await assert.rejects(gitCommit(root, 'Nothing staged'), /Stage changes/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});