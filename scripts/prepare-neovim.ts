// Prepare the pinned Neovim release for development and tests on Linux and macOS, the way
// scripts/prepare-neovim.ps1 does on Windows: download it once, check its SHA256, and unpack
// it into resources/<folder>. Packaged builds are Windows only and use prepare-neovim.ps1.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const neovimVersion = '0.11.5';

/** Release archives by platform and architecture, as process.platform and process.arch name them. */
export const neovimReleases: Record<string, { folder: string; sha256: string }> = {
	'linux-x64': {
		folder: 'nvim-linux-x86_64',
		sha256: 'b2f91117be5b5ea39edd7297156dc2a4a8df4add6c95a90809a8df19e7ab6f52'
	},
	'linux-arm64': {
		folder: 'nvim-linux-arm64',
		sha256: 'ea4f9a31b11cc1477ff014aebb7b207684e7280f94ffa97abdab6cacd9b98519'
	},
	'darwin-arm64': {
		folder: 'nvim-macos-arm64',
		sha256: '79143d3b408f7034f90b7cf59af2276de09ef8a4c2f1a28e4c99581b249d3107'
	},
	'darwin-x64': {
		folder: 'nvim-macos-x86_64',
		sha256: '6612760a7037ca2518e456908baf5e43101fa79819d18979fc4d4e8441d9dfa5'
	}
};

async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

const complete = (bundle: string): boolean =>
	existsSync(join(bundle, 'bin/nvim')) && existsSync(join(bundle, 'share/nvim/runtime/doc'));

export async function prepareNeovim(
	root: string,
	platform: string = process.platform,
	arch: string = process.arch
): Promise<string> {
	const release = neovimReleases[`${platform}-${arch}`];
	if (!release) {
		throw new Error(
			`No Neovim release is pinned for ${platform} ${arch}. On Windows, run pnpm prepare:neovim.`
		);
	}
	const resources = join(root, 'resources');
	const bundle = join(resources, release.folder);
	const marker = join(bundle, 'nido-version.txt');
	if (
		existsSync(marker) &&
		(await readFile(marker, 'utf8')).trim() === release.sha256 &&
		complete(bundle)
	) {
		return bundle;
	}
	const downloads = join(root, '.downloads');
	await mkdir(downloads, { recursive: true });
	const archive = join(downloads, `${release.folder}-${neovimVersion}.tar.gz`);
	if (!existsSync(archive)) {
		const url = `https://github.com/neovim/neovim/releases/download/v${neovimVersion}/${release.folder}.tar.gz`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Could not download ${url}: ${response.status}`);
		}
		await writeFile(`${archive}.tmp`, Buffer.from(await response.arrayBuffer()));
		await rename(`${archive}.tmp`, archive);
	}
	if ((await sha256(archive)) !== release.sha256) {
		await rm(archive, { force: true });
		throw new Error(`Neovim archive checksum mismatch: ${archive}`);
	}
	const temporary = join(resources, `.nvim-${randomUUID()}`);
	const backup = join(resources, `.nvim-backup-${randomUUID()}`);
	try {
		await mkdir(temporary, { recursive: true });
		execFileSync('tar', ['-xzf', archive, '-C', temporary]);
		const prepared = join(temporary, release.folder);
		if (!complete(prepared)) {
			throw new Error('Neovim archive is missing required editor resources.');
		}
		await writeFile(join(prepared, 'nido-version.txt'), `${release.sha256}\n`);
		if (existsSync(bundle)) {
			await rename(bundle, backup);
		}
		try {
			await rename(prepared, bundle);
		} catch (error) {
			if (existsSync(backup)) {
				await rename(backup, bundle);
			}
			throw error;
		}
		await rm(backup, { recursive: true, force: true });
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
	void prepareNeovim(dirname(__dirname)).then(
		(bundle) => console.log(`Bundled Neovim ${neovimVersion} in ${bundle}, SHA256 verified.`),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	);
}
