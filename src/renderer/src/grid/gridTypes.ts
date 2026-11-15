// Data types of the editor grid.

/** One grid cell: its text (empty after a wide character) and highlight id. */
export interface Cell {
	text: string;
	highlight: number;
}

/**
 * A highlight group from hl_attr_define. Colors are 24-bit RGB numbers. The first flags mark
 * Nido's own highlight groups, which the painter draws specially.
 */
export interface Highlight {
	codeLens?: boolean;
	indentGuide?: boolean;
	gitSign?: boolean;
	bracketMatch?: boolean;
	wordHighlight?: boolean;
	diagnostic?: boolean;
	/** Transparency from 0 (opaque) to 100. */
	blend?: number;
	foreground?: number;
	background?: number;
	/** Color of underlines and undercurls. */
	special?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	undercurl?: boolean;
	reverse?: boolean;
	strikethrough?: boolean;
}

/** A vertical guide joining a pair of brackets, in grid rows and columns. */
export interface BracketGuide {
	column: number;
	top: number;
	bottom: number;
	opening: number;
	closing: number;
	color: string;
	/** Whether the cursor is inside this pair, which draws the guide brighter. */
	active: boolean;
}
