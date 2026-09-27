import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid, vimKey } from '../src/renderer/src/grid';
import { accumulateScroll, scrollOffset } from '../src/renderer/src/scroll';
import { readLayout, writeLayout } from '../src/main/persistence';
import { fileDecorations, gitFileKey } from '../src/renderer/src/fileDecorations';
import type { Redraw } from '../src/shared/types';

test('hover without an LSP never opens help and successful saves stay quiet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-hover-'));
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'sample.ts'), 'const state = 1;\n');
    session = await Session.create(root, () => {});
    await session.openFile('sample.ts');
    await session.client.request('nvim_exec_lua', [
      `vim.lsp.enable('typescript', false)
for _, key in ipairs({'K', '<C-k>'}) do
  local mapping = vim.fn.maparg(key, 'n', false, true)
  assert(type(mapping.callback) == 'function')
  mapping.callback()
  assert(#vim.api.nvim_list_wins() == 1)
  assert(vim.bo.filetype == 'typescript')
end
local calls = 0
local get_clients, hover = vim.lsp.get_clients, vim.lsp.buf.hover
vim.lsp.get_clients = function() return {{}} end
vim.lsp.buf.hover = function(opts)
  calls = calls + 1
  assert(opts.border == 'rounded' and opts.max_height <= 20)
end
vim.fn.maparg('K', 'n', false, true).callback()
vim.lsp.get_clients, vim.lsp.buf.hover = get_clients, hover
assert(calls == 1)
vim.cmd('messages clear')`, []
    ]);
    await session.save(false);
    assert.equal(await readFile(join(root, 'sample.ts'), 'utf8'), 'const state = 1;\n');
    assert.doesNotMatch(JSON.stringify(await session.client.request('nvim_exec2', ['messages', { output: true }])), /written|\[w\]/);
    await session.client.request('nvim_exec_lua', ['vim.bo.readonly = true', []]);
    await assert.rejects(session.save(false), /readonly|E45/);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('wheel scrolling can retain the edit position and resumes input and paste at the anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-scroll-anchor-'));
  let session: Session | undefined;
  try {
    await writeFile(join(root, 'lines.txt'), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    session = await Session.create(root, () => {});
    await session.openFile('lines.txt');
    await session.client.request('nvim_exec_lua', ['vim.api.nvim_win_set_cursor(0, {20, 0})', []]);
    await session.scroll(60, false);
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ["return require('nido_scroll').cursor()", []]),
      [20, 0]
    );
    assert.equal(
      await session.client.request('nvim_exec_lua', ["return require('nido_scroll').screen_cursor().row", []]),
      -1
    );
    await session.input('iX<Esc>');
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(await session.client.request('nvim_eval', ['getline(20)']), 'Xline 20');
    await session.scroll(60, false);
    await session.paste('Y');
    assert.match(String(await session.client.request('nvim_eval', ['getline(20)'])), /Y/);
    await session.scroll(60, true);
    assert.equal(await session.client.request('nvim_exec_lua', ["return require('nido_scroll').cursor()", []]), null);
    assert.ok(Number(await session.client.request('nvim_eval', ["line('.')"])) > 20);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('split redraw notifications remain invisible until flush and keep scroll metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-redraw-'));
  const frames: Redraw[] = [];
  let session: Session | undefined;
  try {
    session = await Session.create(root, (event) => {
      if (event.type === 'redraw') {
        frames.push(event.events);
      }
    });
    await session.client.request('nvim_eval', ['1']);
    frames.length = 0;
    const scroll = [1, 0, 23, 0, 80, -3, 0];
    const first: Redraw = [['grid_line', [1, 0, 0, [['first', 0]]]]];
    const second: Redraw = [['grid_line', [1, 1, 0, [['second', 0]]]]];
    session.client.emit('notification', 'nido:scroll', [scroll]);
    session.client.emit('notification', 'redraw', first);
    session.client.emit('notification', 'redraw', second);
    assert.equal(frames.length, 0);
    session.client.emit('notification', 'redraw', [['flush', []], ...first]);
    assert.deepEqual(frames, [[['nido_scroll', scroll], ...first, ...second, ['flush', []]]]);
    session.client.emit('notification', 'redraw', [['flush', []]]);
    assert.deepEqual(frames[1], [...first, ['flush', []]]);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('save formats before writing only when enabled and a formatter is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-format-save-'));
  let session: Session | undefined;
  try {
    const path = join(root, 'sample.txt');
    await writeFile(path, 'original\n');
    session = await Session.create(root, () => {});
    await session.openFile('sample.txt');
    await session.client.request('nvim_exec_lua', [
      `local get_clients = vim.lsp.get_clients
vim.lsp.get_clients = function(opts)
  if opts and opts.bufnr == 0 and opts.method == 'textDocument/formatting' then
    return { {} }
  end
  return get_clients(opts)
end
vim.lsp.buf.format = function(opts)
  assert(opts.async == false and opts.timeout_ms == 3000)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {'formatted'})
end`,
      []
    ]);
    await session.save(false);
    assert.equal(await readFile(path, 'utf8'), 'original\n');
    await session.save(true);
    assert.equal(await readFile(path, 'utf8'), 'formatted\n');
    await session.client.request('nvim_exec_lua', [
      "vim.lsp.get_clients = function() return {} end; vim.api.nvim_buf_set_lines(0, 0, -1, false, {'no formatter'})",
      []
    ]);
    await session.save(true);
    assert.equal(await readFile(path, 'utf8'), 'no formatter\n');
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('file decorations propagate to parents and prioritize errors without losing Git status', () => {
  const git = { 'c:/repo/src/deep/a.rs': { code: 'M', title: 'Git: Modified' } };
  const result = fileDecorations('C:\\repo', git, {
    'C:\\repo\\src\\deep\\a.rs': 2,
    'C:/repo/src/b.rs': 1,
    'C:/repository/other.rs': 1
  });
  assert.equal(result['c:/repo/src/deep'].code, 'M');
  assert.equal(result['c:/repo/src/deep'].diagnostic, 'warning');
  assert.equal(result['c:/repo/src'].diagnostic, 'error');
  assert.equal(result['c:/repo'].diagnostic, 'error');
  assert.equal(result['c:/repo/src/deep/a.rs'].code, 'M');
  assert.equal(fileDecorations('C:/repo', git)['c:/repo/src'].diagnostic, undefined);
  assert.deepEqual(fileDecorations('C:/repo', {}, {}), {});
  assert.equal(fileDecorations('C:/repo', {}, { 'C:/repository/a.rs': 1 })['c:/repo'], undefined);
});

test('Neovim publishes and clears diagnostics including unopened files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-diagnostics-'));
  let session: Session | undefined;
  try {
    session = await Session.create(root, () => {});
    const path = join(root, 'unopened.txt');
    await session.client.request('nvim_exec_lua', [
      "local path = ...; local b = vim.fn.bufadd(path); vim.fn.bufload(b); vim.diagnostic.set(vim.api.nvim_create_namespace('test'), b, {{lnum=0,col=0,severity=2,message='Warning'}, {lnum=0,col=0,severity=1,message='Error'}})",
      [path]
    ]);
    for (let i = 0; i < 50 && !Object.keys(session.state.diagnostics || {}).length; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const entries = Object.entries(session.state.diagnostics || {});
    assert.equal(gitFileKey(entries[0][0]), gitFileKey(path));
    assert.equal(entries[0][1], 1);
    assert.equal(session.state.problems?.length, 2);
    const version = session.state.diagnosticsVersion!;
    await session.openProblem(1, version);
    assert.equal(await session.client.request('nvim_eval', ["expand('%:p')"]), path);
    await session.client.request('nvim_exec_lua', ["vim.diagnostic.reset(vim.api.nvim_create_namespace('test'))", []]);
    for (let i = 0; i < 50 && Object.keys(session.state.diagnostics || {}).length; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.deepEqual(session.state.diagnostics, {});
    assert.deepEqual(session.state.problems, []);
    await assert.rejects(session.openProblem(1, version), /Problems have changed/);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'terminal sessions run PowerShell, preserve their shell and stop with their workspace',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-terminal-'));
    let session: Session | undefined;
    try {
      session = await Session.create(root, () => {});
      const [terminal, same] = await Promise.all([session.openTerminal(), session.openTerminal()]);
      assert.equal(terminal, same);
      assert.equal(terminal.workspace.kind, 'terminal');
      await terminal.input("$nidoValue = 'kept'; Set-Content -Path first.txt -Value $nidoValue<CR>");
      const waitFor = async (name: string): Promise<string> => {
        for (let i = 0; i < 100; i++) {
          try {
            return await readFile(join(root, name), 'utf8');
          } catch {
            await new Promise((done) => setTimeout(done, 100));
          }
        }
        throw new Error(`Terminal did not create ${name}`);
      };
      assert.match(await waitFor('first.txt'), /kept/);
      await terminal.resize(100, 20);
      assert.equal(await session.openTerminal(), terminal);
      await terminal.input('Set-Content -Path second.txt -Value $nidoValue<CR>');
      assert.match(await waitFor('second.txt'), /kept/);
      assert.equal((await session.snapshot()).terminal, true);
      assert.equal((await terminal.snapshot()).kind, 'terminal');
      await session.stop();
      assert.notEqual(terminal.process.exitCode, null);
    } finally {
      await session?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('bracket pairs share depth colors, ignore strings and comments, and refresh after edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-brackets-'));
  let session: Session | undefined;
  try {
    const content = 'fn main() {\n  let x = ([1]);\n  let s = "([{}])"; // []\n  /* {\n  } */\n}\n';
    await writeFile(join(root, 'pairs.txt'), content);
    session = await Session.create(root, () => {});
    await session.openFile('pairs.txt');
    await session.client.request('nvim_exec_lua', ['vim.bo.syntax = "rust"', []]);
    const marks = async (): Promise<[number, number, number, { hl_group: string }][]> => {
      await session!.client.request('nvim_exec_lua', ['vim.wait(150); vim.cmd("redraw!")', []]);
      return session!.client.request('nvim_exec_lua', [
        "return vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('nido_brackets'), 0, -1, {details=true})",
        []
      ]) as Promise<[number, number, number, { hl_group: string }][]>;
    };
    const result = await marks();
    assert.equal(result.length, 8);
    const color = (row: number, column: number): string | undefined =>
      result.find((mark) => mark[1] === row && mark[2] === column)?.[3].hl_group;
    assert.equal(color(0, 7), color(0, 8));
    assert.equal(color(0, 10), color(5, 0));
    assert.equal(color(1, 10), color(1, 14));
    assert.equal(color(1, 11), color(1, 13));
    assert.notEqual(color(0, 10), color(1, 10));
    assert.notEqual(color(1, 10), color(1, 11));
    await session.client.request('nvim_exec_lua', [
      "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'()'}); vim.api.nvim_exec_autocmds('TextChanged', {buffer=0})",
      []
    ]);
    assert.equal((await marks()).length, 2);
    assert.equal(await readFile(join(root, 'pairs.txt'), 'utf8'), content);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('indent guides follow depth, tabs and blank lines without changing text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-indent-'));
  const grid = new Grid();
  let session: Session | undefined;
  try {
    const content = 'root\n  child\n    nested\n\n    sibling\n\tchild\nroot\n';
    await writeFile(join(root, 'indent.txt'), content);
    session = await Session.create(root, (event) => {
      if (event.type === 'redraw') {
        grid.apply(event.events);
      }
    });
    await session.openFile('indent.txt');
    await session.client.request('nvim_exec_lua', [
      'vim.bo.shiftwidth = 2; vim.bo.tabstop = 2; vim.cmd("redraw!")',
      []
    ]);
    await session.client.request('nvim_eval', ['1']);
    const guides = (row: number) => grid.cells[row].filter((cell) => cell.text === '│');
    assert.equal(guides(0).length, 0);
    assert.equal(guides(1).length, 1);
    assert.equal(guides(2).length, 2);
    assert.equal(guides(3).length, 2);
    assert.equal(guides(5).length, 1);
    const colors = guides(2).map((cell) => grid.highlights.get(cell.highlight)?.foreground);
    assert.deepEqual(colors, [0x75633f, 0x476a86]);
    await session.client.request('nvim_exec_lua', [
      'vim.wo.wrap = false; vim.api.nvim_win_set_cursor(0, {3, 4}); vim.fn.winrestview({leftcol=2}); vim.cmd("redraw!")',
      []
    ]);
    await session.client.request('nvim_eval', ['1']);
    assert.equal(guides(2).length, 1);
    assert.equal(grid.highlights.get(guides(2)[0].highlight)?.foreground, 0x476a86);
    assert.equal(await session.modified(), false);
    assert.equal(await readFile(join(root, 'indent.txt'), 'utf8'), content);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('scroll follows pixel distance and preserves insert mode and file contents', async () => {
  assert.equal(scrollOffset(100, 0), 100);
  assert.equal(scrollOffset(100, 60), 12.5);
  assert.equal(scrollOffset(-100, 60), -12.5);
  assert.equal(scrollOffset(100, 120), 0);
  assert.equal(scrollOffset(100, 500), 0);
  let remainder = 0,
    lines = 0;
  for (let i = 0; i < 25; i++) {
    const result = accumulateScroll(remainder, 1, 0, 25, 500);
    remainder = result.remainder;
    lines += result.lines;
  }
  assert.equal(lines, 1);
  assert.deepEqual(accumulateScroll(0, 3, 1, 25, 500), { lines: 3, remainder: 0 });
  assert.equal(accumulateScroll(0, 1, 2, 25, 500).lines, 20);
  assert.equal(accumulateScroll(20, -25, 0, 25, 500).lines, -1);
  assert.equal(accumulateScroll(0, 0, 0, 25, 500).lines, 0);
  const root = await mkdtemp(join(tmpdir(), 'nido-scroll-'));
  let session: Session | undefined;
  try {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(root, 'scroll.txt'), content);
    session = await Session.create(root, () => {});
    await session.openFile('scroll.txt');
    await session.scroll(1);
    assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 2);
    await session.input('i');
    await session.client.request('nvim_eval', ['1']);
    await session.scroll(2);
    assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 4);
    assert.equal(await session.client.request('nvim_eval', ['mode()']), 'i');
    assert.equal(await session.modified(), false);
    await session.scroll(-1);
    assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('line endings normalize only in memory until saved, preserve content and support undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-eol-'));
  let session: Session | undefined;
  try {
    const original = 'one\r\ntwo\ninside\rcarriage\r\nlast';
    await writeFile(join(root, 'mixed.txt'), original);
    await writeFile(join(root, 'dos.txt'), 'one\r\ntwo\r\n');
    const notices: string[] = [];
    session = await Session.create(root, (event) => {
      if (event.type === 'error') notices.push(event.message);
    });
    const lua = (code: string): Promise<unknown> => session!.client.request('nvim_exec_lua', [code, []]);
    await session.openFile('mixed.txt');
    await lua('return 1');
    assert.equal(session.state.lineEnding, 'Mixed');
    assert.ok(notices.some((message) => message.includes('Mixed line endings')));
    await session.client.request('nvim_win_set_cursor', [0, [2, 1]]);
    await session.setLineEnding('LF');
    await lua('return 1');
    assert.equal(session.state.lineEnding, 'LF');
    assert.equal(await session.bufferModified(session.state.current), true);
    assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [2, 1]);
    assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), original);
    await lua('vim.cmd.undo()');
    assert.equal(await lua("return require('nido_eol').detect()"), 'Mixed');
    await session.setLineEnding('LF');
    await session.save();
    assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), 'one\ntwo\ninside\rcarriage\nlast');
    await session.setLineEnding('CRLF');
    await session.save();
    assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), 'one\r\ntwo\r\ninside\rcarriage\r\nlast');
    await session.openFile('dos.txt');
    await lua('return 1');
    assert.equal(session.state.lineEnding, 'CRLF');
    await session.setLineEnding('LF');
    assert.equal(await session.bufferModified(session.state.current), true);
    await session.save();
    assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), 'one\ntwo\n');
    await assert.rejects(session.setLineEnding('invalid' as 'LF'));
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

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
      local paths = vim.opt.runtimepath:get()
      assert(#paths == 3)
      assert(vim.g.colors_name == 'azami')
      assert(vim.api.nvim_get_hl(0, {name='Normal'}).bg == 0x141414)
      assert(paths[1] == vim.env.VIMRUNTIME)
      assert(paths[2] == vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim')
      for _, language in ipairs({'markdown', 'markdown_inline', 'c', 'lua', 'query', 'vim', 'vimdoc'}) do
        assert(vim.treesitter.language.add(language), language .. ' parser must load')
      end
      local fence = string.rep(string.char(96), 3)
      local buf, win = vim.lsp.util.open_floating_preview({'# Documentation', '', '**hello**', '', fence .. 'rust', 'fn example() {}', fence}, 'markdown', {})
      assert(vim.treesitter.get_parser(buf):parse()[1])
      vim.api.nvim_win_close(win, true)
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
      key: 'F12',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      isComposing: false
    }),
    '<S-F12>'
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
