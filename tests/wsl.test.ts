import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editorPath, hostPath, parseWslPath, wslHostPath } from '../src/shared/wsl';
import { decodeWslOutput, resolveWslFolder, wslArguments, wslDistributions } from '../src/main/wsl';
import { workspaceRelative } from '../src/main/workspacePaths';
import { SessionEvents } from '../src/main/sessionEvents';
import { Session } from '../src/main/session';
import { LocalHistory } from '../src/main/localHistory';
import { HistoryService } from '../src/main/historyService';
import { gitIgnored, gitStatus } from '../src/main/git';
import { gitFileKey } from '../src/renderer/src/fileDecorations';
import type { NidoEvent } from '../src/shared/types';

const exec = promisify(execFile);
const distribution = process.env.NIDO_TEST_WSL_DISTRO;

test('WSL shares preserve Linux case and convert both Windows share aliases', () => {
  const root = wslHostPath('Fedora', '/home/me/Project');
  assert.deepEqual(parseWslPath('\\\\wsl$\\Fedora\\home\\me\\Project'), {
    distribution: 'Fedora',
    path: '/home/me/Project'
  });
  assert.equal(editorPath(root, `${root}\\日本語 notes.txt`), '/home/me/Project/日本語 notes.txt');
  assert.equal(hostPath(root, '/home/me/Project/A.txt'), `${root}\\A.txt`);
  assert.equal(hostPath(root, 'deno:asset/lib.deno.d.ts'), 'deno:asset/lib.deno.d.ts');
  assert.notEqual(workspaceRelative(root, wslHostPath('Fedora', '/home/me/project')), '');
  assert.notEqual(gitFileKey(`${root}\\A.txt`), gitFileKey(`${root}\\a.txt`));
  assert.throws(() => editorPath(root, wslHostPath('Ubuntu', '/tmp/file')), /another WSL/);
  assert.throws(() => wslHostPath('Fedora', '../outside'), /absolute Linux/);
  assert.throws(() => wslHostPath('Fedora\\other', '/tmp'), /distribution/);
});

test('WSL command arguments preserve literal paths and decode Windows UTF-16 output', () => {
  const path = '/home/me/a b; $(touch unexpected)';
  assert.deepEqual(wslArguments('Fedora', path, ['git', 'status']), [
    '--distribution',
    'Fedora',
    '--cd',
    path,
    '--exec',
    'git',
    'status'
  ]);
  assert.equal(
    decodeWslOutput(Buffer.from('\uFEFFFedora\r\nUbuntu\r\n', 'utf16le')),
    'Fedora\r\nUbuntu'
  );
  assert.equal(decodeWslOutput(Buffer.from('/home/me/日本語\n')), '/home/me/日本語');
  assert.throws(() => wslArguments('--exec', '/', ['sh']), /Invalid WSL/);
});

test('remote notifications publish host paths for buffers, diagnostics and references', () => {
  const root = wslHostPath('Fedora', '/project');
  const received: NidoEvent[] = [];
  const events = new SessionEvents(
    'wsl',
    (event) => received.push(event),
    (path) => hostPath(root, path)
  );
  events.receiveNotification('nido:state', [
    {
      buffers: [{ id: 1, name: '/project/main.ts', modified: false }],
      diagnostics: { '/project/main.ts': 1 },
      problems: [{ path: '/project/main.ts', line: 1 }]
    }
  ]);
  assert.equal(events.state.buffers[0].name, `${root}\\main.ts`);
  assert.equal(events.state.diagnostics?.[`${root}\\main.ts`], 1);
  assert.equal(events.state.problems?.[0].path, `${root}\\main.ts`);
  events.receiveNotification('nido:references', [{ items: [{ path: '/project/main.ts' }] }]);
  assert.equal(events.state.references?.items[0].path, `${root}\\main.ts`);
  assert.ok(received.some((event) => event.type === 'state'));
});

