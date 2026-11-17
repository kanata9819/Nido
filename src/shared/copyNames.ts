/**
 * The name suggested for a copy placed beside an item of the same name: " copy" goes before a
 * file's extension (notes copy.txt), and after the whole name of a folder or of a file whose
 * only dot starts its name (.gitignore copy), as in VS Code. Later copies are numbered from 2
 * (notes copy 2.txt).
 */
export function copyName(name: string, directory: boolean, number = 1): string {
	const suffix = number > 1 ? ` copy ${number}` : ' copy';
	const dot = name.lastIndexOf('.');
	return directory || dot <= 0
		? `${name}${suffix}`
		: `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}
