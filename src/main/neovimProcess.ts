import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { parseWslPath } from '../shared/wsl';
import { wslArguments, type prepareWsl } from './wsl';

type WslRemote = ReturnType<typeof parseWslPath>;
type WslRuntime = Awaited<ReturnType<typeof prepareWsl>>;

// ワークスペース用のNeovimを起動する。
// --embed は「画面を持たず、標準入出力でプログラムから操作する」モード。Nidoはこの入出力でRPCを送る。
// Windowsのフォルダーなら同梱の nvim.exe を、WSLのフォルダーなら wsl.exe 経由でLinux側のNeovimを起動する。
// Starts the embedded Neovim for a workspace, either the bundled Windows build or
// the one prepared inside a WSL distribution.
export function spawnNeovim(
  root: string,
  resources: string,
  remote: WslRemote,
  runtime?: WslRuntime
): ChildProcessWithoutNullStreams {
  const args = [
    '--embed',
    // プラグインを自動で読み込まない。設定ファイルは下の -u で Nido 専用の init.lua を指定する。
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
    runtime && remote ? 'wsl.exe' : resolve(resources, 'nvim-win64/bin/nvim.exe'),
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
      // Neovim側のLuaが使う環境変数。NIDO_◯◯ は resources/nido の Lua から参照される。
      env: runtime
        ? process.env
        : {
            ...process.env,
            NVIM_APPNAME: 'nido',
            NIDO_WORKSPACE_ROOT: root,
            NIDO_NODE: process.execPath,
            NIDO_LANGUAGES: resolve(resources, 'languages'),
            VIMRUNTIME: resolve(resources, 'nvim-win64/share/nvim/runtime'),
            VIMINIT: '',
            EXINIT: ''
          },
      windowsHide: true,
      stdio: 'pipe'
    }
  );
}
