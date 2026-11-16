/**
 * This process's environment with only the variables that are set, as Playwright's
 * electron.launch() takes it. Tests delete or add variables on the copy.
 */
export function launchEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined
		)
	);
}
