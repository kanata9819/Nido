import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/main/session';

test('Rust syntax and real rust-analyzer navigation, completion and diagnostics', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-rust-'));
  let session: Session | undefined;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "nido_rust_fixture"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    await writeFile(join(root, 'src/lib.rs'), 'pub fn greet() -> u32 { 42 }\n');
    await writeFile(
      join(root, 'src/main.rs'),
      'use nido_rust_fixture::greet;\nfn main() {\n    let answer = greet();\n    println!("{}", answer);\n}\n'
    );
    session = await Session.create(root, () => {});
    await session.openFile('src/main.rs');
    const lua = (code: string, args: unknown[] = []): Promise<unknown> =>
      session!.client.request('nvim_exec_lua', [code, args]);
    assert.deepEqual(await lua('return {vim.bo.filetype, vim.bo.syntax}'), ['rust', 'rust']);
    assert.equal(await lua("return vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(2, 1, 1)), 'fg#')"), '#569cd6');
    const params = {
      textDocument: { uri: pathToFileURL(join(root, 'src/main.rs')).href },
      position: { line: 2, character: 18 }
    };
    const request = (method: string, value: unknown): Promise<unknown> =>
      lua(
        `local method, params = ...
      local client = vim.lsp.get_clients({bufnr=0, name='rust_analyzer'})[1]
      if not client or not client.initialized then return nil end
      local response = client:request_sync(method, params, 5000, 0)
      return response and response.result`,
        [method, value]
      );
    let definition: unknown;
    for (let i = 0; i < 100; i++) {
      definition = await request('textDocument/definition', params);
      if (Array.isArray(definition) && definition.length) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.match(JSON.stringify(definition), /lib\.rs/);
    assert.equal(session.state.lsp, 'rust_analyzer');
    assert.match(JSON.stringify(await request('textDocument/hover', params)), /greet/);
    assert.match(
      JSON.stringify(
        await request('textDocument/rename', {
          ...params,
          newName: 'greet_again'
        })
      ),
      /greet_again/
    );
    const references = await request('textDocument/references', {
      ...params,
      context: { includeDeclaration: true }
    });
    assert.ok(Array.isArray(references) && references.length >= 2);
    const completion = await request('textDocument/completion', {
      ...params,
      position: { line: 2, character: 19 }
    });
    assert.match(JSON.stringify(completion), /greet/);
    await session.client.request('nvim_win_set_cursor', [0, [3, 18]]);
    await session.input('<F12>');
    for (let i = 0; i < 50; i++) {
      if (String(await lua('return vim.api.nvim_buf_get_name(0)')).endsWith('lib.rs')) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.match(String(await lua('return vim.api.nvim_buf_get_name(0)')), /lib\.rs$/);
    const formatting = await request('textDocument/formatting', {
      textDocument: { uri: pathToFileURL(join(root, 'src/lib.rs')).href },
      options: { tabSize: 4, insertSpaces: true }
    });
    assert.ok(Array.isArray(formatting) && formatting.length > 0);
    await session.openFile('src/main.rs');
    await lua("vim.api.nvim_buf_set_lines(0, 2, 3, false, {'    let answer: bool = greet();'})");
    await session.save();
    let diagnostics: unknown;
    for (let i = 0; i < 100; i++) {
      diagnostics = await lua('return vim.diagnostic.get(0)');
      if (Array.isArray(diagnostics) && diagnostics.some((d) => d.severity === 1)) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.match(JSON.stringify(diagnostics), /mismatched types|expected.*bool/i);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
