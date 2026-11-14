import { stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { terminalShells, type TerminalShell } from '../shared/types';
import { wslDistributions } from './wsl';

// Finds the shells installed on this computer for terminal workspaces.
type InstalledShell = Exclude<TerminalShell, 'auto'>;

/**
 * The command line that starts `shell`, or undefined when it is not installed. Searches PATH
 * and the shell's usual install folder. wsl.exe only counts when a distribution is installed.
 */
async function installedShell(shell: InstalledShell): Promise<string[] | undefined> {
	const directories = (process.env.PATH ?? '')
		.split(delimiter)
		.map((directory) => directory.replace(/^"(.*)"$/, '$1'))
		.filter(Boolean);
	const windows = process.env.SystemRoot || process.env.WINDIR;
	if (shell === 'pwsh') {
		for (const programFiles of [
			process.env.ProgramFiles,
			process.env.ProgramW6432,
			process.env['ProgramFiles(x86)']
		]) {
			if (programFiles) {
				directories.push(resolve(programFiles, 'PowerShell/7'));
			}
		}
	} else if (windows) {
		directories.push(
			resolve(
				windows,
				shell === 'powershell.exe' ? 'System32/WindowsPowerShell/v1.0' : 'System32'
			)
		);
	}
	for (const directory of new Set(directories)) {
		const executable = resolve(directory, shell === 'pwsh' ? 'pwsh.exe' : shell);
		try {
			if (!(await stat(executable)).isFile()) {
				continue;
			}
			if (shell === 'wsl.exe' && !(await wslDistributions(executable)).length) {
				continue;
			}
			return [
				executable,
				...(shell === 'pwsh' || shell === 'powershell.exe' ? ['-NoLogo'] : [])
			];
		} catch {
			// Missing executables and an unavailable WSL installation are not choices.
		}
	}
	return undefined;
}

/** The shells the terminal settings can offer, always including `auto`. */
export async function availableTerminalShells(): Promise<TerminalShell[]> {
	const available = await Promise.all(
		terminalShells.map(async (shell) =>
			shell === 'auto' || (await installedShell(shell)) ? shell : undefined
		)
	);
	return available.filter((shell): shell is TerminalShell => shell !== undefined);
}

/**
 * The command line for the chosen shell. When it is `auto` or not installed, falls back to
 * PowerShell 7, then Windows PowerShell, then cmd.exe.
 */
export async function resolveTerminalShell(choice = 'auto'): Promise<string[]> {
	if (!terminalShells.includes(choice as TerminalShell)) {
		throw new Error('Invalid terminal shell.');
	}
	if (choice !== 'auto') {
		const command = await installedShell(choice as InstalledShell);
		if (command) {
			return command;
		}
	}
	for (const shell of ['pwsh', 'powershell.exe', 'cmd.exe'] as const) {
		const command = await installedShell(shell);
		if (command) {
			return command;
		}
	}
	throw new Error('No supported terminal shell is installed.');
}
