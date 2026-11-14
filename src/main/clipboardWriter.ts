/**
 * Writes text to the system clipboard. Electron is loaded only when text is copied, so
 * sessions also run in tests without Electron; tests replace `write` to see what was copied.
 */
export const clipboardWriter = {
	async write(text: string): Promise<void> {
		const { clipboard } = await import('electron');
		clipboard.writeText(text);
	}
};
