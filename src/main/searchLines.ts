/** Match Neovim's line boundaries when a saved file contains LF line endings. */
export function searchLineEnding(text: string): string {
	if (!text.includes('\n')) {
		// Keep the existing CR-only search and replacement behavior.
		return '\r';
	}
	// A mixed LF/CRLF file is read as Unix: its CR characters remain in the lines.
	return /(?:^|[^\r])\n/.test(text) ? '\n' : '\r\n';
}
