/**
 * Where a link in the Markdown preview goes: a web page, a heading of this document, or a file
 * of the workspace (relative to the document), with the line of a GitHub-style #L12 fragment.
 */
export type MarkdownLink =
	| { kind: 'web'; url: string }
	| { kind: 'heading'; id: string }
	| { kind: 'file'; path: string; line?: number }
	| { kind: 'none' };

/** The heading id GitHub gives a heading's text: lower case, spaces as hyphens, no punctuation. */
export function headingSlug(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
		.replace(/ /g, '-');
}

/**
 * Resolve `href` of a link in the document at `documentPath` (a host path) inside the workspace
 * at `root`. A file path is returned relative to the workspace; the main process checks that
 * it stays inside it.
 */
export function resolveMarkdownLink(
	href: string,
	documentPath: string,
	root: string
): MarkdownLink {
	if (/^https?:\/\//i.test(href)) {
		return { kind: 'web', url: href };
	}
	if (href.startsWith('#')) {
		return { kind: 'heading', id: safeDecode(href.slice(1)).toLowerCase() };
	}
	// Other schemes (mailto:, file:, javascript:…) and absolute paths are not followed.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[\\/]/.test(href) || !documentPath) {
		return { kind: 'none' };
	}
	const [pathPart, fragment = ''] = href.split('#', 2);
	if (!pathPart) {
		return { kind: 'none' };
	}
	const normalize = (value: string): string => value.replace(/\\/g, '/');
	const document = normalize(documentPath);
	const base = normalize(root).replace(/\/$/, '');
	if (!document.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
		return { kind: 'none' };
	}
	const folder = document.slice(base.length + 1).replace(/[^/]*$/, '');
	const line = /^L(\d+)$/i.exec(fragment)?.[1];
	return {
		kind: 'file',
		path: `${folder}${safeDecode(pathPart)}`,
		...(line ? { line: Number(line) } : {})
	};
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
