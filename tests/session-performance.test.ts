import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { SessionEvents } from '../src/main/sessionEvents';
import { Grid } from '../src/renderer/src/grid';
import type { NidoEvent, SessionState, Redraw } from '../src/shared/types';

test('cursor state publications enumerate LSP clients once without caching their lifecycle', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    const result = await session.client.request('nvim_exec_lua', [
      `
local original, notify = vim.lsp.get_clients, vim.rpcnotify
local enumerations, publications = 0, 0
vim.lsp.get_clients = function(filter)
  if debug.getinfo(2, 'n').name == 'lsp_status' then enumerations = enumerations + 1 end
  return original(filter)
end
vim.rpcnotify = function(channel, method, ...)
  if method == 'nido:state' then publications = publications + 1 end
  return notify(channel, method, ...)
end
local ok, err = pcall(function()
  for event=1,40 do
    local before = publications
    vim.api.nvim_exec_autocmds('CursorMoved', {})
    assert(vim.wait(1000, function() return publications > before end, 1))
  end
end)
vim.lsp.get_clients, vim.rpcnotify = original, notify
assert(ok, err)
assert(enumerations == publications,
  ('LSP client enumerations=%d for publications=%d'):format(enumerations, publications))
return {cursorEvents=40, lspClientEnumerations=enumerations, publications=publications}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('LSP status keeps global progress and current-buffer names live through lifecycle changes', async () => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
local first, second = api.nvim_get_current_buf(), api.nvim_create_buf(true, false)
local original, notify = vim.lsp.get_clients, vim.rpcnotify
local clients = {
  {id=902, name='beta', initialized=true, attached_buffers={[first]=true}},
  {id=901, name='alpha', initialized=true, attached_buffers={[second]=true}},
  {id=903, name='starting', initialized=false, attached_buffers={[first]=true}},
  {id=904, name='global', initialized=true, attached_buffers={}},
}
local state, publications = nil, 0
vim.lsp.get_clients = function(filter)
  -- Keep all other editor features on real clients. Match Neovim's public
  -- get_clients filtering and ordering for the status publication alone.
  if debug.getinfo(2, 'n').name ~= 'lsp_status' then return original(filter) end
  local result = {}
  for _, client in ipairs(clients) do
    local buffer = filter and filter.bufnr
    if client.initialized and (buffer == nil or client.attached_buffers[buffer == 0
        and api.nvim_get_current_buf() or buffer]) then
      result[#result+1] = client
    end
  end
  return result
end
vim.rpcnotify = function(channel, method, ...)
  if method == 'nido:state' then
    state, publications = ..., publications + 1
  end
  return notify(channel, method, ...)
end
local function published(event, options)
  local before = publications
  api.nvim_exec_autocmds(event or 'CursorMoved', options or {})
  assert(vim.wait(1000, function() return publications > before end, 1))
  return state
end
local function progress(id, token, value)
  return published('LspProgress', {data={client_id=id, params={token=token, value=value}}})
end
local ok, err = pcall(function()
  assert(published().lsp == 'beta', 'only initialized clients attached to current buffer are shown')
  progress(901, 'index', {kind='begin', title='Index', message='workspace', percentage=42})
  progress(904, 'load', {kind='begin', title='Load'})
  assert(state.lspProgress == 'alpha: Index — workspace (42%) / global: Load', vim.inspect(state))
  progress(903, 'init', {kind='begin', title='Initialize'})
  assert(not state.lspProgress:find('starting', 1, true), 'uninitialized clients keep get_clients semantics')
  clients[3].initialized = true
  published('LspAttach', {buffer=first, data={client_id=903}})
  assert(state.lsp == 'beta, starting', 'client list retains enumeration order')
  assert(state.lspProgress:find('starting: Initialize', 1, true), 'initialized clients become visible immediately')
  clients[2].attached_buffers[first] = true
  published('LspAttach', {buffer=first, data={client_id=901}})
  assert(state.lsp == 'beta, alpha, starting', 'newly attached clients appear without a cache')
  clients[1].attached_buffers[first] = nil
  published('LspDetach', {buffer=first, data={client_id=902}})
  assert(state.lsp == 'alpha, starting', 'detached clients disappear')
  api.nvim_set_current_buf(second)
  assert(published('BufEnter', {buffer=second}).lsp == 'alpha', 'buffer switches use the new attachment set')
  progress(901, 'index', {kind='report', percentage=80})
  assert(state.lspProgress:find('alpha: Index — workspace (80%)', 1, true), 'progress reports retain their title')
  table.remove(clients, 2)
  published('LspDetach', {buffer=second, data={client_id=901}})
  assert(state.lsp == '' and not state.lspProgress:find('alpha', 1, true), 'exited clients and progress disappear')
  progress(904, 'load', {kind='end'})
  assert(state.lspProgress == 'starting: Initialize', 'finished progress disappears')
  clients = {}
  assert(published().lspProgress == '' and state.lsp == '', 'missing clients leave no stale status')
end)
vim.lsp.get_clients, vim.rpcnotify = original, notify
assert(ok, err)
`,
      []
    ]);
  } finally {
    await session.stop();
  }
});

