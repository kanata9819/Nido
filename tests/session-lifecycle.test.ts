import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import type { NidoEvent } from '../src/shared/types';
import { SessionFiles } from '../src/main/sessionFiles';

async function referenceTo(session: Session, path: string, line = 1): Promise<void> {
  await session.client.request('nvim_exec_lua', [
    `local target, line = ...
local original = vim.lsp.get_clients
vim.lsp.get_clients = function(options)
  if options and options.method == 'textDocument/references' then
    return {{offset_encoding='utf-16', request=function(_, _, _, callback)
      callback(nil, {{uri=vim.uri_from_fname(target), range={start={line=line,character=0}, ['end']={line=line,character=1}}}})
      return true, 1
    end}}
  end
  return original(options)
end
require('nido_references').find()
vim.lsp.get_clients = original`,
    [path, line - 1]
  ]);
  await session.client.request('nvim_eval', ['1']);
  assert.equal(session.state.references?.items.length, 1);
}

for (const navigation of ['selectBuffer', 'openFile', 'openReference', 'openProblem'] as const) {
  test(`${navigation} cannot redirect pending input or line-ending changes into another file`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-tab-input-order-'));
    let session: Session | undefined;
    let release!: (text: string) => void;
    const contents = new Promise<string>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await writeFile(join(root, 'first.txt'), 'first\n');
      await writeFile(join(root, 'second.txt'), 'second\n');
      session = await Session.create(root, () => {});
      await session.openFile('second.txt');
      const second = (await session.client.request('nvim_get_current_buf', [])) as number;
      if (navigation === 'openProblem') {
        await session.client.request('nvim_exec_lua', [
          "vim.diagnostic.set(vim.api.nvim_create_namespace('navigation-fixture'), 0, {{lnum=0,col=0,severity=1,message='Fixture diagnostic'}})",
          []
        ]);
        await session.client.request('nvim_eval', ['1']);
      }
      await session.openFile('first.txt');
      if (navigation === 'openReference') {
        await referenceTo(session, join(root, 'second.txt'));
      }
      await session.input('i');
      await session.inputMode();
      const pasting = session.paste(() => {
        entered();
        return contents;
      });
      await reading;
      const switching =
        navigation === 'selectBuffer'
          ? session.selectBuffer(second)
          : navigation === 'openFile'
            ? session.openFile('second.txt')
            : navigation === 'openReference'
              ? session.openReference(1, session.state.references!.version)
              : session.openProblem(1, session.state.diagnosticsVersion!);
      const converting = session.setLineEnding('CRLF');
      await session.client.request('nvim_eval', ['1']);
      release('日本語<clipboard>');
      await Promise.all([pasting, switching, converting]);
      await session.input('<Esc>');
      await session.saveAll();
      assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), '日本語<clipboard>first\n');
      assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second\r\n');
      await assert.rejects(session.selectBuffer(1000000), /Invalid buffer/);
      await session.input('A!<Esc>');
      await session.save();
      assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'second!\r\n');
    } finally {
      release('');
      await session?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const inspection of ['modified', 'bufferModified', 'closeBuffer', 'fileAction'] as const) {
  test(`${inspection} accounts for input already waiting on the clipboard`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-close-input-order-'));
    let session: Session | undefined;
    let release!: (text: string) => void;
    const contents = new Promise<string>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await writeFile(join(root, 'first.txt'), 'first\n');
      session = await Session.create(root, () => {});
      await session.openFile('first.txt');
      const buffer = (await session.client.request('nvim_get_current_buf', [])) as number;
      const pasting = session.paste(() => {
        entered();
        return contents;
      });
      await reading;
      const checking =
        inspection === 'closeBuffer'
          ? assert.rejects(session.closeBuffer(buffer), /modified|changes/i)
          : inspection === 'fileAction'
            ? assert.rejects(
                session.fileAction('delete', 'first.txt', '', (file) =>
                  rename(file, join(root, 'trashed.txt'))
                ),
                /unsaved changes/i
              )
            : inspection === 'modified'
              ? session.modified()
              : session.bufferModified(buffer);
      void checking.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 80));
      await session.client.request('nvim_eval', ['1']);
      release('日本語<clipboard>');
      await pasting;
      const result = await checking;
      if (inspection === 'modified' || inspection === 'bufferModified') assert.equal(result, true);
      assert.equal(
        await session.client.request('nvim_get_option_value', ['modified', { buf: buffer }]),
        true
      );
      assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first\n');
      await session.save();
      assert.match(await readFile(join(root, 'first.txt'), 'utf8'), /日本語<clipboard>/);
    } finally {
      release('');
      await session?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('reopening the active edited file preserves its draft, cursor and undo history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-reopen-draft-'));
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'first.txt'), 'first\n');
    session = await Session.create(root, () => {});
    await session.openFile('first.txt');
    await session.input('A draft<Esc>');
    await session.inputMode();
    const cursor = await session.client.request('nvim_win_get_cursor', [0]);
    await session.openFile('first.txt');
    assert.equal(await session.client.request('nvim_get_current_line', []), 'first draft');
    assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), cursor);
    assert.equal(await session.modified(), true);
    await session.input('u');
    await session.save();
    assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), 'first\n');
    await writeFile(join(root, 'first.txt'), 'changed outside Nido\n');
    await session.openFile('first.txt');
    assert.equal(await session.client.request('nvim_get_current_line', []), 'changed outside Nido');
    assert.equal(await session.modified(), false);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('reference jumps retain their target after detached touchpad scrolling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-reference-scroll-'));
  let session: Session | undefined;
  try {
    const source = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    await writeFile(join(root, 'first.txt'), source);
    session = await Session.create(root, () => {});
    await session.attach(80, 25);
    await session.openFile('first.txt');
    await referenceTo(session, join(root, 'first.txt'), 80);
    await session.input('10G0');
    await session.inputMode();
    await session.scroll(15.5, false, true);
    await session.openReference(1, session.state.references!.version);
    assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [80, 0]);
    await session.input('ix<Esc>');
    await session.save();
    assert.equal(
      await readFile(join(root, 'first.txt'), 'utf8'),
      source.replace('line 80\n', 'xline 80\n')
    );
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'pending Vim commands cannot trap tab operations or the following Escape key',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-pending-editor-command-'));
    let session: Session | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeFile(join(root, 'first.txt'), 'first\n');
      session = await Session.create(root, () => {});
      await session.openFile('first.txt');
      const current = session;
      const buffer = (await current.client.request('nvim_exec_lua', [
        'return vim.api.nvim_get_current_buf()',
        []
      ])) as number;
      const operations = [
        () => current.selectBuffer(buffer),
        () => current.openFile('first.txt'),
        () => current.modified(),
        () => current.bufferModified(buffer),
        () => current.closeBuffer(buffer),
        () => current.setLineEnding('CRLF'),
        () => current.openReference(1, 1),
        () => current.openProblem(1, 1),
        () => current.openSymbol(1, 1)
      ];
      for (const keys of ['r', 'f', 'g']) {
        for (const operation of operations) {
          const input = current.input(keys);
          const rejected = assert.rejects(operation(), /Finish the current Neovim command/);
          const escaping = current.input('<Esc>');
          await Promise.race([
            Promise.all([input, rejected, escaping]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('A pending Vim command trapped editor input.')),
                2000
              );
            })
          ]);
          clearTimeout(timer);
          assert.equal(await current.inputMode(), 'n');
        }
      }
      await current.input('R');
      await current.selectBuffer(buffer);
      await current.input('<Esc>');
      assert.equal(await current.modified(), false);
    } finally {
      clearTimeout(timer);
      await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
      await session?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('closing a workspace cancels in-flight filesystem searches', { timeout: 15000 }, async () => {
  const session = await Session.create(process.cwd(), () => {});
  const files = SessionFiles.prototype.files;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    SessionFiles.prototype.files = async () => {
      entered();
      await gate;
      return [{ name: 'late.txt', path: 'late.txt', directory: false }];
    };
    const searching = session.findFiles('late');
    await started;
    await session.stop();
    release();
    assert.deepEqual(await searching, []);
  } finally {
    release();
    SessionFiles.prototype.files = files;
    await session.stop();
  }
});

