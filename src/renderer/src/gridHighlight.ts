import type { Highlight } from './gridTypes';

/** Interpret Neovim highlight metadata used by the renderer. */
export function gridHighlight(args: unknown[]): Highlight {
	const info = args[3] as { hi_name?: string }[] | undefined;
	return {
		...(args[1] as Highlight),
		codeLens: info?.some(
			(item) => item.hi_name === 'NidoCodeLens' || item.hi_name === 'NidoCodeLensHint'
		),
		indentGuide: info?.some((item) => /^NidoIndent\d+$/.test(item.hi_name || '')),
		gitSign: info?.some((item) => /^NidoGit(Added|Changed)$/.test(item.hi_name || '')),
		bracketMatch: info?.some((item) => item.hi_name === 'NidoBracketMatch'),
		wordHighlight: info?.some((item) =>
			/^LspReference(Text|Read|Write)$/.test(item.hi_name || '')
		),
		diagnostic: info?.some((item) =>
			/^DiagnosticVirtualText(Error|Warn|Info|Hint)$/.test(item.hi_name || '')
		)
	};
}