test('local LSP text edits avoid reading the full document and preserve UTF-16 ranges', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    const result = await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
local buffer = api.nvim_get_current_buf()
local lines = {}
for row=1,5000 do lines[row] = 'left 😀 right' end
api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
local original, full_reads = api.nvim_buf_get_lines, 0
api.nvim_buf_get_lines = function(buf, first, last, strict)
  if (buf == buffer or buf == 0) and first == 0 and last == -1 then full_reads=full_reads+1 end
  return original(buf, first, last, strict)
end
local ok, err = pcall(function()
  vim.lsp.util.apply_text_edits({{
    range={start={line=2499, character=5}, ['end']={line=2499, character=7}}, newText='λ',
  }}, buffer, 'utf-16')
  assert(original(buffer, 2499, 2500, false)[1] == 'left λ right', 'UTF-16 edit retains surrounding text')
  assert(api.nvim_buf_line_count(buffer) == 5000)
  assert(full_reads == 0, 'a local edit read all 5000 lines: ' .. full_reads)
  vim.lsp.util.apply_text_edits({{
    range={start={line=0, character=0}, ['end']={line=0, character=4}}, newText='top',
  }}, buffer, 'utf-16')
  assert(original(buffer, 0, 1, false)[1] == 'top 😀 right')
  assert(full_reads == 0, 'a leading local edit read the full buffer')
  vim.lsp.util.apply_text_edits({{
    range={start={line=4998, character=5}, ['end']={line=4999, character=7}}, newText='joined',
  }}, buffer, 'utf-16')
  assert(api.nvim_buf_line_count(buffer) == 4999)
  assert(original(buffer, 4998, 4999, false)[1] == 'left joined right')
  assert(full_reads == 0, 'a multiline local edit read the full buffer')
end)
api.nvim_buf_get_lines = original
assert(ok, err)
return {lines=5000, localEdits=3, fullDocumentReads=full_reads}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('Git sign refreshes bound pending commands and apply the latest HEAD and unsaved text', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    const result = await session.client.request('nvim_exec_lua', [
      `
local api, signs = vim.api, require('nido_git_signs')
local buffer = api.nvim_get_current_buf()
local root = vim.fn.getcwd()
api.nvim_buf_set_name(buffer, root .. '/.downloads/first.txt')
api.nvim_buf_set_lines(buffer, 0, -1, false, {'initial'})
local original_system, original_diff = vim.system, vim.diff
local calls, active, maximum, latest = {}, 0, 0, nil
local fail_spawn = false
vim.system = function(command, options, callback)
  if command[1] ~= 'git' then return original_system(command, options, callback) end
  if fail_spawn then error('simulated spawn failure') end
  calls[#calls + 1] = {command=command, callback=callback}
  active = active + 1
  maximum = math.max(maximum, active)
  return {kill=function() end}
end
vim.diff = function(base, text, options)
  latest = {base=base, text=text}
  return original_diff(base, text, options)
end
local function respond(index, stdout, code)
  active = active - 1
  calls[index].callback({stdout=stdout, stderr='', code=code or 0})
  local settled = false
  vim.schedule(function() settled=true end)
  assert(vim.wait(1000, function() return settled end, 1))
end
local function revision(head) return root .. '\\n' .. head .. '\\n' end
local ok, err = pcall(function()
  signs.refresh(buffer)
  for change=1,20 do
    api.nvim_buf_set_lines(buffer, 0, -1, false, {'latest-' .. change})
    signs.refresh(change % 2 == 0 and 0 or buffer)
  end
  assert(#calls == 1 and maximum == 1, 'same-buffer refreshes overlap: ' .. #calls)
  respond(1, revision('aaa'))
  assert(#calls == 2 and calls[2].command[6] == 'rev-parse', 'obsolete HEAD must not be loaded')
  respond(2, revision('bbb'))
  assert(#calls == 3 and calls[3].command[7] == 'bbb:.downloads/first.txt')
  respond(3, 'committed\\n')
  assert(active == 0 and maximum == 1)
  assert(latest.base == 'committed\\n' and latest.text == 'latest-20\\n', vim.inspect(latest))
  local marks = api.nvim_buf_get_extmarks(buffer, api.nvim_get_namespaces().nido_git_signs, 0, -1, {details=true})
  assert(#marks == 1 and marks[1][4].sign_hl_group == 'NidoGitChanged')
  fail_spawn = true
  signs.refresh(buffer)
  fail_spawn = false
  signs.refresh(buffer)
  assert(#calls == 4, 'spawn failure must release the buffer queue')
  respond(4, revision('bbb'))
  signs.refresh(buffer)
  respond(5, '', 128)
  signs.refresh(buffer)
  respond(6, revision('ccc'))
  respond(7, 'new commit\\n')
  assert(latest.base == 'new commit\\n' and latest.text == 'latest-20\\n')
  assert(active == 0 and maximum == 1, 'failed Git command must release the buffer queue')
end)
vim.system, vim.diff = original_system, original_diff
assert(ok, err)
return {refreshes=21, maximumConcurrentGit=maximum, initialPendingGit=1, latestText=latest.text}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('Git sign queues stay separate across buffers and discard renamed, unloaded, deleted and stopped work', async () => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.client.request('nvim_exec_lua', [
      `
local api, signs = vim.api, require('nido_git_signs')
local root = vim.fn.getcwd()
local first = api.nvim_get_current_buf()
local second = api.nvim_create_buf(true, false)
api.nvim_buf_set_name(first, root .. '/.downloads/first.txt')
api.nvim_buf_set_name(second, root .. '/.downloads/second.txt')
api.nvim_buf_set_lines(first, 0, -1, false, {'first edit'})
api.nvim_buf_set_lines(second, 0, -1, false, {'second edit'})
local original, calls, killed = vim.system, {}, 0
vim.system = function(command, options, callback)
  if command[1] ~= 'git' then return original(command, options, callback) end
  calls[#calls + 1] = {command=command, callback=callback}
  return {kill=function() killed=killed+1 end}
end
local function respond(index, stdout)
  calls[index].callback({stdout=stdout or '', stderr='', code=0})
  local settled = false
  vim.schedule(function() settled=true end)
  assert(vim.wait(1000, function() return settled end, 1))
end
local revision = root .. '\\nabc\\n'
local ok, err = pcall(function()
  for refresh=1,20 do signs.refresh(first); signs.refresh(second) end
  assert(#calls == 2, 'different buffers need independent single commands')
  api.nvim_buf_delete(first, {unload=true, force=true})
  assert(killed == 1, 'unloading must cancel its process')
  respond(1, revision)
  assert(#calls == 2, 'an unloaded buffer restarted obsolete work')
  api.nvim_buf_set_name(second, root .. '/.downloads/renamed.txt')
  signs.refresh(second)
  respond(2, revision)
  assert(#calls == 3, 'renaming must start one fresh lookup')
  respond(3, revision)
  assert(calls[4].command[7] == 'abc:.downloads/renamed.txt', 'the old file name survived')
  respond(4, 'committed\\n')
  local namespace = api.nvim_get_namespaces().nido_git_signs
  assert(#api.nvim_buf_get_extmarks(second, namespace, 0, -1, {}) == 1)
  signs.refresh(second)
  api.nvim_exec_autocmds('BufDelete', {buffer=second})
  assert(killed == 2)
  respond(5, revision)
  assert(#calls == 5, 'a deleted buffer restarted queued work')
  signs.refresh(second)
  api.nvim_exec_autocmds('VimLeavePre', {})
  assert(killed == 3)
  respond(6, revision)
  signs.refresh(second)
  assert(#calls == 6, 'stopping must discard callbacks and prevent refreshes')
end)
vim.system = original
assert(ok, err)
`,
      []
    ]);
  } finally {
    await session.stop();
  }
});

test('indent redraws reuse neighboring lines across a continuous blank range', async (context) => {
  const grid = new Grid();
  const session = await Session.create(process.cwd(), (event) => {
    if (event.type === 'redraw') grid.apply(event.events);
  });
  try {
    await session.attach(80, 24);
    const result = (await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
local lines = {'    before'}
for row=1,10000 do lines[#lines + 1] = '' end
lines[#lines + 1] = '      after'
api.nvim_buf_set_lines(0, 0, -1, false, lines)
vim.bo.shiftwidth, vim.bo.tabstop = 2, 4
api.nvim_win_set_cursor(0, {5000, 0})
vim.cmd('normal! zz')
vim.cmd('redraw!')
local before, after = vim.fn.prevnonblank, vim.fn.nextnonblank
local previous, following = 0, 0
vim.fn.prevnonblank = function(...) previous=previous+1; return before(...) end
vim.fn.nextnonblank = function(...) following=following+1; return after(...) end
local started = vim.uv.hrtime()
for redraw=1,20 do vim.cmd('redraw!') end
local elapsed = (vim.uv.hrtime() - started) / 1e6
vim.fn.prevnonblank, vim.fn.nextnonblank = before, after
return {redraws=20, previous=previous, following=following, elapsedMs=elapsed}
`,
      []
    ])) as { redraws: number; previous: number; following: number; elapsedMs: number };
    context.diagnostic(JSON.stringify(result));
    assert.ok(result.previous > 0, 'Native redraws must exercise indentation guides');
    assert.ok(result.previous <= result.redraws);
    assert.equal(result.following, result.previous);
    const guides = grid.cells.flatMap((row) =>
      row.filter((cell) => grid.highlights.get(cell.highlight)?.foreground === 0x75633f)
    );
    assert.ok(guides.some((cell) => cell.text === '│'));
  } finally {
    await session.stop();
  }
});

test('indent guides preserve blank boundaries and local options while bounding work to visible columns', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.attach(100, 24);
    const result = await session.client.request('nvim_exec_lua', [
      String.raw`
local api = vim.api
local namespace = api.nvim_get_namespaces().nido_indent
local register, provider = api.nvim_set_decoration_provider
-- Capture a separate instance of the real provider without changing native rendering.
api.nvim_set_decoration_provider = function(id, value)
  assert(id == namespace)
  provider = value
end
local loaded, err = pcall(dofile, api.nvim_get_runtime_file('lua/nido_indent.lua', false)[1])
api.nvim_set_decoration_provider = register
assert(loaded, err)
local original_mark = api.nvim_buf_set_extmark
local function check(window, first, last, budget)
  local buffer = api.nvim_win_get_buf(window)
  local expected = api.nvim_win_call(window, function()
    local values = {}
    local left = vim.fn.winsaveview().leftcol
    local width = api.nvim_win_get_width(window) - vim.fn.getwininfo(window)[1].textoff
    local step = vim.fn.shiftwidth()
    for row=first,last do
      local indent = vim.fn.indent(row + 1)
      if vim.fn.getline(row + 1):match('^%s*$') then
        indent = math.min(math.max(0, vim.fn.indent(vim.fn.prevnonblank(row + 1))),
          math.max(0, vim.fn.indent(vim.fn.nextnonblank(row + 1))))
      end
      for column=0,indent-1,step do
        if column >= left and column-left < width then
          values[#values + 1] = {row, column-left, 'NidoIndent' .. ((column/step)%6 + 1)}
        end
      end
    end
    return values
  end)
  local actual = {}
  api.nvim_buf_set_extmark = function(buf, ns, row, column, options)
    assert(buf == buffer and ns == namespace and column == 0 and options.ephemeral)
    assert(options.virt_text[1][1] == '│')
    actual[#actual + 1] = {row, options.virt_text_win_col, options.virt_text[1][2]}
    return 0
  end
  local batches = 0
  local ok, error = pcall(function()
    provider.on_start()
    provider.on_win(nil, window, buffer, first, last)
    if budget then
      -- Count Lua work independently of wall-clock load and native extmark rendering.
      jit.off(provider.on_line, true)
      debug.sethook(function() batches=batches+1 end, '', 100)
    end
    for row=first,last do provider.on_line(nil, window, buffer, row) end
  end)
  debug.sethook()
  api.nvim_buf_set_extmark = original_mark
  assert(ok, error)
  assert(vim.deep_equal(actual, expected), vim.inspect({actual=actual, expected=expected}))
  if budget then assert(batches <= budget, 'Offscreen indentation consumed ' .. batches .. ' instruction batches') end
  return batches
end
local first_window = api.nvim_get_current_win()
local first_buffer = api.nvim_get_current_buf()
local lines = {'', ' ', '\t', '      start', '', ' \t', '\tchild', '', '    tail', '', '\t', ''}
api.nvim_buf_set_lines(first_buffer, 0, -1, false, lines)
vim.bo[first_buffer].shiftwidth, vim.bo[first_buffer].tabstop = 2, 8
check(first_window, 0, #lines-1)
-- Start in the middle of a blank range and finish before its next nonblank line.
check(first_window, 4, 5)
vim.bo[first_buffer].tabstop, vim.bo[first_buffer].shiftwidth = 3, 0
check(first_window, 0, #lines-1)
vim.bo[first_buffer].vartabstop = '3,5'
check(first_window, 0, #lines-1)
api.nvim_buf_set_lines(first_buffer, 3, 4, false, {'  changed'})
check(first_window, 0, #lines-1)
api.nvim_buf_set_lines(first_buffer, 4, 5, false, {'        inserted'})
check(first_window, 0, #lines-1)
vim.cmd('vsplit')
local second_window = api.nvim_get_current_win()
local second_buffer = api.nvim_create_buf(true, false)
api.nvim_win_set_buf(second_window, second_buffer)
api.nvim_buf_set_lines(second_buffer, 0, -1, false, {'root', '  child', '\tchild', '', '    tail'})
vim.bo[second_buffer].shiftwidth, vim.bo[second_buffer].tabstop = 4, 4
check(second_window, 0, 4)
check(first_window, 0, #lines-1)
api.nvim_win_call(first_window, function()
  vim.wo.wrap = false
  api.nvim_win_set_cursor(0, {5, 8})
  vim.fn.winrestview({leftcol=4})
  assert(vim.fn.winsaveview().leftcol == 4)
end)
check(first_window, 0, #lines-1)
api.nvim_buf_set_lines(second_buffer, 0, -1, false, {'', ' ', '\t'})
check(second_window, 0, 2)
api.nvim_buf_set_lines(second_buffer, 0, -1, false,
  {string.rep(' ', 20000) .. 'top', '', string.rep('\t', 5000) .. 'tail'})
vim.bo[second_buffer].shiftwidth, vim.bo[second_buffer].tabstop = 3, 4
vim.wo[second_window].wrap = false
local batches = 0
for _,left in ipairs({0, 1, 19973, 20000, 20003}) do
  api.nvim_win_call(second_window, function()
    vim.fn.winrestview({leftcol=left})
    assert(vim.fn.winsaveview().leftcol == left)
  end)
  batches = batches + check(second_window, 0, 2, 150)
end
return {instructionBatches=batches, deepIndentColumns=20000, publications=5}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('resize bursts skip obsolete queued sizes and keep the latest viewport', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  const request = session.client.request.bind(session.client);
  const sizes: unknown[][] = [];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    session.client.request = async (method, args = []) => {
      if (method === 'nvim_ui_try_resize') {
        sizes.push(args);
        if (sizes.length === 1) {
          entered();
          await gate;
        }
      }
      return request(method, args);
    };
    const first = session.resize(81, 24);
    await started;
    const queued = Array.from({ length: 20 }, (_, index) => session.resize(82 + index, 25 + index));
    release();
    await Promise.all([first, ...queued]);
    context.diagnostic(JSON.stringify({ resizeRequests: sizes.length, sizes }));
    assert.equal(sizes.length, 2);
    const uis = (await request('nvim_list_uis', [])) as { width: number; height: number }[];
    assert.deepEqual([uis[0].width, uis[0].height], [101, 44]);
  } finally {
    release();
    session.client.request = request;
    await session.stop();
  }
});

test('cursor patches preserve diagnostics and buffers, and explicit clears reach the renderer', () => {
  const sent: NidoEvent[] = [];
  const events = new SessionEvents('alpha', (event) => sent.push(event));
  const buffers = [{ id: 1, name: '/alpha/main.rs', modified: false }];
  const problems = [
    {
      path: buffers[0].name,
      line: 1,
      column: 1,
      severity: 1,
      message: 'error',
      source: 'rustc'
    }
  ];
  events.receiveNotification('nido:state', [
    {
      buffers,
      problems,
      diagnostics: { [buffers[0].name]: 1 },
      lineEnding: 'LF',
      scrollCursor: { row: 2, column: 3 }
    }
  ]);
  const initial = events.state;
  assert.equal(sent[0].type, 'state');
  events.receiveNotification('nido:state', [{ line: 12, column: 4 }]);
  assert.deepEqual(sent[1], { type: 'statePatch', id: 'alpha', state: { line: 12, column: 4 } });
  assert.equal(events.state.buffers, buffers);
  assert.equal(events.state.problems, problems);
  assert.equal(events.state.diagnostics, initial.diagnostics);
  events.receiveNotification('nido:state', [{ line: 12, column: 4 }]);
  assert.equal(sent.length, 2);
  events.receiveNotification('nido:state', [{ lineEnding: null, scrollCursor: null }]);
  assert.deepEqual(sent[2], {
    type: 'statePatch',
    id: 'alpha',
    state: { lineEnding: undefined, scrollCursor: undefined }
  });
  events.receiveNotification('nido:state', [{ buffers: {}, problems: {}, diagnostics: {} }]);
  assert.equal(sent[3].type, 'state');
  assert.deepEqual(events.state.buffers, []);
  assert.deepEqual(events.state.problems, []);
  assert.deepEqual(events.state.diagnostics, {});
});

test('scroll batches publish the latest cursor with collection changes preserved', () => {
  const sent: NidoEvent[] = [];
  const events = new SessionEvents('alpha', (event) => sent.push(event));
  events.receiveNotification('nido:state', [{ buffers: [] }]);
  events.beginScrollBatch();
  events.receiveNotification('nido:state', [{ diagnostics: { '/alpha/main.rs': 2 }, line: 2 }]);
  events.receiveNotification('nido:state', [{ line: 30 }]);
  assert.equal(sent.length, 1);
  events.endScrollBatch();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'state');
  assert.equal(events.state.line, 30);
  assert.deepEqual(events.state.diagnostics, { '/alpha/main.rs': 2 });
});

test('diagnostic refreshes resolve each buffer once and keep paths and severity live', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    const result = await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
local root = vim.fn.getcwd()
local first, second, info, unnamed, wiped = api.nvim_get_current_buf(), api.nvim_create_buf(true, false),
  api.nvim_create_buf(true, false), api.nvim_create_buf(true, false), api.nvim_create_buf(true, false)
local first_path, second_path, info_path = root .. '/.downloads/diagnostic-first.ts',
  root .. '/.downloads/diagnostic-second.ts', root .. '/.downloads/diagnostic-info.ts'
api.nvim_buf_set_name(first, first_path)
api.nvim_buf_set_name(second, second_path)
api.nvim_buf_set_name(info, info_path)
api.nvim_buf_delete(wiped, {force=true})
vim.wait(30, function() return false end, 1)
local original_get, original_valid, original_name = vim.diagnostic.get, api.nvim_buf_is_valid, api.nvim_buf_get_name
local notify, state, publications = vim.rpcnotify, nil, 0
local checks, names, items = 0, 0, {}
vim.diagnostic.get = function(...)
  -- Synthetic stale diagnostics exercise the invalid-buffer guard as well.
  if debug.getinfo(2, 'n').name == 'refresh_diagnostics' then return items end
  return original_get(...)
end
api.nvim_buf_is_valid = function(...)
  if debug.getinfo(2, 'n').name == 'refresh_diagnostics' then checks = checks + 1 end
  return original_valid(...)
end
api.nvim_buf_get_name = function(...)
  if debug.getinfo(2, 'n').name == 'refresh_diagnostics' then names = names + 1 end
  return original_name(...)
end
vim.rpcnotify = function(channel, method, ...)
  if method == 'nido:state' then state, publications = ..., publications + 1 end
  return notify(channel, method, ...)
end
local function publish(change)
  local before = publications
  checks, names = 0, 0
  if change then change() else api.nvim_exec_autocmds('DiagnosticChanged', {buffer=first}) end
  assert(vim.wait(1000, function() return publications > before end, 1))
end
local function diagnostic(buffer, severity, message)
  return {bufnr=buffer, lnum=2, col=4, severity=severity, message=message}
end
local ok, err = pcall(function()
  for i=1,1000 do items[i] = diagnostic(first, 1, 'Error ' .. i) end
  publish()
  assert(checks == 1 and names == 1, ('1000 diagnostics: validity=%d names=%d'):format(checks, names))
  assert(#state.problems == 1000 and state.diagnostics[first_path] == 1, vim.inspect(state))
  assert(vim.deep_equal(state.problems[1000], {path=first_path, line=3, column=5,
    severity=1, message='Error 1000', source=''}), vim.inspect(state.problems[1000]))
  items = {
    diagnostic(first, 2, 'Warning'), diagnostic(first, 3, 'Information'),
    diagnostic(second, 2, 'Warning'), diagnostic(second, 1, 'Error'), diagnostic(second, 4, 'Hint'),
    diagnostic(info, 3, 'Information'), diagnostic(info, 4, 'Hint'),
    diagnostic(unnamed, 1, 'Unnamed'), diagnostic(wiped, 1, 'Wiped'), diagnostic(wiped, 2, 'Wiped again'),
  }
  items[2].source = 'test-server'
  publish()
  assert(checks == 5 and names == 4, ('multiple buffers: validity=%d names=%d'):format(checks, names))
  assert(#state.problems == 7, 'all named-buffer severities remain in the problems list')
  assert(vim.deep_equal(state.diagnostics, {[first_path]=2, [second_path]=1}), vim.inspect(state.diagnostics))
  assert(state.problems[2].source == 'test-server' and state.problems[3].path == second_path)
  assert(state.problems[6].path == info_path and state.problems[6].severity == 3)
  local renamed = root .. '/.downloads/diagnostic-renamed.ts'
  publish(function()
    api.nvim_buf_set_name(first, renamed)
    api.nvim_buf_delete(second, {force=true})
  end)
  assert(checks == 5 and names == 3, ('renamed/wiped buffers: validity=%d names=%d'):format(checks, names))
  assert(#state.problems == 4 and state.problems[1].path == renamed and state.problems[3].path == info_path)
  assert(vim.deep_equal(state.diagnostics, {[renamed]=2}), 'old names and deleted buffers must disappear')
  local named = root .. '/.downloads/diagnostic-now-named.ts'
  publish(function() api.nvim_buf_set_name(unnamed, named) end)
  assert(#state.problems == 5 and state.problems[5].path == named, 'previously unnamed buffers refresh their path')
  assert(vim.deep_equal(state.diagnostics, {[renamed]=2, [named]=1}), vim.inspect(state.diagnostics))
end)
vim.diagnostic.get, api.nvim_buf_is_valid, api.nvim_buf_get_name, vim.rpcnotify = original_get, original_valid, original_name, notify
assert(ok, err)
return {sameBufferDiagnostics=1000, validityChecks=1, fileNameReads=1, lifecycleRefreshes=3}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('native cursor movement avoids retransmitting a thousand diagnostics on every step', async () => {
  const sent: Extract<NidoEvent, { type: 'state' | 'statePatch' }>[] = [];
  let measuring = false;
  const session = await Session.create(process.cwd(), (event) => {
    if (measuring && (event.type === 'state' || event.type === 'statePatch')) sent.push(event);
  });
  try {
    await session.client.request('nvim_exec_lua', [
      `
            local lines, items = {}, {}
            for i=1,2000 do lines[i] = 'row ' .. i end
            vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
            vim.api.nvim_buf_set_name(0, vim.fn.getcwd() .. '/performance-fixture.txt')
            for i=1,1000 do items[i] = {lnum=i-1,col=0,severity=1,message='Diagnostic ' .. i .. string.rep(' detail',20)} end
            vim.diagnostic.set(vim.api.nvim_create_namespace('performance-fixture'),0,items)
            for i=1,20 do local b=vim.api.nvim_create_buf(true,false); vim.api.nvim_buf_set_name(b,vim.fn.getcwd() .. '/fixture-' .. i .. '.txt') end
            vim.wait(100,function() return false end,10)
        `,
      []
    ]);
    let rendered: SessionState = { ...session.state };
    measuring = true;
    for (let i = 0; i < 20; i++) {
      await session.input('j');
      await session.client.request('nvim_eval', ['1']);
    }
    for (const event of sent) rendered = { ...rendered, ...event.state };
    assert.equal(rendered.line, 21);
    assert.equal(rendered.buffers.length, 21);
    assert.equal(rendered.problems?.length, 1000);
    assert.ok(sent.filter((event) => event.type === 'statePatch').length >= 19);
    assert.ok(sent.filter((event) => 'problems' in event.state).length <= 1);
    assert.ok(
      sent.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0) < 400_000
    );

    await session.client.request('nvim_exec_lua', [
      `
            vim.diagnostic.reset(vim.api.nvim_create_namespace('performance-fixture'))
            vim.wait(30,function() return false end,5)
        `,
      []
    ]);
    assert.deepEqual(session.state.problems, []);
    assert.deepEqual(session.state.diagnostics, {});
  } finally {
    await session.stop();
  }
});

test('search counts reuse unchanged views and refresh for cursor, edits, patterns and case options', async () => {
  const session = await Session.create(process.cwd(), () => {});
  const lua = (code: string): ReturnType<Session['client']['request']> =>
    session.client.request('nvim_exec_lua', [code, []]);
  const publish = async (): Promise<void> => {
    await lua(
      "vim.api.nvim_exec_autocmds('User', {pattern='NidoScroll'}); vim.wait(80,function() return false end,5)"
    );
  };
  try {
    await lua(`
            vim.api.nvim_buf_set_lines(0,0,-1,false,{'alpha ALPHA','alpha','beta'})
            vim.fn.setreg('/','alpha'); vim.o.ignorecase=false; vim.v.hlsearch=1
            local original = vim.fn.searchcount
            vim.g.nido_test_search_scans = 0
            vim.fn.searchcount = function(options)
                vim.g.nido_test_search_scans = vim.g.nido_test_search_scans + 1
                return original(options)
            end
        `);
    await publish();
    assert.equal(session.state.search && session.state.search.total, 2);
    const scans = await lua('return vim.g.nido_test_search_scans');
    for (let i = 0; i < 3; i++) await publish();
    assert.equal(await lua('return vim.g.nido_test_search_scans'), scans);
    await lua('vim.api.nvim_win_set_cursor(0,{2,0})');
    await publish();
    assert.equal(session.state.search && session.state.search.current, 2);
    await lua('vim.o.ignorecase=true');
    await publish();
    assert.equal(session.state.search && session.state.search.total, 3);
    await lua("vim.api.nvim_buf_set_lines(0,2,3,false,{'alpha'})");
    await publish();
    assert.equal(session.state.search && session.state.search.total, 4);
    await lua("vim.fn.setreg('/','ALPHA'); vim.o.smartcase=true");
    await publish();
    assert.equal(session.state.search && session.state.search.total, 1);
    await lua('vim.v.hlsearch=0');
    await publish();
    assert.equal(session.state.search, false);
  } finally {
    await session.stop();
  }
});

test('search counting coalesces rapid movement and rejects stale edits, buffers and cleared searches', async (context) => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    const result = await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
local original_count, original_defer, original_notify, original_hrtime = vim.fn.searchcount, vim.defer_fn, vim.rpcnotify, vim.uv.hrtime
local scans, held, latest = 0, {}, nil
local function publish()
  api.nvim_exec_autocmds('User', {pattern='NidoSearch'})
  vim.wait(5)
end
local function flush()
  for _=1,5 do
    local callbacks = held
    held = {}
    for _, callback in ipairs(callbacks) do callback() end
    vim.wait(5)
    if #held == 0 then return end
  end
  error('Search counting did not settle')
end
api.nvim_buf_set_lines(0,0,-1,false,vim.fn['repeat']({'alpha ALPHA'},1000))
vim.fn.setreg('/', 'alpha'); vim.o.ignorecase=false; vim.o.smartcase=false; vim.v.hlsearch=1
vim.wait(100)
local now = original_hrtime()
vim.uv.hrtime = function() return now end -- This entire burst is inside the counting window.
vim.fn.searchcount = function(options) scans=scans+1; return original_count(options) end
vim.defer_fn = function(callback, ms)
  if ms >= 8 and ms <= 32 then held[#held+1]=callback; return end
  return original_defer(callback, ms)
end
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:state' then latest=vim.deepcopy(state) end
  return original_notify(channel, method, state, ...)
end
local ok, err = pcall(function()
  for row=101,140 do
    api.nvim_win_set_cursor(0,{row,0})
    publish()
  end
  assert(scans == 0 and latest.line == 140, 'Cursor state must arrive without a full-buffer scan')
  flush()
  assert(scans == 1 and latest.search.current == 140 and latest.search.total == 1000,
    'A burst must count only its latest cursor position')
  api.nvim_win_set_cursor(0,{150,0}); publish()
  api.nvim_win_set_cursor(0,{140,0}); publish()
  flush()
  assert(scans == 1 and latest.search.current == 140, 'Returning to a cached position cancels an obsolete count')
  api.nvim_win_set_cursor(0,{160,0}); publish()
  api.nvim_buf_set_lines(0,0,-1,false,{'beta','beta'})
  vim.fn.setreg('/','beta')
  -- The queued callback must recheck text, pattern and position even before their next autocmd.
  flush()
  assert(latest.search.pattern == 'beta' and latest.search.total == 2,
    'A queued count must not publish the old text or pattern')
  api.nvim_win_set_cursor(0,{2,0}); publish()
  local buffer = api.nvim_create_buf(true,false)
  api.nvim_set_current_buf(buffer)
  api.nvim_buf_set_lines(buffer,0,-1,false,{'beta beta beta'})
  flush()
  assert(latest.current == buffer and latest.search.total == 3, 'A count must follow the current buffer')
  vim.fn.setreg('/','missing'); publish()
  vim.v.hlsearch=0; publish()
  local before = scans
  flush()
  assert(latest.search == false and scans == before, 'Clearing search cancels its queued work')
end)
vim.fn.searchcount, vim.defer_fn, vim.rpcnotify, vim.uv.hrtime = original_count, original_defer, original_notify, original_hrtime
assert(ok, err)
return {moves=40, burstScans=1, totalScans=scans}
`,
      []
    ]);
    context.diagnostic(JSON.stringify(result));
  } finally {
    await session.stop();
  }
});

test('slow search counts have a bounded wait during continuous input', async () => {
  const session = await Session.create(process.cwd(), () => {});
  try {
    await session.client.request('nvim_exec_lua', [
      `
local api = vim.api
api.nvim_buf_set_lines(0,0,-1,false,{'alpha','alpha','alpha','alpha','alpha'})
vim.fn.setreg('/','alpha'); vim.v.hlsearch=0
api.nvim_exec_autocmds('User',{pattern='NidoSearch'}); vim.wait(5)
local hrtime, defer, count, notify = vim.uv.hrtime, vim.defer_fn, vim.fn.searchcount, vim.rpcnotify
local now, held, latest = 0, {}, nil
vim.uv.hrtime = function() return now end
vim.defer_fn = function(callback, ms)
  if ms <= 80 then held[#held+1]={callback=callback,delay=ms}; return end
  return defer(callback,ms)
end
vim.fn.searchcount = function(options)
  local result = count(options)
  now=now+10000000 -- Model a slow count without sleeping inside the test.
  return result
end
vim.rpcnotify = function(channel, method, state, ...)
  if method == 'nido:state' then latest=vim.deepcopy(state) end
  return notify(channel,method,state,...)
end
local function publish()
  api.nvim_exec_autocmds('User',{pattern='NidoSearch'}); vim.wait(5)
end
local ok, err = pcall(function()
  vim.v.hlsearch=1; publish()
  local initial=held; held={}
  for _, item in ipairs(initial) do item.callback() end
  vim.wait(5)
  for row=2,5 do
    now=now+40000000
    api.nvim_win_set_cursor(0,{row,0}); publish()
    assert(held[#held].delay <= 80, 'A slow count must not postpone a settled view beyond 80ms')
  end
  assert(held[#held].delay == 0, 'Continuous input must not postpone counting beyond 120ms')
  local callbacks=held; held={}
  for _, item in ipairs(callbacks) do item.callback() end
  vim.wait(5)
  assert(latest.search.current == 5 and latest.search.total == 5, 'The bounded update must count the latest position')
end)
vim.uv.hrtime, vim.defer_fn, vim.fn.searchcount, vim.rpcnotify = hrtime, defer, count, notify
assert(ok,err)
`,
      []
    ]);
  } finally {
    await session.stop();
  }
});

test('incremental prefetch preserves every visible frame and bounds each batch of grid traffic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-traffic-'));
  const frames: Redraw[] = [];
  const visibleFrames: Grid['cells'][] = [];
  const grid = new Grid();
  const session = await Session.create(root, (event) => {
    if (event.type === 'redraw') {
      grid.apply(event.events);
      frames.push(event.events);
      visibleFrames.push(grid.cells.slice());
    }
  });
  try {
    await writeFile(
      join(root, 'rows.txt'),
      Array.from(
        { length: 5000 },
        (_, i) => `row ${i + 1} ${'nested { let x = 1; } '.repeat(8)}`
      ).join('\n')
    );
    await session.attach(100, 40);
    await session.openFile('rows.txt');
    await session.input('2000Gzt');
    // Partial bracket marks do not mean parsing or delayed word highlights have finished.
    assert.equal(
      await session.client.request('nvim_exec_lua', [
        `local buffer = vim.api.nvim_get_current_buf()
local namespace = vim.api.nvim_create_namespace('nido_brackets')
vim.api.nvim_exec_autocmds('CursorMoved', {buffer=buffer})
local ready = vim.wait(5000, function()
  return require('nido_brackets').ready(buffer) and #vim.fn.getmatches() > 0
    and #vim.api.nvim_buf_get_extmarks(buffer, namespace, {1999, 0}, {1999, -1}, {limit=1}) > 0
end, 5)
vim.cmd.redraw()
return ready`,
        []
      ]),
      true,
      'Bracket analysis and word highlighting must complete before measuring prefetch frames.'
    );
    const view = await session.client.request('nvim_exec_lua', [
      // A timer wait can finish before Neovim flushes its last cursor-line repaint.
      'vim.cmd.redraw(); return vim.fn.winsaveview()',
      []
    ]);
    const visible = grid.cells.slice();
    frames.length = 0;
    visibleFrames.length = 0;
    // Independent highlighting and guide refreshes share the redraw channel with cache refills.
    await session.client.request('nvim_exec_lua', ['vim.cmd.redraw({bang=true})', []]);
    await session.prefetchScroll();
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
      view
    );
    const viewportFrames = frames.filter((frame) =>
      // Standalone highlighting repaints can contain grid_line without moving the view.
      frame.some(([name]) => name === 'nido_scroll' || name === 'nido_scroll_cache')
    );
    assert.ok(
      viewportFrames.length > 1,
      `temporary views must never become separate visible frames: ${JSON.stringify(
        frames.map((frame) => frame.map(([name]) => name))
      )}`
    );
    const bytes = Buffer.byteLength(JSON.stringify(viewportFrames));
    assert.ok(bytes < 400_000, `incremental refill traffic must remain bounded: ${bytes}`);
    assert.ok(
      viewportFrames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) < 80_000),
      'each strip must publish a bounded batch'
    );
    for (const rendered of visibleFrames) {
      for (let row = 0; row < visible.length; row++) {
        assert.equal(
          rendered[row],
          visible[row],
          'every published frame must preserve the visible row images'
        );
      }
    }
    assert.equal(grid.needsUpperRows, false);
    await session.scroll(-100, true, true);
    assert.equal(
      grid.hasUpperRows,
      true,
      'a fast upward move retains the remaining cached history'
    );
    const downView = await session.client.request('nvim_exec_lua', [
      'return vim.fn.winsaveview()',
      []
    ]);
    const downRows = grid.cells.slice();
    frames.length = 0;
    visibleFrames.length = 0;
    await session.prefetchScroll(true);
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
      downView
    );
    assert.equal(
      frames.filter((frame) =>
        frame.some(([name, args]) => name === 'nido_scroll_cache' && args[3] === true)
      ).length,
      1
    );
    assert.ok(Buffer.byteLength(JSON.stringify(frames)) < 400_000);
    for (const rendered of visibleFrames) assert.deepEqual(rendered, downRows);
    assert.equal(grid.needsLowerRows, false);
    assert.equal(grid.futureRows.length, 256);
    const future = grid.futureRows.slice(0, 3);
    await session.scroll(3, true, true);
    const text = (rows: Grid['cells']): string[] =>
      rows.map((row) => row.map((cell) => cell.text).join(''));
    assert.deepEqual(
      text(grid.cells.slice(grid.rows - 4, grid.rows - 2)),
      text(future.slice(0, 2))
    );
    // Neovim replaces the end of an incomplete wrapped bottom row with @ markers.
    assert.deepEqual(
      text([grid.cells[grid.rows - 2].slice(0, -3)]),
      text([future[2].slice(0, -3)])
    );
    await session.input('gg');
    await session.prefetchScroll(true);
    assert.equal(grid.futureRows.length, 256, 'BOF still permits downward prefetch');
    await session.input('Gzt');
    await session.scroll(1000, true, true);
    const wrappedEnd = await session.client.request('nvim_exec_lua', [
      'return vim.fn.winsaveview()',
      []
    ]);
    await session.prefetchScroll(true);
    assert.deepEqual(
      await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
      wrappedEnd,
      'prefetch preserves a wrapped viewport near EOF'
    );
    await session.client.request('nvim_exec_lua', ['vim.wo.wrap=false; vim.wo.scrolloff=0', []]);
    await session.input('Gzt');
    await session.scroll(1000, true, true);
    await session.prefetchScroll(true);
    assert.equal(grid.futureRows.length, 0);
    assert.equal(grid.needsLowerRows, false, 'EOF must not repeatedly refill an empty cache');
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('scroll input runs between prefetch strips without losing the viewport or cached rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-priority-'));
  const grid = new Grid();
  const session = await Session.create(root, (event) => {
    if (event.type === 'redraw') grid.apply(event.events);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await writeFile(
      join(root, 'rows.txt'),
      Array.from({ length: 2000 }, (_, i) => `ROW_${i + 1}`).join('\n')
    );
    await session.attach(80, 40);
    await session.openFile('rows.txt');
    await session.client.request('nvim_exec_lua', ['vim.wo.wrap=false; vim.cmd.redraw()', []]);
    const request = session.client.request.bind(session.client);
    let strips = 0;
    session.client.request = async (method, args = []) => {
      if (method === 'nvim_exec_lua' && String(args[0]).includes('.prefetch(')) {
        if (++strips === 1) {
          entered();
          await gate;
        }
      }
      return request(method, args);
    };
    let complete = false;
    const prefetch = session.prefetchScroll(true).then(() => {
      complete = true;
    });
    await started;
    const scroll = session.scroll(3, true, true);
    release();
    await scroll;
    assert.equal(complete, false, 'input must finish before speculative cache work completes');
    assert.equal(strips, 1, 'queued input must run before the next strip');
    await prefetch;
    assert.ok(strips > 1);
    assert.equal(await request('nvim_eval', ["line('w0')"]), 4);
    assert.equal(grid.futureRows.length, 256);
    assert.match(grid.futureRows[0].map((cell) => cell.text).join(''), /ROW_43\b/);
    for (let i = 0; i < 4; i++) await session.scroll(16, true, true);
    const before = strips;
    await session.prefetchScroll(true);
    assert.ok(
      strips - before < 8,
      'warm refills must reuse known rows instead of fetching all 256 again'
    );
    assert.equal(grid.futureRows.length, 256);
    assert.deepEqual(
      grid.futureRows.map((row) =>
        Number(
          row
            .map((cell) => cell.text)
            .join('')
            .match(/ROW_(\d+)/)?.[1]
        )
      ),
      Array.from({ length: 256 }, (_, i) => 107 + i),
      'reused and newly fetched strips must remain contiguous after movement'
    );
  } finally {
    release();
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

for (const down of [false, true]) {
  test(`opposite-direction scroll abandons obsolete ${down ? 'downward' : 'upward'} prefetch after its current strip`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-reversal-'));
    const grid = new Grid();
    const session = await Session.create(root, (event) => {
      if (event.type === 'redraw') grid.apply(event.events);
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await writeFile(
        join(root, 'rows.txt'),
        Array.from({ length: 2000 }, (_, i) => `ROW_${i + 1}`).join('\n')
      );
      await session.attach(80, 40);
      await session.openFile('rows.txt');
      await session.input('1000Gzt');
      const request = session.client.request.bind(session.client);
      const before = Number(await request('nvim_eval', ["line('w0')"]));
      let strips = 0;
      session.client.request = async (method, args = []) => {
        if (method === 'nvim_exec_lua' && String(args[0]).includes('.prefetch(')) {
          if (++strips === 1) {
            entered();
            await gate;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return request(method, args);
      };
      const prefetch = session.prefetchScroll(down);
      await started;
      const delta = down ? -3 : 3;
      const scroll = session.scroll(delta, true, true);
      const reversed = performance.now();
      release();
      await Promise.all([scroll, prefetch]);
      context.diagnostic(
        JSON.stringify({ down, strips, reversalMs: performance.now() - reversed })
      );
      assert.equal(strips, 1, 'an opposite gesture must not wait for seven obsolete strips');
      const top = Number(await request('nvim_eval', ["line('w0')"]));
      assert.equal(
        top,
        before + delta,
        'cancelling speculative work preserves the requested movement'
      );
      await session.prefetchScroll(!down);
      const rows = down ? grid.historyRows : grid.futureRows;
      assert.equal(rows.length, 256, 'the new direction can fill its cache immediately');
      const first = down ? top - rows.length : top + grid.rows - 1;
      assert.deepEqual(
        rows.map((row) =>
          Number(
            row
              .map((cell) => cell.text)
              .join('')
              .match(/ROW_(\d+)/)?.[1]
          )
        ),
        Array.from({ length: rows.length }, (_, i) => first + i),
        'new cached rows stay contiguous after the reversal'
      );
      assert.equal(Number(await request('nvim_eval', ["line('w0')"])), top);
    } finally {
      release();
      await session.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('buffer switches discard cached rows and cancel an unfinished prefetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-prefetch-buffer-'));
  const grid = new Grid();
  const session = await Session.create(root, (event) => {
    if (event.type === 'redraw') grid.apply(event.events);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    for (const name of ['old', 'new', 'third']) {
      await writeFile(
        join(root, `${name}.txt`),
        Array.from({ length: 2000 }, (_, i) => `${name}_ROW_${i + 1}`).join('\n')
      );
    }
    await session.attach(80, 40);
    await session.openFile('old.txt');
    await session.input('400Gzt');
    await session.prefetchScroll(true);
    assert.equal(grid.futureRows.length, 256);
    assert.match(grid.futureRows[0].map((cell) => cell.text).join(''), /old_ROW_/);
    await session.openFile('new.txt');
    await session.client.request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
    assert.match(grid.description, /new_ROW_1\b/);
    assert.equal(grid.historyRows.length, 0);
    assert.equal(grid.futureRows.length, 0, 'old file rows must never preview in the new file');
    const request = session.client.request.bind(session.client);
    let strips = 0;
    session.client.request = async (method, args = []) => {
      if (method === 'nvim_exec_lua' && String(args[0]).includes('.prefetch(')) {
        if (++strips === 1) {
          entered();
          await gate;
        }
      }
      return request(method, args);
    };
    const prefetch = session.prefetchScroll(true);
    await started;
    const opening = session.openFile('third.txt');
    release();
    await Promise.all([prefetch, opening]);
    await request('nvim_exec_lua', ['vim.cmd.redraw()', []]);
    assert.equal(strips, 1, 'a buffer switch cancels the remaining strips');
    assert.match(grid.description, /third_ROW_1\b/);
    assert.equal(grid.futureRows.length, 0);
    await session.prefetchScroll(true);
    assert.equal(grid.futureRows.length, 256);
    assert.ok(
      grid.futureRows.every((row) => /third_ROW_/.test(row.map((cell) => cell.text).join('')))
    );
    await session.input('<Esc>:buffer old.txt<CR>');
    await request('nvim_eval', ['1']);
    assert.match(grid.description, /old_ROW_400\b/);
    assert.equal(grid.futureRows.length, 0, 'native :buffer switches also invalidate previews');
  } finally {
    release();
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('fractional gestures publish every offset without native repaints and preserve the edit anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nido-fractional-work-'));
  const frames: Redraw[] = [];
  const session = await Session.create(root, (event) => {
    if (event.type === 'redraw') frames.push(event.events);
  });
  try {
    await writeFile(
      join(root, 'rows.txt'),
      Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n')
    );
    await session.openFile('rows.txt');
    await session.input('50Gzt');
    await session.scroll(0.125, false, true);
    await session.client.request('nvim_exec_lua', [
      `
            local scroll=require('nido_scroll')
            local original_scroll=scroll.scroll
            local original=vim.cmd.redraw
            local scrolling=false
            vim.g.test_scroll_repaints=0
            -- Deferred sticky-header redraws are independent of the scroll operation.
            vim.cmd.redraw=function(...)
                if scrolling then
                    vim.g.test_scroll_repaints=vim.g.test_scroll_repaints+1
                end
                return original(...)
            end
            scroll.scroll=function(...)
                scrolling=true
                local changed=original_scroll(...)
                scrolling=false
                return changed
            end
        `,
      []
    ]);
    frames.length = 0;
    for (let i = 0; i < 4; i++) await session.scroll(0.125, false, true);
    assert.equal(await session.client.request('nvim_eval', ['g:test_scroll_repaints']), 0);
    const offsets = frames.flatMap((frame) =>
      frame.flatMap(([name, ...calls]) =>
        name === 'nido_pixel_scroll' ? calls.map((args) => Number(args[0])) : []
      )
    );
    assert.deepEqual(offsets, [0.25, 0.375, 0.5, 0.625]);
    assert.ok(frames.every((frame) => frame.at(-1)?.[0] === 'flush'));
    await session.scroll(1, false, true);
    assert.equal(await session.client.request('nvim_eval', ['g:test_scroll_repaints']), 1);
    await session.input('iQ<Esc>');
    assert.equal(await session.client.request('nvim_eval', ['line(".")']), 50);
    assert.equal(await session.client.request('nvim_get_current_line', []), 'Qrow 50');
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});
