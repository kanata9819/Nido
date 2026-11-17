/**
 * The name suggested for a copy pasted beside its original: " copy" goes before a file's
 * extension (notes copy.txt), and after the whole name of a folder or of a file whose only
 * dot starts its name (.gitignore copy), as in VS Code.
 */
export function copyName(name: string, directory: boolean): string {
	const dot = name.lastIndexOf('.');
	return directory || dot <= 0 ? `${name} copy` : `${name.slice(0, dot)} copy${name.slice(dot)}`;
}
