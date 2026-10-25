import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Session } from '../src/main/session';
import { discoverLanguagePacks } from '../src/main/languagePacks';
import { wslArguments } from '../src/main/wsl';
import { wslHostPath } from '../src/shared/wsl';

test(
  'WSL packs resolve Linux commands, provide diagnostics and toggle without losing edits',
  {
    skip: !process.env.NIDO_TEST_WSL_DISTRO,
    timeout: 60000
  },
  async () => {
    const distro = process.env.NIDO_TEST_WSL_DISTRO!;
    const exec = promisify(execFile);
    const { stdout } = await exec(
      'wsl.exe',
      wslArguments(distro, '~', ['mktemp', '-d', '/tmp/nido-pack-wsl-XXXXXXXX']),
      { windowsHide: true }
    );
    const linuxRoot = stdout.trim();
    assert.match(linuxRoot, /^\/tmp\/nido-pack-wsl-[A-Za-z0-9]+$/);
    const root = wslHostPath(distro, linuxRoot);
    const messages: string[] = [];
    let session: Session | undefined;
    try {
      await writeFile(join(root, 'main.py'), 'hello\n');
      await writeFile(
        join(root, 'server.mjs'),
        await readFile(resolve('tests/fixtures/language-pack-server.mjs'))
      );
      const config = await discoverLanguagePacks(resolve('resources'));
      config.packs.push({
        schemaVersion: 1,
        id: 'python-wsl',
        title: 'Python WSL',
        version: '1.0.0',
        description: 'Linux integration fixture',
        filetypes: ['python'],
        serverName: 'python_wsl',
        bundled: false,
        commands: {
          win32: ['nido-no-windows-command'],
          linux: ['${node}', `${linuxRoot}/server.mjs`]
        }
      });
      try {
        session = await Session.create(
          root,
          (event) => {
            if (event.type === 'error' || event.type === 'notification')
              messages.push(event.message);
          },
          resolve('resources'),
          config
        );
      } catch (error) {
        throw new Error(`${String(error)}\n${messages.join('\n')}`);
      }
      await session.openFile('main.py');
      assert.equal(
        await session.client.request('nvim_exec_lua', [
          'return vim.wait(5000, function() return #vim.diagnostic.get(0) == 1 end, 20)',
          []
        ]),
        true,
        messages.join('\n')
      );
      assert.equal(
        (await session.languagePacks()).find((pack) => pack.id === 'python-wsl')?.status,
        'running'
      );
      await session.input('ggIedited <Esc>');
      await session.reloadLanguagePacks({ ...config, disabled: ['python-wsl'] });
      await session.save();
      assert.equal(await readFile(join(root, 'main.py'), 'utf8'), 'edited hello\n');
      assert.equal(
        (await session.languagePacks()).find((pack) => pack.id === 'python-wsl')?.status,
        'disabled'
      );
      await writeFile(join(root, 'main.ts'), 'const total: number = "wrong";\n');
      await session.openFile('main.ts');
      assert.equal(
        await session.client.request('nvim_exec_lua', [
          'return vim.wait(20000, function() return #vim.diagnostic.get(0, {severity=vim.diagnostic.severity.ERROR}) > 0 end, 50)',
          []
        ]),
        true
      );
    } finally {
      await session?.stop();
      const { readdir, unlink, rmdir } = await import('node:fs/promises');
      for (const file of await readdir(root)) await unlink(join(root, file));
      await rmdir(root);
    }
  }
);
