import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

test('TypeScript functions and parameters retain distinct reference theme colors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-token-colors-'));
  const grid = new Grid();
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'tsconfig.json'), '{}');
    await writeFile(join(root, 'sample.ts'), 'export function greet(name: string) { return name; }\n');
    session = await Session.create(root, (event) => {
      if (event.type === 'redraw') grid.apply(event.events);
    });
    await session.openFile('sample.ts');
    await session.attach(90, 25);
    assert.equal(
      await session.client.request('nvim_exec_lua', [
        `return vim.wait(20000, function()
        local tokens = vim.lsp.semantic_tokens.get_at_pos(0, 0, 22) or {}
        for _, token in ipairs(tokens) do
          if token.type == 'parameter' then return true end
        end
        return false
      end, 50)`,
        []
      ]),
      true
    );
    await session.client.request('nvim_command', ['redraw!']);
    await session.client.request('nvim_eval', ['1']);
    const row = grid.cells.find((cells) =>
      cells
        .map((cell) => cell.text)
        .join('')
        .includes('function greet')
    )!;
    assert.ok(row);
    const text = row.map((cell) => cell.text).join('');
    const ink = (word: string): number | undefined =>
      grid.highlights.get(row[text.indexOf(word)].highlight)?.foreground;
    assert.equal(ink('greet'), 0xdcdcaa);
    assert.equal(ink('name'), 0xffb300);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const extension of ['ts', 'js']) {
  test(
    `${extension}: bundled LSP hover, navigation, references, completion, rename, diagnostics and save formatting`,
    { timeout: 60000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'nido-ts-js-'));
      let session: Session | undefined;
      try {
        await writeFile(
          join(root, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, strict: true, noEmit: true } })
        );
        await writeFile(join(root, `lib.${extension}`), 'export function greet() { return 42; }\n');
        const path = join(root, `main.${extension}`);
        await writeFile(path, `import { greet } from './lib';\nconst answer=greet();\nanswer.toUpperCase();\n`);
        session = await Session.create(root, () => {}, process.env.NIDO_TEST_RESOURCES);
        await session.openFile(`main.${extension}`);
        const lua = (code: string, args: unknown[] = []): Promise<unknown> =>
          session!.client.request('nvim_exec_lua', [code, args]);
        assert.equal(
          await lua(`return vim.wait(20000, function()
        local c = vim.lsp.get_clients({bufnr=0, name='typescript'})[1]
        return c and c.initialized
      end, 50)`),
          true
        );
        const params = { textDocument: { uri: pathToFileURL(path).href }, position: { line: 1, character: 14 } };
        const request = (method: string, value: unknown): Promise<unknown> =>
          lua(
            `
        local method, params = ...
        local c = vim.lsp.get_clients({bufnr=0, name='typescript'})[1]
        local response, err = c:request_sync(method, params, 15000, 0)
        assert(response and not response.err, vim.inspect(err or response))
        return response.result`,
            [method, value]
          );
        let hover = '';
        for (let attempt = 0; attempt < 50; attempt++) {
          hover = JSON.stringify(await request('textDocument/hover', params));
          if (/greet.*number/.test(hover)) {
            break;
          }
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.match(hover, /greet.*number/);
        assert.match(
          JSON.stringify(await request('textDocument/definition', params)),
          new RegExp(`lib\\.${extension}`)
        );
        assert.match(
          JSON.stringify(
            await request('textDocument/references', { ...params, context: { includeDeclaration: true } })
          ),
          /main\./
        );
        assert.match(JSON.stringify(await request('textDocument/rename', { ...params, newName: 'hello' })), /hello/);
        const completion = await request('textDocument/completion', { ...params, position: { line: 2, character: 7 } });
        assert.match(JSON.stringify(completion), /toFixed/);
        assert.equal(await lua('return vim.wait(15000, function() return #vim.diagnostic.get(0) > 0 end, 50)'), true);
        assert.match(JSON.stringify(await lua('return vim.diagnostic.get(0)')), /toUpperCase/);
        await lua(`vim.api.nvim_win_set_cursor(0, {2, 14})
        vim.fn.maparg('K', 'n', false, true).callback()
        assert(vim.wait(5000, function() return #vim.api.nvim_list_wins() == 2 end, 50))
        for _, win in ipairs(vim.api.nvim_list_wins()) do
          if vim.api.nvim_win_get_config(win).relative ~= '' then
            assert(vim.bo[vim.api.nvim_win_get_buf(win)].buftype ~= 'help')
            vim.api.nvim_win_close(win, true)
          end
        end`);
        await session.save(true);
        assert.match(await readFile(path, 'utf8'), /const answer = greet\(\);/);
        // JSX/TSX use the same server, without creating another workspace client.
        const reactFile = extension === 'ts' ? 'view.tsx' : 'view.jsx';
        await writeFile(join(root, reactFile), 'export const view = <div />;\n');
        await session.openFile(reactFile);
        assert.equal(
          await lua(
            `return vim.wait(5000, function() return #vim.lsp.get_clients({bufnr=0, name='typescript'}) == 1 end, 50)`
          ),
          true
        );
        assert.equal(await lua("return #vim.lsp.get_clients({name='typescript'})"), 1);
      } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  );
}
