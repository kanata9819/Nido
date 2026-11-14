// Helpers for workspaces inside WSL. Windows reaches WSL files through UNC paths such as
// \\wsl.localhost\Ubuntu\home\me, while Neovim running inside WSL uses Linux paths (/home/me).
// These functions convert between the two forms.

/** A UNC path split into the WSL distribution name and the Linux path. */
export interface WslPath {
	distribution: string;
	path: string;
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

/** Whether `value` is a safe distribution name to pass to wsl.exe and to put in a path. */
export function validWslDistribution(value: string): boolean {
	return (
		!!value &&
		!/[\\/]/.test(value) &&
		!hasControlCharacters(value) &&
		!value.startsWith('-') &&
		value !== '.' &&
		value !== '..'
	);
}

/** Splits \\wsl.localhost\<distribution>\... or \\wsl$\<distribution>\...; undefined otherwise. */
export function parseWslPath(value: string): WslPath | undefined {
	const match = /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i.exec(value);
	if (!match) {
		return undefined;
	}
	return { distribution: match[1], path: (match[2] || '/').replaceAll('\\', '/') };
}

/** The Windows UNC path for a Linux path in a distribution. Resolves `.` and `..`. */
export function wslHostPath(distribution: string, path: string): string {
	if (
		!validWslDistribution(distribution) ||
		!path.startsWith('/') ||
		path.includes('\\') ||
		hasControlCharacters(path)
	) {
		throw new Error('Choose a WSL distribution and an absolute Linux folder path.');
	}
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (part === '..') {
			parts.pop();
		} else if (part && part !== '.') {
			parts.push(part);
		}
	}
	return `\\\\wsl.localhost\\${distribution}\\${parts.join('\\')}`;
}

/**
 * The path Neovim should use for `path`. In a WSL workspace this is the Linux path; elsewhere
 * the path is returned unchanged.
 */
export function editorPath(root: string, path: string): string {
	const remote = parseWslPath(root);
	const file = parseWslPath(path);
	if (!remote || !file) {
		return path;
	}
	if (remote.distribution.toLowerCase() !== file.distribution.toLowerCase()) {
		throw new Error('The file belongs to another WSL distribution.');
	}
	return file.path;
}

/** The reverse of editorPath: turns a Linux path from a WSL workspace into a Windows UNC path. */
export function hostPath(root: string, path: string): string {
	const remote = parseWslPath(root);
	return remote && path.startsWith('/') && !path.startsWith('//')
		? wslHostPath(remote.distribution, path)
		: path;
}
