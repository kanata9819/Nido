import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/main/session';
import { execFileSync } from 'node:child_process';
import { Grid } from '../src/renderer/src/grid';

test(
  'LSP Node launchers hide native child consoles, including ESM imports',
  { skip: process.platform !== 'win32' },
  () => {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    const require = createRequire(import.meta.url);
    const child = require('node:child_process');
    const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
    for (const name of names) child[name] = (file, ...args) => args;
    require(${JSON.stringify(resolve('resources/nido/hide-console.cjs'))});
    assert.equal(execFileSync('tsc.exe', [], {stdio: 'inherit'})[1].windowsHide, true);
    for (const name of names) {
      assert.deepEqual(child[name]('tool', {stdio: 'pipe', windowsHide: false})[0], {stdio: 'pipe', windowsHide: true});
      assert.equal(child[name]('tool')[0].windowsHide, true);
    }
    const callback = () => {};
    assert.deepEqual(child.execFile('tool', ['--lsp'], callback), [['--lsp'], {windowsHide: true}, callback]);
  `
      ],
      { windowsHide: true }
    );
  }
);

test('TypeScript functions and parameters retain distinct reference theme colors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-token-colors-'));
  const grid = new Grid();
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'tsconfig.json'), '{}');
    await writeFile(
      join(root, 'sample.ts'),
      [
        'export function greet(name: string) {',
        '  try { const count = 42; if (name) return "ok"; throw new Error("bad"); }',
        '  catch (error) { return name; } finally { /* done */ }',
        '}',
        'interface Props { enabled: boolean; count: number; onDone: () => void; }'
      ].join('\n')
    );
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
    assert.equal(ink('name'), 0x9cdcfe);
    const tokenInk = (word: string): number | undefined => {
      const cells = grid.cells.find((cells) =>
        cells
          .map((cell) => cell.text)
          .join('')
          .includes(word)
      )!;
      const text = cells.map((cell) => cell.text).join('');
      return grid.highlights.get(cells[text.indexOf(word)].highlight)?.foreground;
    };
    for (const word of ['export', 'try', 'if', 'return', 'throw', 'catch', 'finally']) {
      assert.equal(tokenInk(word), 0xc586c0, word);
    }
    for (const word of ['function', 'const']) assert.equal(tokenInk(word), 0x569cd6, word);
    for (const word of ['string', 'boolean', 'number', 'void']) assert.equal(tokenInk(word), 0x4ec9b0, word);
    assert.equal(tokenInk('42'), 0xb5cea8);
    assert.equal(tokenInk('"ok"'), 0xce9178);
    assert.equal(tokenInk('/* done */'), 0x6a9955);
    assert.equal(grid.background, '#121212');
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('user LSP configuration selects legacy or an external command without source edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-lsp-config-'));
  let session: Session | undefined;
  try {
    await mkdir(join(root, 'node_modules'));
    await symlink(resolve('node_modules/typescript'), join(root, 'node_modules/typescript'), 'junction');
    session = await Session.create(root, () => {});
    const path = join(root, 'lsp settings.json');
    const configure = (): Promise<unknown> =>
      session!.client.request('nvim_exec_lua', [
        `vim.env.NIDO_LSP_CONFIG = ...
      require('nido_typescript').setup()
      return vim.lsp.config.typescript.cmd`,
        [path]
      ]);
    await writeFile(path, JSON.stringify({ typescript: { server: 'legacy' } }));
    assert.ok(((await configure()) as string[]).some((arg) => arg.endsWith('cli.mjs')));
    const command = [process.execPath, resolve('node_modules/typescript/bin/tsc'), '--lsp', '--stdio'];
    await writeFile(path, JSON.stringify({ typescript: { server: 'native', command } }));
    assert.deepEqual(await configure(), command);
    await writeFile(join(root, 'external.ts'), 'export const external = 1;\n');
    await session.openFile('external.ts');
    assert.equal(
      await session.client.request('nvim_exec_lua', [
        `return vim.wait(10000, function()
        local client = vim.lsp.get_clients({bufnr=0, name='typescript'})[1]
        return client and client.initialized
      end, 50)`,
        []
      ]),
      true
    );
    await writeFile(path, JSON.stringify({ typescript: { command: [42] } }));
    await assert.rejects(configure(), /Invalid LSP command argument/);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const [extension, native] of [
  ['ts', false],
  ['js', false],
  ['ts', true],
  ['js', true]
] as const) {
  test(
    `${extension}: ${native ? 'TS7 project' : 'bundled'} LSP hover, navigation, references, completion, rename, diagnostics and save formatting`,
    { timeout: 60000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'nido-ts-js-'));
      let session: Session | undefined;
      try {
        if (native) {
          await mkdir(join(root, 'node_modules'));
          await symlink(resolve('node_modules/typescript'), join(root, 'node_modules/typescript'), 'junction');
        }
        await writeFile(
          join(root, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, strict: true, noEmit: true } })
        );
        await writeFile(join(root, `lib.${extension}`), 'export function greet() { return 42; }\n');
        const path = join(root, `main.${extension}`);
        await writeFile(path, `import { greet } from './lib';\nconst answer=greet();\nanswer.toUpperCase();\n`);
        session = await Session.create(root, () => {}, process.env.NIDO_TEST_RESOURCES);
        if (!native) {
          const config = join(root, 'lsp.json');
          await writeFile(config, JSON.stringify({ typescript: { server: 'legacy' } }));
          await session.client.request('nvim_exec_lua', [
            "vim.env.NIDO_LSP_CONFIG = ...; require('nido_typescript').setup()",
            [config]
          ]);
        }
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
        const command = (await lua(
          "return vim.lsp.get_clients({bufnr=0, name='typescript'})[1].config.cmd"
        )) as string[];
        if (native) {
          assert.equal(resolve(command[1]), resolve(root, 'node_modules/typescript/bin/tsc'));
          assert.ok(command.includes('--lsp'));
        } else {
          assert.ok(
            command.some((arg) => arg.includes('cli.mjs')),
            JSON.stringify(command)
          );
        }
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
        local notify = vim.rpcnotify
        local hover = ''
        vim.rpcnotify = function(channel, method, ...)
          if method == 'nido:hover' then hover = select(1, ...) end
          return notify(channel, method, ...)
        end
        vim.fn.maparg('K', 'n', false, true).callback()
        local received = vim.wait(5000, function() return hover:find('greet') ~= nil end, 50)
        vim.rpcnotify = notify
        assert(received)
        assert(#vim.api.nvim_list_wins() == 1)`);
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
