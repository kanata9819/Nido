import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/main/session';

test('Rust syntax and real rust-analyzer navigation, completion and diagnostics', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-rust-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'nido-external-'));
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
      'use nido_rust_fixture::greet;\nfn main() {\n    let answer = greet();\n    println!("{}", answer);\n}\ntype AppTabs = Vec<u32>;\nconst CURSOR_BLINK_INTERVAL: u32 = 500;\n'
    );
    let sawProgress = false;
    const messages: string[] = [];
    session = await Session.create(root, (event) => {
      if (event.type === 'state' && event.state.lspProgress) sawProgress = true;
      if (event.type === 'error') messages.push(event.message);
    });
    await session.openFile('src/main.rs');
    const lua = (code: string, args: unknown[] = []): Promise<unknown> =>
      session!.client.request('nvim_exec_lua', [code, args]);
    assert.deepEqual(await lua('return {vim.bo.filetype, vim.bo.syntax}'), ['rust', 'rust']);
    assert.equal(await lua("return vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(2, 1, 1)), 'fg#')"), '#569cd6');
    assert.equal(await lua("return vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(1, 1, 1)), 'fg#')"), '#569cd6');
    assert.equal(await lua("return vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(1, 5, 1)), 'fg#')"), '#4ec9b0');
    assert.equal(
      await lua("return vim.api.nvim_get_hl(0, {name='@lsp.type.namespace.rust', link=false}).fg"),
      0x4ec9b0
    );
    assert.equal(await lua("return vim.api.nvim_get_hl(0, {name='@lsp.type.parameter', link=false}).fg"), 0x9cdcfe);
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
    await lua('vim.api.nvim_win_set_cursor(0, {3, 18}); require("nido_references").find()');
    for (let attempt = 0; attempt < 100 && session.state.references?.loading !== false; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
    }
    const referenceList = session.state.references!;
    assert.equal(referenceList.loading, false);
    assert.equal(referenceList.error, '');
    const call = referenceList.items.findIndex((item) => item.path.endsWith('main.rs') && item.line === 3);
    assert.ok(call >= 0, 'References include the call site');
    const beforePreview = await lua('return {vim.api.nvim_get_current_buf(), vim.api.nvim_win_get_cursor(0)}');
    const referencePreview = await session.previewReference(call + 1, referenceList.version);
    assert.equal(referencePreview.line, 3);
    assert.ok(referencePreview.lines.length > 1);
    assert.equal(referencePreview.lines[1][0].text, 'fn');
    assert.equal(referencePreview.lines[1][0].color, '#569cd6');
    assert.deepEqual(
      await lua('return {vim.api.nvim_get_current_buf(), vim.api.nvim_win_get_cursor(0)}'),
      beforePreview
    );
    await assert.rejects(session.previewReference(call + 1, referenceList.version + 1), /References changed/);
    await session.openReference(call + 1, referenceList.version);
    assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [3, referenceList.items[call].column - 1]);
    assert.equal(
      await lua('return #vim.api.nvim_tabpage_list_wins(0)'),
      1,
      'References must not open a quickfix split'
    );
    await assert.rejects(session.openReference(call + 1, referenceList.version + 1), /References changed/);
    assert.equal(session.state.lsp, 'rust_analyzer');
    assert.deepEqual(
      await lua(
        'local a=vim.lsp.semantic_tokens.get_at_pos(0, 5, 5) or {}; local b=vim.lsp.semantic_tokens.get_at_pos(0, 6, 6) or {}; return {a[1] and a[1].type, b[1] and b[1].type}'
      ),
      ['typeAlias', 'const']
    );
    assert.deepEqual(
      await lua(
        "return {vim.api.nvim_get_hl(0, {name='@lsp.type.typeAlias.rust', link=false}).fg, vim.api.nvim_get_hl(0, {name='@lsp.type.const.rust', link=false}).fg}"
      ),
      [0x4ec9b0, 0x4fc1ff]
    );
    assert.ok(sawProgress, 'real rust-analyzer startup publishes progress');
    const progress = async (token: string, value: object): Promise<void> => {
      await lua(
        `local token, value = ...
        local client = vim.lsp.get_clients({name='rust_analyzer'})[1]
        vim.lsp.handlers['$/progress'](nil, {token=token, value=value}, {client_id=client.id})`,
        [token, value]
      );
      await session!.client.request('nvim_eval', ['1']);
    };
    await progress('nido-test-a', { kind: 'begin', title: 'Indexing test' });
    await progress('nido-test-b', { kind: 'begin', title: 'Cargo test' });
    await progress('nido-test-a', { kind: 'report', message: 'crate_one', percentage: 42 });
    assert.match(session.state.lspProgress || '', /Indexing test — crate_one \(42%\)/);
    await progress('nido-test-a', { kind: 'end' });
    assert.doesNotMatch(session.state.lspProgress || '', /Indexing test/);
    assert.match(session.state.lspProgress || '', /Cargo test/);
    await progress('nido-test-b', { kind: 'end' });
    assert.doesNotMatch(session.state.lspProgress || '', /Cargo test/);
    assert.match(JSON.stringify(await request('textDocument/hover', params)), /greet/);
    await session.client.request('nvim_win_set_cursor', [0, [3, 18]]);
    await session.input('<C-k>');
    let preview: { id: number; width: number; height: number; title: unknown } | undefined;
    for (let i = 0; i < 50; i++) {
      preview = (await lua(`for _, win in ipairs(vim.api.nvim_list_wins()) do
        local config = vim.api.nvim_win_get_config(win)
        if config.relative ~= '' and config.title then
          return {id=win, width=config.width, height=config.height, title=config.title}
        end
      end`)) as typeof preview;
      if (preview) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(preview, 'Ctrl+K should show a bordered documentation window');
    assert.ok(preview.width <= 88 && preview.height <= 20);
    assert.match(JSON.stringify(preview.title), /Type information/);
    await session.client.request('nvim_win_close', [preview.id, true]);
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
    // External Cargo roots must reuse the project's server, even after changing cwd.
    const clientId = await lua("return vim.lsp.get_clients({name='rust_analyzer'})[1].id");
    await writeFile(
      join(externalRoot, 'Cargo.toml'),
      '[package]\nname="external_fixture"\nversion="0.1.0"\n[lib]\npath="lib.rs"\n'
    );
    await writeFile(join(externalRoot, 'lib.rs'), '');
    await lua(
      `local dir = ...
      vim.cmd.cd(dir)
      vim.cmd.edit(vim.fn.fnameescape(vim.fs.joinpath(dir, 'lib.rs')))
      assert(vim.wait(5000, function() return #vim.lsp.get_clients({bufnr=0}) > 0 end))`,
      [externalRoot]
    );
    assert.deepEqual(
      await lua(
        "local clients=vim.lsp.get_clients({name='rust_analyzer'}); return {#clients, clients[1].id, vim.lsp.get_clients({bufnr=0})[1].id}"
      ),
      [1, clientId, clientId]
    );
    await lua(
      `local id = ...
      for kind = 1, 4 do
        vim.lsp.handlers['window/showMessage'](nil, {type=kind, message='Nido message test\\n' .. string.rep('long warning ', 200)}, {client_id=id})
      end`,
      [clientId]
    );
    await session.client.request('nvim_eval', ['1']);
    assert.equal(messages.filter((message) => message.includes('Nido message test')).length, 4);
    await session.input('iOK<Esc>');
    for (let i = 0; i < 50 && (await lua('return vim.api.nvim_get_current_line()')) !== 'OK'; i++) {
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(
      await lua('return vim.api.nvim_get_current_line()'),
      'OK',
      'messages must not require Enter before editing'
    );
    await lua('vim.bo.modified = false');
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
    await rm(externalRoot, { recursive: true, force: true });
  }
});
