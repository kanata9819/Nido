import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';

test('completion navigation leaves text unchanged until Tab accepts', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-completion-ranking-'));
	let session: Session | undefined;
	let candidates: string[] = [];
	try {
		session = await Session.create(root, (event) => {
			if (event.type !== 'redraw') return;
			for (const [name, ...calls] of event.events) {
				if (name === 'popupmenu_show')
					candidates = (calls.at(-1)![0] as string[][]).map((item) => item[0]);
			}
		});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.input('igetU');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU');
		await session.input(
			"<Cmd>lua vim.fn.complete(1, {'getOldUser', 'setUser', 'getUserName', 'getUser'})<CR>"
		);
		await lua('return 1');
		assert.equal(candidates.length, 4);
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU');
		for (const key of ['<Down>', '<Down>', '<Up>', '<C-n>', '<C-p>']) {
			await session.input(key);
			assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU', key);
		}
		await session.input('<Tab>');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), candidates[0]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('snippet highlighting clears on Escape or click and Tab still advances', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-snippet-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	const highlights = (): ReturnType<typeof lua> =>
		lua(
			"return #vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('nvim.snippet'), 0, -1, {})"
		);
	try {
		await session.attach(80, 24);
		for (const action of ['<Esc>', 'click', '<Tab>']) {
			await session.input('<Esc>');
			await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, {'', 'next line'})
vim.api.nvim_win_set_cursor(0, {1, 0})`);
			await session.input("i<Cmd>lua vim.snippet.expand('Ok(${1:()})$0')<CR>");
			assert.equal(await session.inputMode(), 's');
			assert.ok(Number(await highlights()) > 0);
			if (action === 'click') await session.click(1, 10);
			else await session.input(action);
			assert.equal(await session.inputMode(), action === '<Tab>' ? 'i' : 'n');
			assert.equal(await highlights(), 0, action);
			assert.equal(
				await lua('return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]'),
				'Ok(())'
			);
		}
		await session.input("<Cmd>lua vim.snippet.expand('pair(${1:a}, ${2:b})$0')<CR>");
		assert.equal(await session.inputMode(), 's');
		await session.input('<Tab>');
		assert.equal(await session.inputMode(), 's');
		assert.equal(await lua('return vim.snippet.active()'), true);
		await session.input('value');
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'Ok(())pair(a, value)');
		await session.input('<Esc>');
		assert.equal(await highlights(), 0);
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('completion refreshes the same current-prefix list after typing and Backspace', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-completion-edits-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await lua(`vim.g.completion_prefixes = {}
vim.lsp.start({
  name = 'completion-fixture',
  cmd = function(dispatchers)
    local serial = 0
    local closed = false
    return {
      request = function(method, params, callback)
        serial = serial + 1
        local result
        if method == 'initialize' then
          result = {capabilities = {completionProvider = {}, textDocumentSync = 1}}
        elseif method == 'textDocument/completion' then
          local prefix = vim.api.nvim_get_current_line():sub(1, params.position.character)
          local prefixes = vim.g.completion_prefixes
          table.insert(prefixes, prefix)
          vim.g.completion_prefixes = prefixes
          local labels = prefix == 'println'
            and {'TOUCHPREDICTIONPARAMETERS_DEFAULT_RLS_LAMBDA_LEARNING_RATE', 'println'}
            or prefix == 'printl' and {'println', 'printLine'} or {'printLegacy'}
          -- TypeScript returns unfiltered items with a shared edit range.
          table.insert(labels, 'convertUnits')
          result = {isIncomplete = false, items = {}, itemDefaults = {editRange = {
            start = {line = 0, character = 0},
            ['end'] = {line = 0, character = params.position.character},
          }}}
          for _, label in ipairs(labels) do
            table.insert(result.items, {label = label, kind = 3})
          end
        end
        vim.defer_fn(function() callback(nil, result) end, 10)
        return true, serial
      end,
      notify = function() return true end,
      is_closing = function() return closed end,
      terminate = function() closed = true; dispatchers.on_exit(0, 0) end,
    }
  end,
})
assert(vim.wait(2000, function()
  local client = vim.lsp.get_clients({bufnr=0})[1]
  return client and client.initialized
end, 10))`);
		const labels = async (): Promise<string[]> =>
			(await lua(
				"return vim.tbl_map(function(item) return item.abbr end, vim.fn.complete_info({'items'}).items)"
			)) as string[];
		const waitFor = async (expected: string[]): Promise<void> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (JSON.stringify(await labels()) === JSON.stringify(expected)) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.deepEqual(
				await labels(),
				expected,
				JSON.stringify(
					await lua(
						'return {vim.g.completion_prefixes, vim.api.nvim_get_current_line(), vim.fn.mode()}'
					)
				)
			);
		};
		await session.input('ip');
		await waitFor(['printLegacy']);
		for (const character of 'rintl') {
			await session.input(character);
			await new Promise((resolve) => setTimeout(resolve, 80));
		}
		await waitFor(['printLine', 'println']);
		const typed = await labels();
		await session.input('n');
		await waitFor(['println', 'TOUCHPREDICTIONPARAMETERS_DEFAULT_RLS_LAMBDA_LEARNING_RATE']);
		await session.input('<BS>');
		await waitFor(typed);
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'printl');
		const requests = await lua('return #vim.g.completion_prefixes');
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(await labels(), typed);
		assert.equal(await lua('return #vim.g.completion_prefixes'), requests);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('completion requests server trigger characters on the next turn without duplicate requests', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-completion-triggers-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	try {
		await lua("vim.g.nido_completion_test_triggers={'.', \"'\", '<', '。'}");
		await lua(
			await readFile(join(process.cwd(), 'tests/fixtures/completion-server.lua'), 'utf8')
		);
		await lua(`vim.g.completion_get_contexts = {}
local get = vim.lsp.completion.get
vim.lsp.completion.get = function(opts)
  local contexts = vim.g.completion_get_contexts
  contexts[#contexts+1] = opts and opts.ctx or {triggerKind=1}
  vim.g.completion_get_contexts = contexts
  return get(opts)
end`);
		for (const character of ['.', "'", '<', '。', 'p']) {
			await session.input('<Esc>');
			await lua(
				"vim.api.nvim_buf_set_lines(0,0,-1,false,{''}); vim.api.nvim_win_set_cursor(0,{1,0}); vim.g.completion_get_contexts={}"
			);
			const count = (await lua('return #vim.g.nido_completion_test_requests')) as number;
			await session.input(`i${character === '<' ? '<LT>' : character}`);
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await lua('return #vim.g.completion_get_contexts')) === 1) break;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const context =
				character === 'p'
					? { triggerKind: 1 }
					: { triggerKind: 2, triggerCharacter: character };
			assert.deepEqual(
				await lua('return vim.g.completion_get_contexts'),
				[context],
				character
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			const requests = (await lua('return vim.g.nido_completion_test_requests')) as {
				prefix: string;
				context: typeof context;
			}[];
			assert.equal(requests.length, count + 1, `Duplicate completion for ${character}`);
			assert.equal(requests.at(-1)?.prefix, character);
			assert.deepEqual(requests.at(-1)?.context, context);
		}
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('completion ignores obsolete replies and closes when the latest prefix has no candidates', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-completion-stale-'));
	const session = await Session.create(root, () => {});
	const lua = (code: string): ReturnType<Session['client']['request']> =>
		session.client.request('nvim_exec_lua', [code, []]);
	const labels = async (): Promise<string[]> =>
		(await lua(
			"return vim.tbl_map(function(item) return item.abbr end, vim.fn.complete_info({'items'}).items)"
		)) as string[];
	const replied = async (prefix: string): Promise<void> => {
		for (let attempt = 0; attempt < 200; attempt++) {
			const replies = (await lua('return vim.g.nido_completion_test_replies')) as string[];
			if (replies.includes(prefix)) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.fail(`Completion response for ${prefix} did not arrive`);
	};
	try {
		await lua(
			await readFile(join(process.cwd(), 'tests/fixtures/completion-server.lua'), 'utf8')
		);
		await lua(
			"vim.g.nido_completion_test_labels = {p={'printOld'},pr={'printRecent'},prx={}}; vim.g.nido_completion_test_delay=180"
		);
		await session.input('ip');
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await lua('return #vim.g.nido_completion_test_requests')) === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(await lua('return #vim.g.nido_completion_test_requests'), 1);
		await lua('vim.g.nido_completion_test_delay=10');
		await session.input('r');
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await labels()).includes('printRecent')) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.deepEqual(await labels(), ['printRecent']);
		await replied('p');
		assert.deepEqual(
			await labels(),
			['printRecent'],
			'An old response replaced the current candidates'
		);
		await session.input('x');
		await replied('prx');
		assert.equal(
			await lua('return vim.fn.pumvisible()'),
			0,
			JSON.stringify(
				await lua(
					'return {vim.g.nido_completion_test_requests,vim.fn.complete_info(),vim.api.nvim_get_current_line()}'
				)
			)
		);
		assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'prx');
	} finally {
		await session.stop();
		await rm(root, { recursive: true, force: true });
	}
});
