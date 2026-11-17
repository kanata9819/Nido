import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { neovimBundle } from '../src/main/neovim/neovimBundle';

const exec = promisify(execFile);
const nvim = resolve('resources', neovimBundle().executable);
const watchfiles = resolve('resources/nido/lua/nido_watchfiles.lua').replaceAll('\\', '/');
const nativePackage = resolve('node_modules/@typescript/native/package.json');

// Opens b.ts, which imports a missing export from a.ts, then adds that export to a.ts on disk
// as another tool would. The error in b.ts must go away without editing b.ts.
const script = `
local root, server = _G.arg[1], _G.arg[2]
dofile('${watchfiles}')
vim.lsp.config('ts', { cmd = { 'node', server, '--lsp', '--stdio' }, filetypes = { 'typescript' }, root_dir = root })
vim.lsp.enable('ts')
vim.cmd.edit(root .. '/src/b.ts')
local function count() return #vim.diagnostic.get(0) end
vim.wait(30000, function() return count() > 0 end, 100)
io.stdout:write('before=' .. count() .. '\\n')
vim.wait(1000)
local file = assert(io.open(root .. '/src/a.ts', 'w'))
file:write('export const a = 1;\\nexport const b = 2;\\n')
file:close()
vim.wait(20000, function() return count() == 0 end, 100)
io.stdout:write('after=' .. count() .. '\\n')
vim.cmd('qa!')
`;

test(
	'a file changed on disk refreshes the TypeScript 7 diagnostics of other open files',
	{ skip: !existsSync(nvim) || !existsSync(nativePackage), timeout: 90000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-watch-'));
		try {
			await mkdir(join(root, 'src'));
			await writeFile(
				join(root, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						strict: true,
						module: 'esnext',
						moduleResolution: 'bundler'
					},
					include: ['src']
				})
			);
			await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
			await writeFile(
				join(root, 'src/b.ts'),
				"import { a, b } from './a';\nexport const c = a + b;\n"
			);
			await writeFile(join(root, 'check.lua'), script);
			const manifest = JSON.parse(await readFile(nativePackage, 'utf8'));
			const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.tsc;
			const server = resolve('node_modules/@typescript/native', bin);
			const { stdout } = await exec(
				nvim,
				['--clean', '--headless', '-l', join(root, 'check.lua'), root, server],
				{ timeout: 80000, windowsHide: true }
			);
			assert.match(stdout, /before=[1-9]/);
			assert.match(stdout, /after=0/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);

// Where Neovim does not watch files itself (Linux, as in WSL), nido_watchfiles.lua watches
// folders with fs_event: dependency and Git folders are left out, folders made later are
// watched too, and starting returns at once.
const linuxScript = `
local root = _G.arg[1]
dofile('${watchfiles}')
local events = {}
local function line(text) io.stdout:write(text .. '\\n') end
local start = vim.uv.hrtime()
local cancel = require('vim.lsp._watchfiles')._watchfunc(root, { debounce = 50 }, function(path, change)
  table.insert(events, path:sub(#root + 2) .. '=' .. change)
end)
line('started=' .. ((vim.uv.hrtime() - start) / 1e6 < 50 and 'fast' or 'slow'))
vim.wait(500)
local function write(path)
  local file = assert(io.open(root .. '/' .. path, 'w'))
  file:write('x')
  file:close()
end
write('node_modules/package/lib/index.js')
write('.git/objects/blob')
write('src/a/b/changed.ts')
vim.fn.mkdir(root .. '/src/new')
vim.wait(500)
write('src/new/later.ts')
vim.wait(500)
table.sort(events)
line('events=' .. table.concat(events, ','))
cancel()
vim.cmd('qa!')
`;

test(
	'on Linux, files are watched without dependency folders, including folders made later',
	{ skip: process.platform !== 'linux' || !existsSync(nvim), timeout: 30000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-linux-watch-'));
		try {
			for (const folder of ['src/a/b', 'node_modules/package/lib', '.git/objects']) {
				await mkdir(join(root, folder), { recursive: true });
			}
			await writeFile(join(root, 'src/a/b/changed.ts'), '');
			await writeFile(join(root, 'check.lua'), linuxScript);
			const { stdout } = await exec(
				nvim,
				['--clean', '--headless', '-l', join(root, 'check.lua'), root],
				{ timeout: 20000 }
			);
			assert.match(stdout, /started=fast/);
			// 1 is created, 2 changed (vim._watch.FileChangeType).
			assert.match(
				stdout,
				/events=src\/a\/b\/changed\.ts=2,src\/new\/later\.ts=1,src\/new=1\n/
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);
