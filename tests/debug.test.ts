import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';

test('CodeLLDB builds Rust, stops at a breakpoint, steps and reports variables', {timeout: 90000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-debug-'));
  let session: Session | undefined;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname="nido_debug_test"\nversion="0.1.0"\nedition="2021"\n');
    await writeFile(join(root, 'src/main.rs'), 'fn double(x: i32) -> i32 {\n    x * 2\n}\nfn main() {\n    let number = 21;\n    let answer = double(number);\n    println!("answer={answer}");\n}\n');
    session = await Session.create(root, () => {});
    await session.openFile('src/main.rs');
    await session.client.request('nvim_win_set_cursor', [0, [6, 4]]);
    await session.debug('breakpoint');
    const wait = async (condition: () => boolean): Promise<void> => {
      for (let i=0; i<300; i++) {
        if (condition()) return;
        if (session!.state.debug?.status === 'error') throw new Error(session!.state.debug.output);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(JSON.stringify(session!.state.debug));
    };
    await session.debug('start');
    await wait(() => session!.state.debug?.status === 'paused' && !!session!.state.debug?.variables.length);
    assert.match(session.state.debug!.location!, /main.rs:6$/);
    assert.ok(session.state.debug!.variables.some((v) => v.name === 'number' && v.value === '21'));
    await session.debug('into');
    await wait(() => /main.rs:2$/.test(session!.state.debug?.location || ''));
    await session.debug('out');
    await wait(() => /main.rs:[67]$/.test(session!.state.debug?.location || ''));
    await session.debug('over');
    await wait(() => session!.state.debug?.variables.some((v) => v.name === 'answer' && v.value === '42') || false);
    await session.debug('start');
    await wait(() => session!.state.debug?.status === 'finished');
    await wait(() => /answer=42/.test(session!.state.debug?.terminal || ''));
    assert.equal(await session.modified(), false, 'debug output is not an unsaved source file');
    await session.debug('start');
    await wait(() => session!.state.debug?.status === 'paused');
    await session.debug('stop');
    for (let i=0; i<100; i++) {
      if (await session.client.request('nvim_exec_lua', ["return require('dap').session() == nil", []])) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await session.client.request('nvim_exec_lua', ["return require('dap').session() == nil", []]), true);
    await session.client.request('nvim_exec_lua', ["vim.api.nvim_buf_set_lines(0, 0, -1, false, {'not valid rust'})", []]);
    await assert.rejects(session.debug('start'), /Save modified files/);
    await session.save();
    await session.debug('start');
    for (let i=0; i<100 && session.state.debug?.status !== 'error'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.state.debug?.status, 'error');
    assert.match(session.state.debug!.output, /Cargo build failed/);
  } finally {
    await session?.stop();
    await rm(root, {recursive:true, force:true});
  }
});
