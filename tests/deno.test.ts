import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

test('Deno markers select one server per file, including mixed workspaces and nested Node projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-deno-roots-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'pnpm-lock.yaml'), '');
        const cases: [string, string | false][] = [[join(root, 'node.ts'), false]];
        for (const marker of ['deno.json', 'deno.jsonc', 'deno.lock']) {
            const folder = join(root, marker.replaceAll('.', '-'));
            await mkdir(folder);
            await writeFile(join(folder, marker), '{}');
            await writeFile(join(folder, 'package.json'), '{}');
            cases.push([join(folder, 'main.ts'), folder]);
            const node = join(folder, 'node');
            await mkdir(node);
            await writeFile(join(node, 'package-lock.json'), '{}');
            cases.push([join(node, 'main.ts'), false]);
        }
        const nested = join(root, 'deno-json', 'nested');
        await mkdir(nested);
        await writeFile(join(nested, 'deno.jsonc'), '{}');
        cases.push([join(nested, 'main.ts'), nested]);
        session = await Session.create(root, () => {});
        for (const [path, expected] of cases) {
            const result = (await session.client.request('nvim_exec_lua', [
                `local buffer = vim.api.nvim_create_buf(false, false)
vim.api.nvim_buf_set_name(buffer, ...)
local selected
vim.lsp.config.typescript.root_dir(buffer, function(root) selected = root end)
local deno = require('nido_deno').root(buffer)
vim.api.nvim_buf_delete(buffer, {force=true})
return {deno or false, selected or false}`,
                [path]
            ])) as [string | false, string | false];
            assert.equal(result[0] && resolve(result[0]), expected && resolve(expected), path);
            assert.equal(result[1] && resolve(result[1]), expected ? false : resolve(root), path);
        }
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('missing Deno warns once for Deno files and avoids misleading TypeScript diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-deno-missing-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'deno.json'), '{}');
        await writeFile(join(root, 'main.ts'), 'Deno.cwd();\n');
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            `local exepath, executable, notify = vim.fn.exepath, vim.fn.executable, vim.notify
local warnings = {}
vim.fn.exepath = function(name) return name == 'deno' and '' or exepath(name) end
vim.fn.executable = function(name)
  if name:match('deno%.exe$') or name:match('/deno$') then return 0 end
  return executable(name)
end
vim.notify = function(message) warnings[#warnings + 1] = message end
local ok, err = pcall(function()
  require('nido_deno').setup()
  vim.cmd('edit main.ts')
  vim.api.nvim_exec_autocmds('FileType', {buffer=0})
  vim.wait(300)
  assert(#warnings == 1 and warnings[1]:find('needs Deno', 1, true), vim.inspect(warnings))
  assert(#vim.lsp.get_clients({bufnr=0}) == 0, 'Deno files must not fall back to TypeScript')
end)
vim.fn.exepath, vim.fn.executable, vim.notify = exepath, executable, notify
assert(ok, err)`,
            []
        ]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

for (const [extension, configName] of [
    ['ts', 'deno.json'],
    ['js', 'deno.jsonc']
] as const) {
    test(
        `Deno ${extension}: real completion, navigation, diagnostics, rename, formatting and highlights`,
        { timeout: 60000 },
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'nido-deno-lsp-'));
            const grid = new Grid();
            let session: Session | undefined;
            try {
                const config = JSON.stringify({
                    imports: { '@lib': './lib.ts' },
                    compilerOptions: { checkJs: true },
                    fmt: { singleQuote: true, semiColons: false }
                });
                await writeFile(
                    join(root, configName),
                    (configName.endsWith('jsonc') ? '// Deno workspace\n' : '') + config
                );
                await writeFile(join(root, 'tsconfig.json'), '{}');
                await writeFile(
                    join(root, 'lib.ts'),
                    'export function greet(name: string) { return name.length; }\n'
                );
                const path = join(root, `main.${extension}`);
                await writeFile(
                    path,
                    'import { greet } from "@lib";\nconst answer=greet("世界");\nanswer.toUpperCase();\nDeno.cwd();\n'
                );
                session = await Session.create(
                    root,
                    (event) => {
                        if (event.type === 'redraw') grid.apply(event.events);
                    },
                    process.env.NIDO_TEST_RESOURCES
                );
                await session.openFile(`main.${extension}`);
                await session.attach(90, 25);
                const lua = (code: string, args: unknown[] = []): Promise<unknown> =>
                    session!.client.request('nvim_exec_lua', [code, args]);
                assert.equal(
                    await lua(`return vim.wait(20000, function()
  local client = vim.lsp.get_clients({bufnr=0, name='denols'})[1]
  return client and client.initialized
end, 20)`),
                    true,
                    'Deno server did not attach'
                );
                assert.equal(
                    await lua("return #vim.lsp.get_clients({bufnr=0, name='typescript'})"),
                    0
                );
                const params = {
                    textDocument: { uri: pathToFileURL(path).href },
                    position: { line: 1, character: 14 }
                };
                const request = (method: string, value: unknown): Promise<unknown> =>
                    lua(
                        `local method, params = ...
local client = vim.lsp.get_clients({bufnr=0, name='denols'})[1]
local response, err = client:request_sync(method, params, 15000, 0)
assert(response and not response.err, vim.inspect(err or response))
return response.result`,
                        [method, value]
                    );
                let hover = '';
                for (let attempt = 0; attempt < 50; attempt++) {
                    hover = JSON.stringify(await request('textDocument/hover', params));
                    if (/greet.*number/.test(hover)) break;
                    await new Promise((done) => setTimeout(done, 100));
                }
                assert.match(hover, /greet.*number/);
                assert.match(
                    JSON.stringify(await request('textDocument/definition', params)),
                    /lib\.ts/
                );
                assert.match(
                    JSON.stringify(
                        await request('textDocument/references', {
                            ...params,
                            context: { includeDeclaration: true }
                        })
                    ),
                    /main\./
                );
                assert.match(
                    JSON.stringify(
                        await request('textDocument/rename', { ...params, newName: 'hello' })
                    ),
                    /hello/
                );
                assert.match(
                    JSON.stringify(
                        await request('textDocument/completion', {
                            ...params,
                            position: { line: 3, character: 5 }
                        })
                    ),
                    /readTextFile/
                );
                assert.equal(
                    await lua(
                        'return vim.wait(15000, function() return #vim.diagnostic.get(0) > 0 end, 20)'
                    ),
                    true
                );
                const diagnostics = JSON.stringify(await lua('return vim.diagnostic.get(0)'));
                assert.match(diagnostics, /toUpperCase/);
                assert.doesNotMatch(diagnostics, /Cannot find name 'Deno'|Cannot find module/);
                assert.ok(
                    (await request('textDocument/codeAction', {
                        textDocument: params.textDocument,
                        range: {
                            start: { line: 2, character: 0 },
                            end: { line: 2, character: 20 }
                        },
                        context: { diagnostics: [] }
                    })) instanceof Array
                );
                await lua(`vim.api.nvim_win_set_cursor(0, {2, 6})
vim.api.nvim_exec_autocmds('CursorMoved', {buffer=0})`);
                let painted = false;
                for (let attempt = 0; attempt < 50 && !painted; attempt++) {
                    await new Promise((done) => setTimeout(done, 100));
                    await lua("vim.cmd('redraw!')");
                    await session.client.request('nvim_eval', ['1']);
                    painted = grid.cells.some((row) =>
                        row.some((cell) => grid.highlights.get(cell.highlight)?.wordHighlight)
                    );
                }
                assert.ok(painted, 'Deno occurrence highlights must reach the GUI');
                await session.save(true);
                assert.match(await readFile(path, 'utf8'), /const answer = greet\('世界'\)\r?\n/);
                const react = extension === 'ts' ? 'view.tsx' : 'view.jsx';
                await writeFile(join(root, react), 'export const view = <div />;\n');
                await session.openFile(react);
                assert.equal(
                    await lua(
                        "return vim.wait(5000, function() return #vim.lsp.get_clients({bufnr=0, name='denols'}) == 1 end, 20)"
                    ),
                    true
                );
                assert.equal(await lua("return #vim.lsp.get_clients({name='denols'})"), 1);
                await session.openFile(`main.${extension}`);
                await lua(`local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
local row
for index, line in ipairs(lines) do if line:find('Deno.cwd', 1, true) then row = index end end
vim.api.nvim_win_set_cursor(0, {assert(row), 5})
vim.lsp.buf.definition()
assert(vim.wait(10000, function()
  return vim.api.nvim_buf_get_name(0):match('^deno:') and vim.api.nvim_buf_line_count(0) > 10
end, 20), 'Deno built-in type definition was not loaded')
assert(vim.bo.readonly and not vim.bo.modifiable and not vim.bo.modified)
assert(vim.bo.buftype == 'nofile')
assert(#vim.lsp.get_clients({bufnr=0, name='typescript'}) == 0)`);
            } finally {
                await session?.stop();
                await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
        }
    );
}

