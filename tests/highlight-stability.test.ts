import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

test('typing inside a bracket pair preserves its existing colors until reparsing completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-highlight-stability-'));
  const grid = new Grid();
  const frames: { text: string; colors: (number | undefined)[] }[] = [];
  const ink = (content: string, token: string): number | undefined => {
    const row = grid.cells.find((cells) =>
      cells
        .map((cell) => cell.text)
        .join('')
        .includes(content)
    );
    if (!row) return undefined;
    const text = row.map((cell) => cell.text).join('');
    return grid.highlights.get(row[text.indexOf(token)].highlight)?.foreground;
  };
  let recording = false;
  let session: Session | undefined;
  try {
    await writeFile(
      join(root, 'sample.txt'),
      'fn main() {\n  let value = ([1]);\n  let label = "hello";\n}\n'
    );
    session = await Session.create(root, (event) => {
      if (event.type !== 'redraw') return;
      grid.apply(event.events);
      if (!recording) return;
      const row = grid.cells.find((cells) =>
        cells
          .map((cell) => cell.text)
          .join('')
          .includes('let value')
      );
      if (!row) return;
      const text = row.map((cell) => cell.text).join('');
      frames.push({
        text,
        colors: [
          ink('let value', '('),
          ink('let value', 'let'),
          ink('fn main', 'main'),
          ink('let label', '"hello"')
        ]
      });
    });
    await session.openFile('sample.txt');
    await session.client.request('nvim_exec_lua', [
      `vim.bo.syntax='rust'
assert(vim.wait(3000, function() return require('nido_brackets').ready(vim.api.nvim_get_current_buf()) end, 5))
vim.cmd.redraw({bang=true})`,
      []
    ]);
    await session.input('2G0f1a');
    assert.equal(await session.inputMode(), 'i');
    await session.client.request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
    const expected = [0xda70d6, 0x569cd6, 0xdcdcaa, 0xce9178];
    assert.deepEqual(
      [
        ink('let value', '('),
        ink('let value', 'let'),
        ink('fn main', 'main'),
        ink('let label', '"hello"')
      ],
      expected
    );
    recording = true;
    for (const character of ['x', 'y', 'z']) {
      await session.input(character);
      assert.equal(await session.inputMode(), 'i');
    }
    await session.input('<Esc>u');
    assert.equal(await session.inputMode(), 'n');
    await session.input('<C-r>');
    assert.equal(await session.inputMode(), 'n');
    await session.client.request('nvim_exec_lua', [
      `vim.cmd.redraw()
assert(vim.wait(3000, function() return require('nido_brackets').ready(vim.api.nvim_get_current_buf()) end, 5))
vim.cmd.redraw()`,
      []
    ]);
    const edited = frames.filter((frame) => frame.text.includes('1x'));
    assert.ok(edited.length, 'the edited text must reach the renderer');
    assert.deepEqual(
      frames.map((frame) => frame.colors),
      frames.map(() => expected)
    );
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('bracket retention follows byte and line edits and drops removed or replaced ranges', async () => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.client.request('nvim_exec_lua', [
      `local api, brackets = vim.api, require('nido_brackets')
local buffer = api.nvim_get_current_buf()
local namespace = api.nvim_create_namespace('nido_brackets')
local function settle()
  api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
  assert(vim.wait(3000, function() return brackets.ready(buffer) end, 5))
end
local function marks() return api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {details=true}) end
local function reset(lines)
  api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  settle()
  return marks()
end
local function position(id) return api.nvim_buf_get_extmark_by_id(buffer, namespace, id, {details=true}) end
local function validate()
  for _, mark in ipairs(marks()) do
    local text = api.nvim_buf_get_lines(buffer, mark[2], mark[2] + 1, false)[1]
    assert(mark[4].end_row == mark[2] and mark[4].end_col == mark[3] + 1,
      'retained marks must cover exactly one bracket')
    assert(text:sub(mark[3] + 1, mark[3] + 1):match('[%(%)%[%]{}]'),
      'retained marks must not color neighboring text')
  end
end
local before = reset({'([1])'})
api.nvim_buf_set_text(buffer, 0, 0, 0, 0, {'日'})
for _, mark in ipairs(before) do
  assert(position(mark[1])[2] == mark[3] + 3, 'Unicode insertions use byte positions')
end
validate()
settle()
assert(#marks() == 4, 'reindexed marks must not be duplicated')

before = reset({'([])'})
api.nvim_buf_set_text(buffer, 0, 1, 0, 1, {'', ''})
assert(position(before[1][1])[1] == 0 and position(before[4][1])[1] == 1,
  'existing marks must survive a split line')
validate()
settle()
assert(#marks() == 4)

before = reset({'()'})
api.nvim_buf_set_text(buffer, 0, 0, 0, 1, {''})
assert(#position(before[1][1]) == 0, 'a collapsed deleted range must be discarded immediately')
assert(#position(before[2][1]) > 0, 'an unchanged closing bracket must remain colored')
validate()
settle()
assert(#marks() == 0, 'an unmatched retained bracket must expire after parsing')

before = reset({'()'})
api.nvim_buf_set_text(buffer, 0, 1, 0, 2, {']'})
assert(#position(before[2][1]) == 0, 'a different bracket type must not inherit the old range')
validate()
settle()
assert(#marks() == 0)

before = reset({'[]', '{}'})
api.nvim_buf_set_lines(buffer, 0, 1, false, {})
assert(#position(before[1][1]) == 0 and #position(before[2][1]) == 0,
  'deleted line marks must not migrate to identical neighboring brackets')
assert(position(before[3][1])[1] == 0 and position(before[4][1])[1] == 0,
  'unaffected rows must shift their index')
validate()
settle()
assert(#marks() == 2)

before = reset({'[value]'})
api.nvim_buf_set_text(buffer, 0, 0, 0, 1, {'x'})
assert(#position(before[1][1]) == 0, 'ordinary replacement text must never retain bracket color')
validate()
settle()
assert(#marks() == 0)`,
      []
    ]);
  } finally {
    await session.stop();
  }
});

