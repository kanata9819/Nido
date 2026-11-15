import type { Highlight } from './gridTypes';

/**
 * Read an hl_attr_define call into a Highlight. Besides the colors, it marks the groups the
 * painter draws specially (Nido's own, LSP references and diagnostics), found in `info`.
 */
export function gridHighlight(args: unknown[]): Highlight {
	const info = args[3] as { hi_name?: string }[] | undefined;
	// Whether any highlight group this one is made of matches `pattern`.
	const uses = (pattern: RegExp): boolean | undefined =>
		info?.some((item) => pattern.test(item.hi_name || ''));
	return {
		...(args[1] as Highlight),
		codeLens: uses(/^NidoCodeLens(Hint)?$/),
		indentGuide: uses(/^NidoIndent\d+$/),
		gitSign: uses(/^NidoGit(Added|Changed)$/),
		bracketMatch: uses(/^NidoBracketMatch$/),
		wordHighlight: uses(/^LspReference(Text|Read|Write)$/),
		diagnostic: uses(/^DiagnosticVirtualText(Error|Warn|Info|Hint)$/)
	};
}
