import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitStatus,
  gitStage,
  gitDiff,
  gitCommit,
  gitHistory,
  gitCommitFiles,
  gitCommitDiff,
  gitBranches,
  gitSwitch
} from '../src/main/git';

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
    await writeFile(join(root, '日本語.txt'), 'initial\n');
    git('add', '.');
    git('commit', '-m', 'Initial subject');
    const initial = (await gitHistory(root, 0))[0];
    assert.equal(initial.subject, 'Initial subject');
    assert.deepEqual(await gitCommitFiles(root, initial.hash), ['日本語.txt']);
    assert.match(await gitCommitDiff(root, initial.hash, '日本語.txt'), /\+initial/);
    await gitSwitch(root, 'feature', true);
    await writeFile(join(root, '日本語.txt'), 'feature\n');
    git('commit', '-am', 'Feature subject');
    assert.equal((await gitHistory(root, 1))[0].hash, initial.hash);
    assert.ok((await gitBranches(root)).some((branch) => branch.name === 'feature' && branch.current));
    await gitSwitch(root, 'refs/heads/main', false);
    await writeFile(join(root, '日本語.txt'), 'unsaved work on disk\n');
    await assert.rejects(gitSwitch(root, 'refs/heads/feature', false), /overwritten/);
    assert.equal(await readFile(join(root, '日本語.txt'), 'utf8'), 'unsaved work on disk\n');
    await writeFile(join(root, '日本語.txt'), 'initial\n');
    git('merge', '--no-ff', 'feature', '-m', 'Merge feature');
    const merge = (await gitHistory(root, 0))[0];
    assert.match(await gitCommitDiff(root, merge.hash, '日本語.txt'), /\+feature/);
    git('update-ref', 'refs/remotes/origin/remote-test', 'HEAD');
    git('config', 'remote.origin.url', root);
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    assert.ok((await gitBranches(root)).some((branch) => branch.remote && branch.name === 'origin/remote-test'));
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
    assert.equal(status.changes.find((change) => change.path === 'renamed.txt')?.original, '[日本語].txt');
    await gitStage(root, 'renamed.txt', true);
    assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'fourth\n');
    await assert.rejects(gitCommit(root, ''), /Enter a commit message/);
    await assert.rejects(gitCommit(root, 'Nothing staged'), /Stage changes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
