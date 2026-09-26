import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid, vimKey } from '../src/renderer/src/grid';
import { readLayout, writeLayout } from '../src/main/persistence';

test('a renderer joining after Neovim startup receives syntax colors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-colors-'));
  let grid: Grid | undefined;
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'main.rs'), 'fn main() { let greeting = "hello"; }\n');
    session = await Session.create(root, (event) => {
      if (event.type === 'redraw') grid?.apply(event.events);
    });
    await session.openFile('main.rs');
    // The React renderer does not exist while Session.create initializes Neovim.
    grid = new Grid();
    await session.attach(90, 25);
    await session.client.request('nvim_eval', ['1']);
    const row = grid.cells.find((cells) =>
      cells
        .map((cell) => cell.text)
        .join('')
        .includes('fn main')
    );
    assert.ok(row);
    const start = row
      .map((cell) => cell.text)
      .join('')
      .indexOf('fn main');
    assert.equal(grid.highlights.get(row[start].highlight)?.foreground, 0x569cd6);
    const string = row
      .map((cell) => cell.text)
      .join('')
      .indexOf('hello');
    assert.equal(grid.highlights.get(row[string].highlight)?.foreground, 0xce9178);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Nido uses bundled Neovim and isolated config', async () => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.attach(80, 24);
    const result = await session.client.request('nvim_exec_lua', [
      `assert(vim.wait(5000, function() return vim.v.vim_did_enter == 1 end))
      assert(vim.env.NVIM_APPNAME == 'nido')
      local found = false
      for _, script in ipairs(vim.fn.getscriptinfo()) do
        if script.name:match('nido[/\\\\]init.lua$') then found = true end
      end
      assert(found, 'Nido init.lua must be sourced')
      assert(vim.v.progpath:match('nvim%-win64[/\\\\]bin[/\\\\]nvim.exe$'))
      assert(package.loaded.lazy == nil and package.loaded.noice == nil)
      assert(#vim.opt.runtimepath:get() == 1)
      return {vim.g.nido, vim.o.showtabline, vim.o.laststatus, vim.o.showmode}`,
      []
    ]);
    assert.deepEqual(result, [true, 0, 0, false]);
  } finally {
    await session.stop();
  }
});

test('workspace snapshot restores each cursor and tolerates missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-restore-'));
  const sessions: Session[] = [];
  try {
    await writeFile(join(root, 'first.txt'), 'first line\nsecond line\nthird line\n');
    await writeFile(join(root, 'second.txt'), 'another file\n');
    const first = await Session.create(root, () => {});
    sessions.push(first);
    await first.openFile('first.txt');
    await first.client.request('nvim_win_set_cursor', [0, [3, 4]]);
    await first.openFile('second.txt');
    await first.client.request('nvim_win_set_cursor', [0, [1, 6]]);
    const snapshot = await first.snapshot();
    assert.deepEqual(
      snapshot.files.map((f) => [f.line, f.column]),
      [
        [3, 4],
        [1, 6]
      ]
    );
    const path = join(root, 'workspaces.json');
    assert.deepEqual((await readLayout(path)).workspaces, []);
    await writeLayout(path, { version: 1, workspaces: [snapshot], active: 0 });
    await first.stop();
    const restored = await Session.create(root, () => {});
    sessions.push(restored);
    assert.deepEqual(await restored.restore((await readLayout(path)).workspaces[0]), []);
    await restored.attach(90, 30);
    assert.deepEqual(await restored.snapshot(), snapshot);
    await restored.stop();
    await writeFile(join(root, 'first.txt'), 'short\n');
    await rm(join(root, 'second.txt'));
    const changed = await Session.create(root, () => {});
    sessions.push(changed);
    assert.equal((await changed.restore(snapshot)).length, 1);
    assert.equal((await changed.snapshot()).files[0].line, 1);
    await writeFile(path, '{broken');
    await assert.rejects(readLayout(path));
    await writeFile(path, JSON.stringify({ version: 1, active: 0, workspaces: [{ root }] }));
    await assert.rejects(readLayout(path), /Invalid/);
  } finally {
    await Promise.all(sessions.map((s) => s.stop()));
    await rm(root, { recursive: true, force: true });
  }
});

