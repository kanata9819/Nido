import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { neovimBundle } from '../src/main/neovimBundle';

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