test('Time Machine separates case-sensitive Linux files and shares aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nido-wsl-history-'));
  try {
    const history = new LocalHistory(directory);
    const root = wslHostPath('Fedora', '/project');
    const content = { text: 'upper\n', endOfLine: true, fileformat: 'unix' as const };
    await history.record(`${root}\\A.txt`, content, 'saved');
    await history.record(`${root}\\a.txt`, { ...content, text: 'lower\n' }, 'saved');
    assert.equal((await history.list(`${root}\\A.txt`)).length, 1);
    const alias = '\\\\wsl$\\Fedora\\project\\A.txt';
    const versions = await history.list(alias);
    assert.equal((await history.version(alias, versions[0].id)).text, 'upper\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'WSL edits, saves, searches, restores and opens a native Linux terminal',
  {
    skip: !distribution && 'Set NIDO_TEST_WSL_DISTRO to run against an installed distribution.',
    timeout: 180000
  },
  async () => {
    const distro = distribution!;
    assert.ok((await wslDistributions()).includes(distro));
    const { stdout } = await exec(
      'wsl.exe',
      wslArguments(distro, '~', ['mktemp', '-d', '/tmp/nido-wsl-test-XXXXXXXX']),
      { windowsHide: true }
    );
    const linuxRoot = stdout.trim();
    assert.match(linuxRoot, /^\/tmp\/nido-wsl-test-[A-Za-z0-9]+$/);
    const root = wslHostPath(distro, linuxRoot);
    const historyDirectory = await mkdtemp(join(tmpdir(), 'nido-wsl-integration-'));
    let session: Session | undefined;
    const errors: string[] = [];
    try {
      await writeFile(join(root, '日本語 notes.txt'), 'original\nsecond\n');
      await writeFile(join(root, 'ignored.txt'), 'ignored\n');
      await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
      await exec('wsl.exe', wslArguments(distro, linuxRoot, ['git', 'init', '-q']), {
        windowsHide: true
      });
      assert.equal(await resolveWslFolder(distro, linuxRoot), root);
      await assert.rejects(resolveWslFolder(distro, `${linuxRoot}/missing`), /WSL/);
      session = await Session.create(root, (event) => {
        if (event.type === 'error') errors.push(event.message);
      });
      assert.equal(session.workspace.wsl, distro);
      assert.equal(await session.client.request('nvim_eval', ["has('win32')"]), 0);
      assert.equal(await session.client.request('nvim_eval', ['getcwd()']), linuxRoot);
      assert.ok((await session.files('')).some((file) => file.name === '日本語 notes.txt'));
      assert.equal(
        (await session.files('')).find((file) => file.name === 'ignored.txt')?.ignored,
        true
      );
      assert.ok((await gitIgnored(root, ['ignored.txt'])).has('ignored.txt'));
      await session.openFile('日本語 notes.txt');
      const history = new HistoryService(new LocalHistory(historyDirectory));
      const before = await history.list(session);
      await session.input('ggIWSL: <Esc>');
      await session.save();
      assert.equal(
        await readFile(join(root, '日本語 notes.txt'), 'utf8'),
        'WSL: original\nsecond\n'
      );
      assert.ok(
        (await session.findFiles('notes')).some((file) => file.name === '日本語 notes.txt')
      );
      assert.equal((await session.searchText('WSL: original')).matches.length, 1);
      assert.ok(
        (await gitStatus(root)).changes.some((change) => change.path === '日本語 notes.txt')
      );
      await session.fileAction('createDirectory', 'nested', '', async () => {});
      await session.fileAction('createFile', 'nested/new.txt', '', async () => {});
      await session.openFile('nested/new.txt');
      await session.input('iLinux file<Esc>');
      await assert.rejects(
        session.fileAction('rename', 'nested/new.txt', 'nested/renamed.txt', async () => {}),
        /unsaved/
      );
      await session.save();
      await session.fileAction('rename', 'nested/new.txt', 'nested/renamed.txt', async () => {});
      assert.equal(await readFile(join(root, 'nested/renamed.txt'), 'utf8'), 'Linux file\n');
      await writeFile(join(root, 'Case.txt'), 'upper\n');
      await writeFile(join(root, 'case.txt'), 'lower\n');
      await session.openFile('Case.txt');
      assert.equal(await session.client.request('nvim_get_current_line', []), 'upper');
      await session.openFile('case.txt');
      assert.equal(await session.client.request('nvim_get_current_line', []), 'lower');
      await exec('wsl.exe', wslArguments(distro, linuxRoot, ['ln', '-s', '/etc', 'escape']), {
        windowsHide: true
      });
      try {
        await assert.rejects(session.path('escape/passwd'), /outside this workspace|ENOENT|EINVAL/);
      } finally {
        await exec('wsl.exe', wslArguments(distro, linuxRoot, ['unlink', 'escape']), {
          windowsHide: true
        });
      }
      await writeFile(join(root, 'main.ts'), 'const total: number = "wrong";\n');
      await session.openFile('main.ts');
      assert.equal(
        await session.client.request('nvim_exec_lua', [
          'return vim.wait(20000, function() return #vim.lsp.get_clients({bufnr=0, name="typescript"}) > 0 and #vim.diagnostic.get(0, {severity=vim.diagnostic.severity.ERROR}) > 0 end, 50)',
          []
        ]),
        true,
        'The Linux TypeScript language server must publish diagnostics.'
      );
      await session.openFile('日本語 notes.txt');
      const snapshot = await session.snapshot();
      assert.equal(snapshot.current, join(root, '日本語 notes.txt'));
      assert.ok(snapshot.files.every((file) => parseWslPath(file.path)));
      const preview = await history.preview(session, before.path, before.versions[0].id);
      assert.equal(
        await history.restore(session, before.path, before.versions[0].id, preview.token),
        true
      );
      assert.equal(await session.client.request('nvim_get_current_line', []), 'original');
      await session.save();
      const terminal = await session.openTerminal('pwsh');
      await terminal.input(`printf 'NIDO_TERMINAL:%s\\n' "$PWD"<CR>`);
      assert.equal(
        await terminal.client.request('nvim_exec_lua', [
          'return vim.wait(10000, function() return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n"):find("NIDO_TERMINAL:" .. vim.fn.getcwd(), 1, true) ~= nil end, 20)',
          []
        ]),
        true
      );
      await session.stop();
      session = await Session.create(root, () => {});
      assert.deepEqual(await session.restore({ ...snapshot, terminal: false }), []);
      assert.equal(
        await session.client.request('nvim_eval', ["expand('%:p')"]),
        `${linuxRoot}/日本語 notes.txt`
      );
      assert.deepEqual(errors, []);
    } finally {
      await session?.stop();
      // The only remote directory removed is the exact fixture returned by mktemp above.
      assert.match(parseWslPath(root)!.path, /^\/tmp\/nido-wsl-test-[A-Za-z0-9]+$/);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(historyDirectory, { recursive: true, force: true });
    }
  }
);
