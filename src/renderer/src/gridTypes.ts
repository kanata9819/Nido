export interface Cell {
    text: string;
    highlight: number;
}

export interface Highlight {
    codeLens?: boolean;
    indentGuide?: boolean;
    bracketMatch?: boolean;
    wordHighlight?: boolean;
    diagnostic?: boolean;
    blend?: number;
    foreground?: number;
    background?: number;
    special?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    undercurl?: boolean;
    reverse?: boolean;
    strikethrough?: boolean;
}

export interface BracketGuide {
    column: number;
    top: number;
    bottom: number;
    opening: number;
    closing: number;
    color: string;
    active: boolean;
}
