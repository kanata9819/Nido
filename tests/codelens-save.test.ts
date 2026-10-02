import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

test('formatted Rust saves keep CodeLens rows visible', { timeout: 90000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-lens-save-'));
    let session: Session | undefined;
    const grid = new Grid();
    let measuring = false;
    const frames: string[][] = [];
    try {
        await mkdir(join(root, 'src'));
        await writeFile(
            join(root, 'Cargo.toml'),
            '[package]\nname="lens_save"\nversion="0.1.0"\nedition="2021"\n'
        );
        await writeFile(
            join(root, 'src/main.rs'),
            'fn main() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn example() {\n        assert_eq!(1, 1);\n    }\n}\n'
        );
        session = await Session.create(root, (event) => {
            if (event.type !== 'redraw') return;
            grid.apply(event.events);
            if (measuring)
                frames.push(
                    grid.cells
                        .map((row) => row.map((cell) => cell.text).join(''))
                        .filter((row) => row.includes('▶'))
                );
        });
        await session.attach(100, 35);
        await session.openFile('src/main.rs');
        const lua = (code: string) => session!.client.request('nvim_exec_lua', [code, []]);
        await lua(`assert(vim.wait(30000, function()
          return #vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_get_namespaces().nido_runnables, 0, -1, {}) == 3
        end, 50), 'CodeLens did not load')`);
        measuring = true;
        for (let i = 0; i < 3; i++) {
            await lua(`local line = vim.api.nvim_buf_get_lines(0, 6, 7, false)[1]
              vim.api.nvim_buf_set_text(0, 6, 0, 6, #line, {'        assert_eq! (1,1);'})`);
            await session.save(true);
            await lua('vim.wait(1500)');
        }
        assert.ok(frames.length > 0);
        assert.ok(
            frames.every((frame) => frame.length === 3),
            JSON.stringify(frames)
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('transient missing CodeLens after edits does not collapse the layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-lens-reload-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
local buffer = api.nvim_get_current_buf()
api.nvim_buf_set_lines(buffer, 0, -1, false, {'fn main() {}', '#[test] fn example() {}'})
vim.bo.filetype = 'rust'
local module = require('nido_runnables')
local namespace = api.nvim_get_namespaces().nido_runnables
local function item(row)
  return {kind='cargo', args={cargoArgs={'test'}}, location={
    targetSelectionRange={start={line=row}}, targetRange={start={line=row}, ['end']={line=row}},
  }}
end
local items = {item(0), item(1)}
local get_clients, defer = vim.lsp.get_clients, vim.defer_fn
local retry
vim.lsp.get_clients = function(options)
  if options and options.name == 'rust_analyzer' then
    return {{request=function(_, _, _, callback) callback(nil, items) end}}
  end
  return get_clients(options)
end
vim.defer_fn = function(callback) retry = callback end
local ok, err = pcall(function()
  local function marks() return api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {details=true}) end
  module.refresh(buffer)
  api.nvim_buf_set_text(buffer, 0, 10, 0, 10, {' '})
  local before = marks()
  for _, result in ipairs({{item(0)}, {}}) do
    items = result
    module.refresh(buffer)
    assert(vim.deep_equal(marks(), before), 'temporary missing results must keep the layout')
    items = {item(0), item(1)}
    retry()
    assert(vim.deep_equal(marks(), before), 'recovered results must preserve IDs')
  end
  items = {item(0)}
  module.refresh(buffer)
  retry()
  assert(#marks() == 1, 'confirmed removals must remove stale lenses')
  items = {}
  module.refresh(buffer)
  retry()
  assert(#marks() == 0, 'confirmed empty results must clear the last lens')
end)
vim.lsp.get_clients, vim.defer_fn = get_clients, defer
assert(ok, err)
`,
            []
        ]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});
