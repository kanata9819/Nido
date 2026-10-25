import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import type { NidoEvent } from '../src/shared/types';

test(
  'shell exit closes only its terminal, clears ownership and allows a fresh shell',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-terminal-exit-'));
    const events: NidoEvent[] = [];
    let owner: Session | undefined;
    try {
      owner = await Session.create(root, (event) => events.push(event));
      const terminal = await owner.openTerminal('cmd.exe');
      // Each restart stops the previous job; its callback must leave the replacement alive.
      await terminal.startTerminal('cmd.exe');
      await terminal.startTerminal('powershell.exe');
      assert.equal(await terminal.inputMode(), 't');
      const closed = once(terminal.process, 'close');
      await terminal.input('exit<CR>');
      await closed;
      assert.equal(terminal.process.exitCode, 0);
      assert.equal(owner.process.exitCode, null);
      assert.equal(owner.terminal, undefined);
      assert.equal(owner.workspace.terminalId, undefined);
      assert.equal((await owner.snapshot()).terminal, false);
      assert.equal(
        events.filter((event) => event.type === 'exit' && event.id === terminal.workspace.id)
          .length,
        1
      );
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        []
      );

      const reopened = await owner.openTerminal('cmd.exe');
      assert.notEqual(reopened.workspace.id, terminal.workspace.id);
      assert.equal(await reopened.inputMode(), 't');
      const reopenedClosed = once(reopened.process, 'close');
      await reopened.input('exit /b 7<CR>');
      await reopenedClosed;
      assert.equal(owner.terminal, undefined);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        []
      );
    } finally {
      await owner?.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);

test(
  'a standalone shell exits through the normal workspace lifecycle',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-standalone-exit-'));
    const events: NidoEvent[] = [];
    let terminal: Session | undefined;
    try {
      terminal = await Session.create(root, (event) => events.push(event));
      await terminal.startTerminal('cmd.exe');
      const closed = once(terminal.process, 'close');
      await terminal.input('exit<CR>');
      await closed;
      assert.equal(terminal.process.exitCode, 0);
      assert.equal(events.filter((event) => event.type === 'exit').length, 1);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        []
      );
    } finally {
      await terminal?.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);
