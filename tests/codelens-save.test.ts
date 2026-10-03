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
    const mainRows: number[] = [];
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
            if (measuring) {
                mainRows.push(grid.cells.findIndex((row) => row.map((cell) => cell.text).join('').includes('fn main()')));
                frames.push(
                    grid.cells
                        .map((row) => row.map((cell) => cell.text).join(''))
                        .filter((row) => row.includes('▶'))
                );
            }
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
        // Whole-document TextEdits are allowed even when the formatted text is unchanged.
        // Neovim moves extmarks inside the replaced range to its end before analysis refreshes.
        await lua(`_G.original_format = vim.lsp.buf.format
vim.lsp.buf.format = function()
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  vim.lsp.util.apply_text_edits({{range={start={line=0, character=0},
    ['end']={line=#lines-1, character=#lines[#lines]}}, newText=table.concat(lines, '\\n')}},
    vim.api.nvim_get_current_buf(), 'utf-8')
  vim.cmd.redraw()
  vim.wait(40)
end`);
        await session.save(true);
        await lua('vim.lsp.buf.format = _G.original_format; vim.wait(1500)');
        assert.ok(frames.length > 0);
        assert.ok(mainRows.every((row) => row === 1), `main moved between rows: ${mainRows}`);
        assert.ok(
            frames.every((frame) => frame.length === 3),
            JSON.stringify(frames)
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('whole-document edits preserve anchors and match native text edit results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-text-edits-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
local native = assert(loadfile(vim.env.VIMRUNTIME .. '/lua/vim/lsp/util.lua'))().apply_text_edits
local namespace = api.nvim_create_namespace('text-edit-test')
local cases = {
  {{'fn main() {', '  hello();', '}', '日本語😀'}, 'fn main() {\\n    hello();\\n}\\n日本語😀', 'utf-16', false},
  {{'a', 'b', 'c'}, 'first\\na\\nb\\nc\\nlast', 'utf-8', false},
  {{'a', 'b', 'c', 'd'}, 'a\\nc', 'utf-8', false},
  {{'a', 'b', 'c'}, 'A\\nb\\nC', 'utf-8', false},
  {{'a', 'b'}, 'a\\r\\nb\\r\\n', 'utf-8', true},
  {{'a', 'b'}, '', 'utf-8', true},
  {{''}, 'new\\nlines\\n', 'utf-8', true},
  {{'a', 'b'}, 'a\\nb\\n', 'utf-8', false},
}
for index, case in ipairs(cases) do
  local buffer = api.nvim_create_buf(false, true)
  local reference = api.nvim_create_buf(false, true)
  api.nvim_buf_set_lines(buffer, 0, -1, false, case[1])
  api.nvim_buf_set_lines(reference, 0, -1, false, case[1])
  local last = case[1][#case[1]]
  local ending = case[4] and {line=#case[1], character=0}
    or {line=#case[1]-1, character=vim.str_utfindex(last, case[3], #last)}
  local edits = {{range={start={line=0, character=0}, ['end']=ending}, newText=case[2]}}
  local mark = api.nvim_buf_set_extmark(buffer, namespace, 0, 0, {virt_lines={{{'lens', 'Comment'}}}})
  vim.lsp.util.apply_text_edits(vim.deepcopy(edits), buffer, case[3])
  native(vim.deepcopy(edits), reference, case[3])
  assert(vim.deep_equal(api.nvim_buf_get_lines(buffer, 0, -1, false),
    api.nvim_buf_get_lines(reference, 0, -1, false)), 'text mismatch in case ' .. index)
  if index == 1 or index == 4 then
    assert(api.nvim_buf_get_extmark_by_id(buffer, namespace, mark, {})[1] == 0,
      'unchanged first line anchor moved')
  end
  local tick = api.nvim_buf_get_changedtick(buffer)
  local lines = api.nvim_buf_get_lines(buffer, 0, -1, false)
  vim.lsp.util.apply_text_edits({{range={start={line=0, character=0},
    ['end']={line=#lines-1, character=#lines[#lines]}}, newText=table.concat(lines, '\\n')}}, buffer, 'utf-8')
  assert(api.nvim_buf_get_changedtick(buffer) == tick, 'unchanged format must not edit the buffer')
  api.nvim_buf_delete(buffer, {force=true})
  api.nvim_buf_delete(reference, {force=true})
end
`,
            []
        ]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
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
