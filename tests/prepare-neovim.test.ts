import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available =
    spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0'], {
        windowsHide: true
    }).status === 0;

async function prepareFixture(
    root: string,
    executable = true
): Promise<{ hash: string; archive: string }> {
    const script = await readFile(resolve(__dirname, '../scripts/prepare-neovim.ps1'), 'utf8');
    const version = /\$nidoVersion = '([^']+)'/.exec(script)?.[1];
    assert.ok(version, 'The setup script must declare its Neovim version.');
    const source = join(root, 'fixture', 'nvim-win64');
    const archive = join(root, '.downloads', `nvim-win64-${version}.zip`);
    await Promise.all([
        mkdir(join(source, 'bin'), { recursive: true }),
        mkdir(join(source, 'share/nvim/runtime/doc'), { recursive: true }),
        mkdir(join(root, '.downloads'), { recursive: true }),
        mkdir(join(root, 'scripts'), { recursive: true })
    ]);
    if (executable) {
        await writeFile(join(source, 'bin/nvim.exe'), 'new executable');
    }
    await writeFile(join(source, 'share/nvim/runtime/doc/help.txt'), 'new documentation');
    execFileSync(
        powershell,
        [
            '-NoProfile',
            '-Command',
            "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:NIDO_SETUP_TEST_SOURCE -DestinationPath $env:NIDO_SETUP_TEST_ARCHIVE"
        ],
        {
            windowsHide: true,
            env: {
                ...process.env,
                NIDO_SETUP_TEST_SOURCE: source,
                NIDO_SETUP_TEST_ARCHIVE: archive
            }
        }
    );
    const hash = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
    // Exercise the production script offline using a fixture with its own verified checksum.
    await writeFile(
        join(root, 'scripts/prepare-neovim.ps1'),
        script.replace(/\$nidoHash = '[^']+'/, `$nidoHash = '${hash}'`)
    );
    return { hash, archive };
}

function runSetup(root: string): string {
    return execFileSync(
        powershell,
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(root, 'scripts/prepare-neovim.ps1')
        ],
        { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }
    );
}

for (const existing of ['missing', 'old', 'partial'] as const) {
    test(
        `Neovim setup handles ${existing} bundles and can run again`,
        { skip: !available },
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'nido-neovim-setup-'));
            const bundle = join(root, 'resources/nvim-win64');
            try {
                const { hash } = await prepareFixture(root);
                if (existing !== 'missing') {
                    await mkdir(join(bundle, 'bin'), { recursive: true });
                    await writeFile(join(bundle, 'bin/nvim.exe'), 'old executable');
                    await writeFile(join(bundle, 'obsolete.txt'), 'old resource');
                    if (existing === 'old') {
                        await mkdir(join(bundle, 'share/nvim/runtime/doc'), { recursive: true });
                        await writeFile(join(bundle, 'nido-version.txt'), 'old checksum');
                    }
                }
                assert.match(runSetup(root), /SHA256 verified/);
                assert.equal(
                    await readFile(join(bundle, 'bin/nvim.exe'), 'utf8'),
                    'new executable'
                );
                assert.equal(
                    (await readFile(join(bundle, 'nido-version.txt'), 'utf8')).trim(),
                    hash
                );
                assert.equal(
                    await readFile(join(bundle, 'share/nvim/runtime/doc/help.txt'), 'utf8'),
                    'new documentation'
                );
                await assert.rejects(readFile(join(bundle, 'obsolete.txt')), { code: 'ENOENT' });
                assert.deepEqual(await readdir(join(root, 'resources')), ['nvim-win64']);
                assert.equal(runSetup(root).trim(), '');
            } finally {
                await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
        }
    );
}

for (const failure of ['checksum', 'missing resources'] as const) {
    test(
        `Neovim setup preserves the existing bundle on ${failure} failure`,
        { skip: !available },
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'nido-neovim-setup-failure-'));
            const bundle = join(root, 'resources/nvim-win64');
            try {
                const { archive } = await prepareFixture(root, failure !== 'missing resources');
                await mkdir(join(bundle, 'bin'), { recursive: true });
                await writeFile(join(bundle, 'bin/nvim.exe'), 'old executable');
                await writeFile(join(bundle, 'nido-version.txt'), 'old checksum');
                if (failure === 'checksum') {
                    await appendFile(archive, 'corruption');
                }
                assert.throws(
                    () => runSetup(root),
                    failure === 'checksum'
                        ? /checksum mismatch/
                        : /missing required editor resources/
                );
                assert.equal(
                    await readFile(join(bundle, 'bin/nvim.exe'), 'utf8'),
                    'old executable'
                );
                assert.equal(
                    await readFile(join(bundle, 'nido-version.txt'), 'utf8'),
                    'old checksum'
                );
                assert.deepEqual(await readdir(join(root, 'resources')), ['nvim-win64']);
            } finally {
                await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
        }
    );
}
