/** A 24-bit RGB number from Neovim as a CSS color such as #1e1e1e. */
export function color(value: number): string {
	return `#${value.toString(16).padStart(6, '0')}`;
}
