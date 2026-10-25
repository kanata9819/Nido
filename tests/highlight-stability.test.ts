import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid } from '../src/renderer/src/grid';

for (const language of ['rust', 'typescript'] as const) {
  test(
    `ordinary ${language} editing keeps redraws error-free through incomplete syntax and cancellation`,
    { timeout: 60000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'nido-editing-stability-'));
      const rust = language === 'rust';
      const path = rust ? 'src/lib.rs' : 'sample.ts';
      const source = [
        rust ? 'pub struct Counter { pub value: usize }' : 'export class Counter {',
        rust ? 'impl Counter {' : '  value = 1;',
        rust ? '  pub fn total(&self) -> usize {' : '  total(): number {',
        rust ? '    let label = "日本語😀";' : '    const label = "日本語😀";',
        rust ? '    let values = [1, 2, 3];' : '    const values = [1, 2, 3];',
        ...Array.from({ length: 80 }, (_, index) =>
          rust ? `    let _item_${index} = values[0];` : `    const item_${index} = values[0];`
        ),
        rust ? '    self.value + values[0]' : '    return this.value + values[0];',
        '  }',
        '}',
        ''
      ].join('\n');
      const failures: { action: string; message: string }[] = [];
      const grid = new Grid();
      let action = 'startup';
      let session: Session | undefined;
      try {
        if (rust) {
          await mkdir(join(root, 'src'));
          await writeFile(
            join(root, 'Cargo.toml'),
            '[package]\nname="editing_fixture"\nversion="0.1.0"\nedition="2021"\n'
          );
        } else {
          await writeFile(join(root, 'tsconfig.json'), '{}');
        }
        await writeFile(join(root, path), source);
        await writeFile(join(root, 'other.txt'), 'Other buffer\n');
        session = await Session.create(root, (event) => {
          if (event.type === 'redraw') grid.apply(event.events);
          if (
            event.type === 'error' ||
            (event.type === 'notification' &&
              (event.severity === 'error' ||
                /Error in decoration provider|Error executing|stack traceback/.test(event.message)))
          ) {
            failures.push({ action, message: event.message });
          }
          if (event.type === 'neovimUI') {
            for (const message of event.state.messages) {
              if (['emsg', 'echoerr', 'lua_error'].includes(message.kind)) {
                failures.push({
                  action,
                  message: message.content.map(([, text]) => text).join('')
                });
              }
            }
          }
        });
        const current = session;
        const lua = (code: string): Promise<unknown> =>
          current.client.request('nvim_exec_lua', [code, []]);
        const step = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
          action = name;
          await operation();
          await current.inputMode();
          await lua('vim.cmd.redraw(); vim.wait(120); vim.cmd.redraw()');
          assert.deepEqual(failures, [], `${language}: ${name}`);
        };
        const text = (): Promise<unknown> =>
          lua('return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n") .. "\\n"');
        const edit = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
          await step(name, operation);
          await step(`undo ${name}`, async () => {
            for (let attempts = 0; attempts < 10 && (await current.modified()); attempts++) {
              await current.input('u');
              await current.inputMode();
            }
            assert.equal(await text(), source, `${name} must undo without losing text`);
          });
        };
        await current.attach(100, 34);
        await step('open', () => current.openFile(path));
        await lua(`assert(vim.wait(20000, function()
        for _, client in ipairs(vim.lsp.get_clients({bufnr=0})) do
          if client.initialized then return true end
        end
      end), 'The real language server must initialize')`);
        await step('decorations', () =>
          lua("require('nido_sticky').set_method_separators(true); vim.cmd('normal! 20Gzt')")
        );
        assert.ok(grid.stickyScroll?.scopes.length);
        await edit('Unicode typing, Backspace and line break', () =>
          current.input('4G0i// 日本語😀é<BS><CR>temporary<Esc>')
        );
        await edit('automatic brace body', () => current.input('Go{<CR>temporary<Esc>'));
        await edit('multiline paste', () => current.paste('// 日本語😀\n({[]})\n'));
        await edit('delete all', () => current.input('ggVGx'));
        await edit('delete header', () => current.input('ggdd'));
        await edit('join lines', () => current.input('ggJ'));
        await edit('visual indentation', () => current.input('ggVG>'));
        await edit('block insertion', () => current.input('gg<C-v>2jIx<Esc>'));
        await edit('substitute', () => current.input(':%s/values/items/g<CR>'));
        await edit('undo and redo', () => current.input('ggA // changed<Esc>u<C-r>'));
        for (const keys of [
          'gg50j20kGzz<C-d><C-u><PageDown><PageUp>',
          '/values<CR>nN*#<Esc>',
          ':setlocal foldmethod=manual<CR>ggzf10jzozczR',
          'i<C-c>',
          'v<C-c>',
          'd<C-c>',
          '/values<C-c>',
          ':echo "cancel"<C-c>'
        ]) {
          await step(`keys ${keys}`, () => current.input(keys));
        }
        await step('fractional wheel scrolling', async () => {
          for (const lines of [0.25, 1.75, 20.5, -50, -0.5, 200, -200]) {
            await current.scroll(lines, false, true);
          }
          await current.prefetchScroll(false);
          await current.prefetchScroll(true);
        });
        await step('click after scrolling', () => current.click(8, 18));
        await step('resize and zoom-sized grids', async () => {
          for (const [columns, rows] of [
            [20, 8],
            [80, 25],
            [120, 48],
            [100, 34]
          ]) {
            await current.resize(columns, rows);
            await lua('vim.cmd.redraw()');
          }
        });
        await edit('buffer switch with unsaved input', async () => {
          await current.input('ggA // pending<Esc>');
          await current.inputMode();
          const modified = await text();
          await current.openFile('other.txt');
          await current.openFile(path);
          assert.equal(await text(), modified);
        });
        await step('save and delayed LSP updates', async () => {
          await current.save();
          await lua('vim.wait(400); vim.cmd.redraw({bang=true})');
        });
        assert.equal(await readFile(join(root, path), 'utf8'), source);
      } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  );
}

