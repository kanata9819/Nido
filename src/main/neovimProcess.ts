import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { parseWslPath } from '../shared/wsl';
import { wslArguments, type prepareWsl } from './wsl';
import { neovimBundle } from './neovimBundle';

type WslRemote = ReturnType<typeof parseWslPath>;
type WslRuntime = Awaited<ReturnType<typeof prepareWsl>>;

// Starts the embedded Neovim for a workspace, either the bundled Windows build or
// the one prepared inside a WSL distribution. --embed runs Neovim without its own UI;
// Nido drives it with RPC over stdin and stdout.
export function spawnNeovim(
	root: string,
	resources: string,
	remote: WslRemote,
	runtime?: WslRuntime
): ChildProcessWithoutNullStreams {
	const args = [
		'--embed',
		// Skip plugin loading; -u below selects Nido's own init.lua.
		'--noplugin',
		// Time Machine owns recovery; an embedded startup cannot answer swap prompts.
		'-n',
		'-i',
		'NONE',
		'-u',
		runtime ? `${runtime.resources}/nido/init.lua` : resolve(resources, 'nido/init.lua'),
		'--cmd',
		// Keep bundled parser DLLs discoverable while excluding personal config.
		"lua vim.opt.runtimepath = {vim.env.VIMRUNTIME, vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim'}; vim.opt.packpath = {}"
	];
	return spawn(
		runtime && remote ? 'wsl.exe' : resolve(resources, neovimBundle().executable),
		runtime && remote
			? wslArguments(remote.distribution, remote.path, [
					'env',
					'-u',
					'VIMRUNTIME',
					'-u',
					'VIMINIT',
					'-u',
					'EXINIT',
					'-u',
					'NVIM',
					'-u',
					'NVIM_LISTEN_ADDRESS',
					'-u',
					'NODE_OPTIONS',
					'-u',
					'NIDO_LSP_CONFIG',
					'NVIM_APPNAME=nido',
					'NIDO_WSL=1',
					`NIDO_WORKSPACE_ROOT=${remote.path}`,
					`NIDO_NODE=${runtime.node}`,
					`NIDO_LANGUAGES=${runtime.resources}/languages`,
					runtime.nvim,
					...args
				])
			: args,
		{
			cwd: runtime ? resources : root,
			// The NIDO_* variables are read by the Lua in resources/nido.
			env: runtime
				? process.env
				: {
						...process.env,
						NVIM_APPNAME: 'nido',
						NIDO_WORKSPACE_ROOT: root,
						NIDO_NODE: process.execPath,
						NIDO_LANGUAGES: resolve(resources, 'languages'),
						VIMRUNTIME: resolve(resources, neovimBundle().folder, 'share/nvim/runtime'),
						VIMINIT: '',
						EXINIT: ''
					},
			windowsHide: true,
			stdio: 'pipe'
		}
	);
}