test('grid updates preserve highlights, wide characters and scroll regions', () => {
  const grid = new Grid();
  grid.apply([
    ['grid_resize', [1, 5, 3]],
    [
      'grid_line',
      [
        1,
        0,
        0,
        [
          ['日', 2],
          ['', 2],
          ['x', 3, 3]
        ]
      ]
    ],
    ['grid_line', [1, 1, 0, [['b', 4, 5]]]],
    ['grid_line', [1, 2, 0, [['c', 5, 5]]]],
    ['grid_scroll', [1, 0, 3, 0, 5, 1, 0]]
  ]);
  assert.deepEqual(grid.cells[0][0], { text: 'b', highlight: 4 });
  assert.equal(grid.cells[1][4].text, 'c');
  assert.equal(grid.cells[2][0].text, ' ');
  grid.apply([['grid_scroll', [1, 0, 3, 0, 5, -1, 0]]]);
  assert.equal(grid.cells[1][0].text, 'b');
  assert.equal(grid.apply([['flush']]), true);
  assert.equal(
    vimKey({
      key: '<',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      isComposing: false
    }),
    '<LT>'
  );
  assert.equal(
    vimKey({
      key: 'Tab',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      isComposing: false
    }),
    '<S-Tab>'
  );
  assert.equal(
    vimKey({
      key: 'Enter',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: true
    }),
    null
  );
});

test('two real Neovim sessions edit, save, switch buffers and isolate state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-test-'));
  const sessions: Session[] = [];
  try {
    await mkdir(join(root, 'one'));
    await mkdir(join(root, 'two'));
    await writeFile(join(root, 'one', 'first.ts'), 'const original = 1;\n');
    await writeFile(join(root, 'one', 'second.ts'), 'const second = 2;\n');
    await writeFile(join(root, 'outside.txt'), 'outside');
    const grids = [new Grid(), new Grid()];
    for (const [i, name] of ['one', 'two'].entries()) {
      const session = await Session.create(join(root, name), (event) => {
        if (event.type === 'redraw') grids[i].apply(event.events);
      });
      sessions.push(session);
      await session.attach(80, 24);
    }
    const [first, second] = sessions;
    assert.notEqual(first.process.pid, second.process.pid);
    await first.openFile('first.ts');
    await first.input('gg0i// 日本語<CR><Esc>');
    await first.client.request('nvim_eval', ['1']);
    assert.equal(await first.modified(), true);
    assert.equal(await second.modified(), false);
    await assert.rejects(() => second.save(), /file name|filename/i);
    await first.save();
    assert.match(await readFile(join(root, 'one', 'first.ts'), 'utf8'), /日本語/);
    await first.openFile('second.ts');
    const current = (await first.client.request('nvim_exec_lua', [
      'return vim.api.nvim_get_current_buf()',
      []
    ])) as number;
    await first.input('A // changed<Esc>');
    await first.client.request('nvim_eval', ['1']);
    await assert.rejects(() => first.closeBuffer(current), /modified|changes/i);
    await first.saveAll();
    await first.closeBuffer(current);
    assert.equal(await first.modified(), false);
    await assert.rejects(() => first.path('../outside.txt'), /outside/);
    assert.deepEqual((await first.files('')).map((f) => f.name).sort(), ['first.ts', 'second.ts']);
    assert.deepEqual((await first.findFiles()).map((f) => f.name).sort(), ['first.ts', 'second.ts']);
    assert.ok(grids[0].cells.length);
    assert.ok(grids[0].cells.some((r) => r.some((c) => c.text !== ' ')));
    await first.resize(90, 30);
  } finally {
    await Promise.all(sessions.map((session) => session.stop()));
    await rm(root, { recursive: true, force: true });
  }
});