for (const area of [
  'indent',
  'bracket guides',
  'viewport',
  'bracket analysis',
  'bracket context'
] as const) {
  test(`${area} recovers from a highlighting interrupt without showing an editor error`, async () => {
    const failures: string[] = [];
    const grid = new Grid();
    const session = await Session.create(process.cwd(), (event) => {
      if (event.type === 'redraw') grid.apply(event.events);
      if (event.type === 'error' || event.type === 'notification') {
        failures.push(event.message);
      }
    });
    try {
      await session.client.request('nvim_exec_lua', [
        `
        local api = vim.api
        local buffer = api.nvim_get_current_buf()
        local lines = {'impl Screen {', '  fn prepare(&mut self) {'}
        for _ = 1, 80 do lines[#lines + 1] = '    work();' end
        lines[#lines + 1], lines[#lines + 2] = '  }', '}'
        api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
        vim.bo.syntax = 'rust'
        api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
        assert(vim.wait(3000, function() return require('nido_brackets').ready(buffer) end, 5))
        vim.wait(300)
        vim.cmd('normal! 20Gzt')
        vim.cmd.redraw({bang=true})
        local area = ...
        local target = area == 'viewport' and require('nido_scroll')
          or area == 'bracket context' and api or vim.fn
        local key = area == 'viewport' and 'view_distance'
          or area == 'indent' and 'indent'
          or area == 'bracket context' and 'nvim_buf_call'
          or area == 'bracket analysis' and 'synstack' or 'screenpos'
        local original, attempts = target[key], 0
        local expected = area == 'viewport' and 'session.lua'
          or area == 'indent' and 'nido_indent.lua' or 'nido_brackets.lua'
        target[key] = function(...)
          if area == 'viewport' or debug.getinfo(2, 'S').source:find(expected, 1, true) then
            attempts = attempts + 1
            if attempts == 1 then error('Keyboard interrupt') end
          end
          return original(...)
        end
        local ok, err = pcall(function()
          if area == 'bracket analysis' or area == 'bracket context' then
            api.nvim_buf_set_text(buffer, 3, 4, 3, 4, {' '})
            api.nvim_exec_autocmds('TextChanged', {buffer=buffer})
            vim.wait(120)
          elseif area == 'viewport' then
            vim.cmd.normal({args={'3' .. string.char(5)}, bang=true})
          end
          vim.cmd.redraw({bang=true})
        end)
        target[key] = original
        assert(ok, err)
        assert(attempts > 0, 'The injected interrupt must reach the target operation')
        vim.wait(120)
        vim.cmd.redraw({bang=true})
      `,
        [area]
      ]);
      await session.client.request('nvim_exec_lua', ['vim.wait(50)', []]);
      assert.deepEqual(failures, [], `${area} must not surface a cancelled redraw as a failure`);
      await session.client.request('nvim_exec_lua', [
        `
        local buffer = vim.api.nvim_get_current_buf()
        assert(vim.wait(3000, function() return require('nido_brackets').ready(buffer) end, 5),
          'Cancelled analysis must recover without another edit')
      `,
        []
      ]);
      await session.input('jix<Esc>');
      assert.equal(await session.inputMode(), 'n');
      await session.client.request('nvim_exec_lua', [
        `
        local buffer = vim.api.nvim_get_current_buf()
        assert(vim.wait(3000, function() return require('nido_brackets').ready(buffer) end, 5))
        vim.cmd.redraw({bang=true})
      `,
        []
      ]);
      assert.ok(grid.bracketGuides.length, 'Fresh bracket guides must recover');
      assert.ok(grid.stickyScroll?.scopes.length, 'Fresh sticky scopes must recover');
      assert.deepEqual(failures, []);
    } finally {
      await session.stop();
    }
  });
}

test('unexpected bracket analysis failures stay visible and a new edit recovers', async () => {
  const messages: string[] = [];
  const session = await Session.create(process.cwd(), (event) => {
    if (event.type === 'notification') messages.push(event.message);
  });
  try {
    await session.client.request('nvim_exec_lua', [
      `
      local api, original = vim.api, vim.fn.synstack
      vim.fn.synstack = function(...)
        if debug.getinfo(2, 'S').source:find('nido_brackets.lua', 1, true) then
          error('bracket-fixture-unexpected')
        end
        return original(...)
      end
      api.nvim_buf_set_lines(0, 0, -1, false, {'fn main() {', '  work();', '}'})
      api.nvim_exec_autocmds('TextChanged', {buffer=api.nvim_get_current_buf()})
      vim.wait(120)
      vim.fn.synstack = original
    `,
      []
    ]);
    assert.ok(messages.some((message) => message.includes('bracket-fixture-unexpected')));
    await session.input('jix<Esc>');
    await session.inputMode();
    await session.client.request('nvim_exec_lua', [
      `
      local buffer = vim.api.nvim_get_current_buf()
      assert(vim.wait(3000, function() return require('nido_brackets').ready(buffer) end, 5))
    `,
      []
    ]);
  } finally {
    await session.stop();
  }
});

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
