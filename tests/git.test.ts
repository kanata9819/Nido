import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatus, gitStage, gitDiff, gitCommit } from '../src/main/git';

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