test(
  'closing during terminal creation waits for child cleanup and rejects later opens',
  { timeout: 15000 },
  async () => {
    const session = await Session.create(process.cwd(), () => {});
    const originalCreate = Session.create;
    let child: Session | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      Session.create = async (...args) => {
        child = await originalCreate(...args);
        await gate;
        return child;
      };
      const opening = assert.rejects(session.openTerminal('auto'), /Workspace was closed/);
      for (let i = 0; !child && i < 100; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(child);
      let childClosed = false;
      child.process.once('close', () => {
        childClosed = true;
      });
      const stopping = session.stop();
      release();
      await Promise.all([opening, stopping]);
      assert.equal(childClosed, true);
      await assert.rejects(session.openTerminal('auto'), /Workspace was closed/);
    } finally {
      release();
      Session.create = originalCreate;
      await session.stop();
      await child?.stop();
    }
  }
);

test(
  'unexpected Neovim exit rejects pending and subsequent requests',
  { timeout: 15000 },
  async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
      const pending = assert.rejects(
        session.client.request('nvim_exec_lua', ['vim.wait(10000)', []]),
        /session is closed/
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closed = once(session.process, 'close');
      session.process.kill();
      await closed;
      await pending;
      await assert.rejects(session.client.request('nvim_eval', ['1']), /session is closed/);
      await assert.rejects(session.input('ihello'), /session is closed/);
      await assert.rejects(session.setClipboardSharing(true), /session is closed/);
    } finally {
      await session.stop();
    }
  }
);

test(
  'a broken RPC writer reports once without an uncaught error or hung request',
  { timeout: 15000 },
  async () => {
    const events: NidoEvent[] = [];
    const session = await Session.create(process.cwd(), (event) => events.push(event));
    try {
      const pending = assert.rejects(
        session.client.request('nvim_exec_lua', ['vim.wait(10000)', []]),
        /EPIPE/
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closed = once(session.process, 'close');
      // Deliver the same asynchronous stream error raised by a write to a broken pipe.
      session.process.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await pending;
      await closed;
      const errors = events.filter((event) => event.type === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /Neovim connection closed: write EPIPE/);
      await assert.rejects(session.client.request('nvim_eval', ['1']), /EPIPE/);
    } finally {
      await session.stop();
    }
  }
);

test(
  'overlapping shutdowns share completion and cancel queued work',
  { timeout: 15000 },
  async () => {
    const session = await Session.create(process.cwd(), () => {});
    let closed = false;
    session.process.once('close', () => {
      closed = true;
    });
    try {
      const queued = assert.rejects(session.input('iignored'), /session is closed/);
      const first = session.stop();
      assert.equal(session.stop(), first);
      await Promise.all([first, queued]);
      assert.equal(closed, true);
      await assert.rejects(session.client.request('nvim_eval', ['1']), /session is closed/);
    } finally {
      await session.stop();
    }
  }
);
