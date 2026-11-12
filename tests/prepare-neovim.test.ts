import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFile,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { neovimBundle } from '../src/main/neovimBundle';
import { neovimReleases } from '../scripts/prepare-neovim';

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
	await copyFile(
		resolve(__dirname, '../scripts/download-archive.ps1'),
		join(root, 'scripts/download-archive.ps1')
	);
	return { hash, archive };
}

function runSetup(
	root: string,
	download?: { source: string; fail?: boolean },
	script = 'prepare-neovim.ps1'
): string {
	return execFileSync(
		powershell,
		[
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass',
			...(download
				? [
						'-Command',
						`$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)
    [IO.File]::AppendAllText($env:NIDO_SETUP_TEST_CALLS, $OutFile + [Environment]::NewLine)
    Copy-Item -LiteralPath $env:NIDO_SETUP_TEST_SOURCE -Destination $OutFile
    if ($env:NIDO_SETUP_TEST_FAIL -eq '1') { throw 'interrupted fixture download' }
}
& $env:NIDO_SETUP_TEST_SCRIPT`
					]
				: ['-File', join(root, 'scripts', script)])
		],
		{
			windowsHide: true,
			encoding: 'utf8',
			stdio: 'pipe',
			env: {
				...process.env,
				NIDO_SETUP_TEST_SOURCE: download?.source,
				NIDO_SETUP_TEST_FAIL: download?.fail ? '1' : '0',
				NIDO_SETUP_TEST_CALLS: join(root, 'download-calls.txt'),
				NIDO_SETUP_TEST_SCRIPT: join(root, 'scripts', script)
			}
		}
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
				let download: { source: string } | undefined;
				if (failure === 'checksum') {
					await appendFile(archive, 'corruption');
					const source = join(root, 'corrupted.zip');
					await copyFile(archive, source);
					download = { source };
				}
				assert.throws(
					() => runSetup(root, download),
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

test(
	'Neovim setup replaces a corrupt cached archive and reuses the repaired bundle',
	{ skip: !available },
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-neovim-cache-'));
		try {
			const { hash, archive } = await prepareFixture(root);
			const source = join(root, 'verified.zip');
			await copyFile(archive, source);
			await appendFile(archive, 'corruption');
			assert.match(runSetup(root, { source }), /SHA256 verified/);
			assert.equal(
				createHash('sha256')
					.update(await readFile(archive))
					.digest('hex'),
				hash
			);
			assert.equal(runSetup(root, { source }).trim(), '');
			assert.equal(
				(await readFile(join(root, 'download-calls.txt'), 'utf8')).trim().split(/\r?\n/)
					.length,
				1
			);
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
);

for (const failure of ['interrupted request', 'invalid checksum'] as const) {
	test(
		`Neovim setup can retry after a downloaded archive has an ${failure}`,
		{ skip: !available },
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'nido-neovim-download-'));
			try {
				const { archive } = await prepareFixture(root);
				const source = join(root, 'download.zip');
				await copyFile(archive, source);
				if (failure === 'invalid checksum') await appendFile(source, 'corruption');
				await rm(archive);
				assert.throws(
					() => runSetup(root, { source, fail: failure === 'interrupted request' }),
					failure === 'interrupted request'
						? /interrupted fixture download/
						: /checksum mismatch/
				);
				assert.deepEqual(await readdir(join(root, '.downloads')), []);
				assert.equal((await readdir(join(root, 'resources')).catch(() => [])).length, 0);
				const valid = await prepareFixture(root);
				await copyFile(valid.archive, source);
				await rm(valid.archive);
				assert.match(runSetup(root, { source }), /SHA256 verified/);
			} finally {
				await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
	);
}

for (const dependency of ['CodeLLDB', 'nvim-dap'] as const) {
	test(
		`${dependency} setup replaces a corrupt cached archive`,
		{ skip: !available },
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'nido-debugger-cache-'));
			try {
				let script = await readFile(
					resolve(__dirname, '../scripts/prepare-debugger.ps1'),
					'utf8'
				);
				const version = /\$version = '([^']+)'/.exec(script)?.[1];
				const revision = /\$revision = '([^']+)'/.exec(script)?.[1];
				assert.ok(version);
				assert.ok(revision);
				const codeLLDB = 'codelldb/extension/adapter/codelldb.exe';
				const dap = `nvim-dap-${revision}/lua/dap.lua`;
				const relative = dependency === 'CodeLLDB' ? 'extension/adapter/codelldb.exe' : dap;
				const fixture = join(root, 'fixture');
				const other = join(
					root,
					'resources/debug',
					dependency === 'CodeLLDB' ? dap : codeLLDB
				);
				const installed = join(
					root,
					'resources/debug',
					dependency === 'CodeLLDB' ? codeLLDB : dap
				);
				const archive = join(
					root,
					'.downloads',
					dependency === 'CodeLLDB'
						? `codelldb-${version}.vsix`
						: `nvim-dap-${revision}.zip`
				);
				const source = join(root, 'verified.zip');
				for (const directory of [
					join(fixture, relative, '..'),
					join(other, '..'),
					join(root, '.downloads'),
					join(root, 'scripts')
				]) {
					await mkdir(directory, { recursive: true });
				}
				await writeFile(join(fixture, relative), 'new dependency');
				await writeFile(other, 'existing other dependency');
				execFileSync(
					powershell,
					[
						'-NoProfile',
						'-Command',
						'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:NIDO_SETUP_TEST_SOURCE, $env:NIDO_SETUP_TEST_ARCHIVE)'
					],
					{
						windowsHide: true,
						env: {
							...process.env,
							NIDO_SETUP_TEST_SOURCE: fixture,
							NIDO_SETUP_TEST_ARCHIVE: archive
						}
					}
				);
				const hash = createHash('sha256')
					.update(await readFile(archive))
					.digest('hex');
				script =
					dependency === 'CodeLLDB'
						? script.replace(/\$hash = '[^']+'/, `$hash = '${hash}'`)
						: script.replace(
								'5b5085443ce67a9c09de7a2403ab6fb7c1e76d3a38bc2b80ba231acd2e886f2a',
								hash
							);
				await writeFile(join(root, 'scripts/prepare-debugger.ps1'), script);
				await copyFile(
					resolve(__dirname, '../scripts/download-archive.ps1'),
					join(root, 'scripts/download-archive.ps1')
				);
				await copyFile(archive, source);
				await appendFile(archive, 'corruption');
				assert.match(
					runSetup(root, { source }, 'prepare-debugger.ps1'),
					/Bundled CodeLLDB/
				);
				assert.equal(await readFile(installed, 'utf8'), 'new dependency');
				assert.equal(await readFile(other, 'utf8'), 'existing other dependency');
				assert.equal(
					createHash('sha256')
						.update(await readFile(archive))
						.digest('hex'),
					hash
				);
				runSetup(root, { source, fail: true }, 'prepare-debugger.ps1');
				assert.equal(
					(await readFile(join(root, 'download-calls.txt'), 'utf8')).trim().split(/\r?\n/)
						.length,
					1
				);
			} finally {
				await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
	);
}

test('each platform finds its bundled Neovim where the preparation script puts it', async () => {
	assert.deepEqual(neovimBundle('win32', 'x64'), {
		folder: 'nvim-win64',
		executable: 'nvim-win64/bin/nvim.exe'
	});
	for (const [platform, release] of Object.entries(neovimReleases)) {
		const [name, arch] = platform.split('-');
		assert.deepEqual(neovimBundle(name as NodeJS.Platform, arch), {
			folder: release.folder,
			executable: `${release.folder}/bin/nvim`
		});
		assert.match(release.sha256, /^[0-9a-f]{64}$/);
	}
	assert.throws(() => neovimBundle('freebsd', 'x64'), /not available for freebsd x64/);
});