test('typing, line breaks and undo keep bracket frames and guides in every redraw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-bracket-decorations-'));
  const grid = new Grid();
  const frames: { matches: number; guides: number; active: number }[] = [];
  let recording = false;
  let session: Session | undefined;
  const snapshot = (): (typeof frames)[number] => ({
    matches: grid.cells
      .flat()
      .filter(
        (cell) =>
          '{}'.includes(cell.text) && cell.text && grid.highlights.get(cell.highlight)?.bracketMatch
      ).length,
    guides: grid.bracketGuides.length,
    active: grid.bracketGuides.filter((guide) => guide.active).length
  });
  try {
    await writeFile(join(root, 'sample.txt'), 'fn main() {\n  let value = 1;\n}\n');
    session = await Session.create(root, (event) => {
      if (event.type !== 'redraw') return;
      grid.apply(event.events);
      if (recording) frames.push(snapshot());
    });
    await session.openFile('sample.txt');
    await session.input('2G$ai');
    assert.equal(await session.inputMode(), 'i');
    await session.client.request('nvim_exec_lua', [
      `local buffer=vim.api.nvim_get_current_buf()
assert(vim.wait(3000,function() return require('nido_brackets').ready(buffer) end,5))
vim.api.nvim_exec_autocmds('CursorMovedI',{buffer=buffer})
vim.cmd.redraw({bang=true})`,
      []
    ]);
    const expected = { matches: 2, guides: 1, active: 1 };
    assert.deepEqual(snapshot(), expected);
    recording = true;
    for (const input of ['x', 'y', 'z', '<CR>', 'value', '<Esc>u', '<C-r>']) {
      await session.input(input);
      await session.client.request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
    }
    await session.client.request('nvim_exec_lua', [
      `local buffer=vim.api.nvim_get_current_buf()
assert(vim.wait(3000,function() return require('nido_brackets').ready(buffer) end,5))
vim.cmd.redraw({bang=true})`,
      []
    ]);
    assert.ok(frames.length > 7, 'the test must observe intermediate editor redraws');
    assert.deepEqual(
      frames,
      frames.map(() => expected)
    );
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
