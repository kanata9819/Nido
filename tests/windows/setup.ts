import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export default async function setup(): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error(
            'The Windows baseline must run on Windows x64; it cannot be skipped on another OS.'
        );
    }
    const executable = process.env.NIDO_PACKAGED_EXE!;
    const resources = join(dirname(executable), 'resources');
    const debuggerScript = await readFile('scripts/prepare-debugger.ps1', 'utf8');
    const revision = debuggerScript.match(/\$revision = '([a-f0-9]+)'/)?.[1];
    if (!revision) throw new Error('Unable to identify the bundled nvim-dap revision.');
    for (const file of [
        executable,
        join(resources, 'app.asar'),
        join(resources, 'nvim-win64/bin/nvim.exe'),
        join(resources, 'nvim-win64/share/nvim/runtime/doc/api.txt'),
        join(resources, 'nido/init.lua'),
        join(resources, 'languages/node_modules/typescript/lib/tsserver.js'),
        join(resources, 'languages/node_modules/typescript-language-server/lib/cli.mjs'),
        join(resources, 'debug/codelldb/extension/adapter/codelldb.exe'),
        join(resources, `debug/nvim-dap-${revision}/lua/dap.lua`)
    ]) {
        await access(file).catch(() => {
            throw new Error(
                `Windows baseline requires this packaged resource: ${file}. Run pnpm build:unpack first.`
            );
        });
    }
    for (const command of ['git', 'rustc', 'cargo', 'rust-analyzer']) {
        try {
            execFileSync(command, ['--version'], {
                windowsHide: true,
                stdio: 'pipe',
                timeout: 30000
            });
        } catch {
            throw new Error(
                `Windows baseline requires ${command} on PATH. Prepare the Rust toolchain and Git before testing.`
            );
        }
    }
}