test(
    'Deno cache code actions download a dependency and open its definition read-only',
    { timeout: 30000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-deno-cache-'));
        const fetched: string[] = [];
        const server = createServer((_request, response) => {
            fetched.push(_request.url ?? '');
            response.writeHead(200, { 'Content-Type': 'application/typescript' });
            response.end('export function remote() { return 7; }\n');
        });
        let session: Session | undefined;
        try {
            await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
            const address = server.address() as { port: number };
            await writeFile(
                join(root, 'deno.json'),
                JSON.stringify({ lint: { rules: { exclude: ['no-import-prefix'] } } })
            );
            await writeFile(
                join(root, 'main.ts'),
                `import { remote } from "http://127.0.0.1:${address.port}/remote.ts";\nremote();\n`
            );
            session = await Session.create(root, () => {});
            await session.client.request('nvim_exec_lua', [
                'vim.env.DENO_DIR = ...',
                [join(root, 'cache')]
            ]);
            await session.openFile('main.ts');
            await session.client.request('nvim_exec_lua', [
                `assert(vim.wait(10000, function()
  return #vim.diagnostic.get(0) > 0
end, 20), 'Missing dependency diagnostic was not published')
local client = assert(vim.lsp.get_clients({bufnr=0, name='denols'})[1])
local params = vim.lsp.util.make_range_params(0, client.offset_encoding)
params.context = {diagnostics={}}
for _, diagnostic in ipairs(vim.diagnostic.get(0)) do
  table.insert(params.context.diagnostics, diagnostic.user_data.lsp)
end
local response, err = client:request_sync('textDocument/codeAction', params, 5000, 0)
assert(response and not response.err, vim.inspect(err or response))
local cache
for _, action in ipairs(response.result or {}) do
  local command = type(action.command) == 'table' and action.command or action
  if command.command == 'deno.cache' then cache = command end
end
local done, failure = false
client:exec_cmd(assert(cache, vim.inspect(response)), {bufnr=0}, function(err)
  done, failure = true, err
end)
assert(vim.wait(10000, function() return done end, 20), 'Deno cache command timed out')
assert(not failure, vim.inspect(failure))`,
                []
            ]);
            assert.ok(fetched.includes('/remote.ts'), JSON.stringify(fetched));
            await new Promise((done) => setTimeout(done, 100));
            await session.client.request('nvim_exec_lua', [
                `assert(vim.wait(10000, function() return #vim.diagnostic.get(0) == 0 end, 20), 'Deno cache action did not resolve the import')
vim.api.nvim_win_set_cursor(0, {2, 1})
vim.lsp.buf.definition()
assert(vim.wait(5000, function()
  return vim.api.nvim_buf_get_name(0):match('^deno:') and vim.api.nvim_get_current_line():find('function remote', 1, true)
end, 20), 'Cached dependency definition was not loaded')
assert(vim.bo.readonly and not vim.bo.modifiable and not vim.bo.modified)`,
                []
            ]);
        } finally {
            await session?.stop();
            await new Promise<void>((done, fail) =>
                server.close((error) => (error ? fail(error) : done()))
            );
            await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
);
