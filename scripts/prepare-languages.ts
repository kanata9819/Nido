// Installs the language tools bundled with Nido (the TypeScript language server) into
// resources/languages/node_modules with npm ci. The install is skipped while a marker file
// matches the package manifests, the installed packages and the Node.js version.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Files the bundled TypeScript support needs; a missing one forces a reinstall. */
const requiredFiles = [
	'typescript/package.json',
	'typescript/lib/tsserver.js',
	'typescript-language-server/package.json',
	'typescript-language-server/lib/cli.mjs'
];

/** Run npm ci in `directory`. */
function installLanguages(directory: string): void {
	const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
		cwd: directory,
		stdio: 'inherit',
		// npm is a .cmd shim on Windows. All command arguments above are fixed literals;
		// the repository path is passed through cwd rather than interpolated into a shell.
		shell: process.platform === 'win32',
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Language dependency installation failed (${result.signal ?? result.status}).`
		);
	}
}

/** Install the language tools unless they are up to date (or `force`). Returns whether it installed. */
export async function prepareLanguages(
	root: string,
	{
		force = false,
		install = installLanguages
	}: { force?: boolean; install?: (directory: string) => void | Promise<void> } = {}
): Promise<boolean> {
	const directory = join(root, 'resources/languages');
	const modules = join(directory, 'node_modules');
	const marker = join(modules, '.nido-prepared');
	const inputs = await Promise.all(
		['package.json', 'package-lock.json'].map((file) => readFile(join(directory, file), 'utf8'))
	);
	// A hash of everything the installed packages depend on, stored in the marker file.
	const fingerprint = async (): Promise<string> => {
		const installed = await Promise.all(
			[
				'.package-lock.json',
				'typescript/package.json',
				'typescript-language-server/package.json'
			].map((file) => readFile(join(modules, file), 'utf8'))
		);
		return createHash('sha256')
			.update(
				JSON.stringify([
					process.version,
					process.platform,
					process.arch,
					...inputs,
					...installed
				])
			)
			.digest('hex');
	};
	const verifyFiles = async (): Promise<boolean> =>
		(await Promise.all(requiredFiles.map((file) => stat(join(modules, file))))).every(
			(file) => file.isFile() && file.size > 0
		);
	if (!force) {
		try {
			if (
				(await readFile(marker, 'utf8')) === (await fingerprint()) &&
				(await verifyFiles())
			) {
				return false;
			}
		} catch (error) {
			if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
				throw error;
		}
	}
	// Never leave a successful marker behind when installation fails partway through.
	await rm(marker, { force: true });
	await install(directory);
	if (!(await verifyFiles()))
		throw new Error('Language dependencies are missing required files.');
	await writeFile(marker, await fingerprint());
	return true;
}

// Run from the command line: pnpm prepare:languages [--force].
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	prepareLanguages(dirname(__dirname), { force: process.argv.includes('--force') }).then(
		(installed) =>
			console.log(
				installed
					? 'Prepared language dependencies.'
					: 'Language dependencies are up to date.'
			),
		(error) => {
			console.error(error);
			process.exitCode = 1;
		}
	);
}
