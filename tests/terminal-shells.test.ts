import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/main/session';
import { availableTerminalShells, resolveTerminalShell } from '../src/main/terminalShells';

const environmentKeys = [
    'PATH',
    'ProgramFiles',
    'ProgramW6432',
    'ProgramFiles(x86)',
    'SystemRoot',
    'WINDIR'
] as const;

async function withShellEnvironment(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'nido-shell-discovery-'));
    const original = environmentKeys.map((key) => [key, process.env[key]] as const);
    try {
        for (const key of environmentKeys) process.env[key] = root;
        await run(root);
    } finally {
        for (const [key, value] of original) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

async function executable(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not a runnable Windows executable');
    return path;
}

test('discovers standard installations without PATH and falls back from saved missing shells', async () => {
    await withShellEnvironment(async (root) => {
        process.env.PATH = '';
        const powershell = await executable(
            join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe')
        );
        const cmd = await executable(join(root, 'System32/cmd.exe'));
        // Directories are never executable choices; a WSL file without a working distro is excluded.
        await mkdir(join(root, 'PowerShell/7/pwsh.exe'), { recursive: true });
        await executable(join(root, 'System32/wsl.exe'));
        assert.deepEqual(await availableTerminalShells(), ['auto', 'powershell.exe', 'cmd.exe']);
        assert.deepEqual(await resolveTerminalShell(), [powershell, '-NoLogo']);
        assert.deepEqual(await resolveTerminalShell('pwsh'), [powershell, '-NoLogo']);
        assert.deepEqual(await resolveTerminalShell('wsl.exe'), [powershell, '-NoLogo']);
        assert.deepEqual(await resolveTerminalShell('cmd.exe'), [cmd]);

        await rm(powershell);
        assert.deepEqual(await resolveTerminalShell('powershell.exe'), [cmd]);
        assert.deepEqual(await availableTerminalShells(), ['auto', 'cmd.exe']);
        await rm(cmd);
        assert.deepEqual(await availableTerminalShells(), ['auto']);
        await assert.rejects(resolveTerminalShell(), /No supported terminal shell is installed/);
    });
});

test('uses absolute argv for PATH entries with spaces and refreshes changed installations', async () => {
    await withShellEnvironment(async (root) => {
        const pathDirectory = join(root, 'Shells with spaces');
        process.env.PATH = `;"${pathDirectory}";;`;
        const pathPwsh = await executable(join(pathDirectory, 'pwsh.exe'));
        const standardPwsh = await executable(join(root, 'PowerShell/7/pwsh.exe'));
        const cmd = await executable(join(root, 'System32/cmd.exe'));
        assert.deepEqual(await availableTerminalShells(), ['auto', 'pwsh', 'cmd.exe']);
        assert.deepEqual(await resolveTerminalShell(), [pathPwsh, '-NoLogo']);
        assert.deepEqual(await resolveTerminalShell('pwsh'), [pathPwsh, '-NoLogo']);

        await rm(pathPwsh);
        assert.deepEqual(await resolveTerminalShell('pwsh'), [standardPwsh, '-NoLogo']);
        await rm(standardPwsh);
        assert.deepEqual(await resolveTerminalShell('pwsh'), [cmd]);
        await assert.rejects(resolveTerminalShell('pwsh -NoLogo'), /Invalid terminal shell\./);
        await assert.rejects(resolveTerminalShell('unknown'), /Invalid terminal shell\./);
    });
});

test(
    'a missing PowerShell 7 selection starts an installed shell and failed restarts preserve it',
    { timeout: 30000 },
    async () => {
        const windows = process.env.SystemRoot;
        assert.ok(windows, 'Windows system directory is required for the headless terminal test');
        await withShellEnvironment(async (root) => {
            process.env.SystemRoot = windows;
            process.env.WINDIR = windows;
            let session: Session | undefined;
            const waitFor = async (name: string): Promise<string> => {
                for (let attempt = 0; attempt < 200; attempt++) {
                    try {
                        const content = await readFile(join(root, name), 'utf8');
                        if (content.includes('fallback-alive')) return content;
                    } catch (error) {
                        if (
                            !['ENOENT', 'EBUSY', 'EACCES'].includes(
                                (error as NodeJS.ErrnoException).code || ''
                            )
                        )
                            throw error;
                    }
                    await new Promise((done) => setTimeout(done, 25));
                }
                throw new Error(`The fallback shell did not write ${name}`);
            };
            try {
                assert.deepEqual(await resolveTerminalShell('pwsh'), [
                    join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                    '-NoLogo'
                ]);
                session = await Session.create(root, () => {});
                await session.startTerminal('pwsh');
                await session.input(
                    "$nidoValue = 'fallback-alive'; Set-Content first.txt $nidoValue<CR>"
                );
                assert.match(await waitFor('first.txt'), /fallback-alive/);
                await assert.rejects(session.startTerminal('invalid'), /Invalid terminal shell\./);
                process.env.SystemRoot = root;
                process.env.WINDIR = root;
                await assert.rejects(
                    session.startTerminal(),
                    /No supported terminal shell is installed/
                );
                await session.input('Set-Content second.txt $nidoValue<CR>');
                assert.match(await waitFor('second.txt'), /fallback-alive/);
                assert.equal(await session.inputMode(), 't');
            } finally {
                await session?.stop();
            }
        });
    }
);
