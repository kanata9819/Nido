/**
 * Where the bundled Neovim lives under the resources folder. Packaged builds are Windows only
 * and bundle nvim-win64. On Linux and macOS, development and tests use the official release
 * that `pnpm prepare:neovim:unix` (scripts/prepare-neovim.ts) unpacks next to it.
 */
export function neovimBundle(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): { folder: string; executable: string } {
	if (platform === 'win32') {
		return { folder: 'nvim-win64', executable: 'nvim-win64/bin/nvim.exe' };
	}
	const folder = {
		'linux-x64': 'nvim-linux-x86_64',
		'linux-arm64': 'nvim-linux-arm64',
		'darwin-arm64': 'nvim-macos-arm64',
		'darwin-x64': 'nvim-macos-x86_64'
	}[`${platform}-${arch}`];
	if (!folder) {
		throw new Error(`Bundled Neovim is not available for ${platform} ${arch}.`);
	}
	return { folder, executable: `${folder}/bin/nvim` };
}
