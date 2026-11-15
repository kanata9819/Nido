// The keys shown beside a command in the command palette.

// A key combination at the end of a command's detail, such as "Ctrl+Shift+M" or
// "Space then Shift+D".
const shortcutPattern = /^(?:(?:Ctrl|Alt|Shift)\+\S+|Space then \S+)$/;

/**
 * Split a command's detail into its description and its keys: the leader key (pressed after
 * Space) and the shortcuts at the end of the detail. Shown as keys beside the command, they
 * no longer hide inside its description. A "Space then …" shortcut already names the leader
 * key, so the leader key is not shown twice.
 */
export function commandKeys(detail: string, key?: string): { text: string; keys: string[] } {
	const parts = detail.split(' · ');
	const shortcuts: string[] = [];
	while (parts.length && shortcutPattern.test(parts[parts.length - 1].trim())) {
		shortcuts.unshift(
			parts
				.pop()!
				.trim()
				.replace(/^Space then /, 'Space ')
		);
	}
	const leader = key && !shortcuts.some((shortcut) => shortcut.startsWith('Space '));
	return { text: parts.join(' · '), keys: [...(leader ? [`Space ${key}`] : []), ...shortcuts] };
}
