import type { Highlight } from './gridTypes';
import { color } from './gridColors';

/** How to paint cells of one highlight group: colors and canvas font. */
export interface CellStyle {
	highlight: Highlight;
	background: string;
	foreground: string;
	font: string;
	textSize: number;
	special?: string;
	accent?: string;
}

/** A cell's background color; `reverse` swaps it with the foreground. */
function cellBackground(h: Highlight, background: string, foreground: string): string {
	if (h.reverse) {
		if (h.foreground === undefined) {
			return foreground;
		}
		return color(h.foreground);
	}
	if (h.background === undefined) {
		return background;
	}
	if (h.wordHighlight && h.background === 0xffffff) {
		return (
			'#ffffff' +
			Math.round(255 * (1 - (h.blend ?? 88) / 100))
				.toString(16)
				.padStart(2, '0')
		);
	}
	return color(h.background);
}

/** A cell's text color; `reverse` swaps it with the background. */
function cellForeground(h: Highlight, background: string, foreground: string): string {
	if (h.reverse) {
		if (h.background === undefined) {
			return background;
		}
		return color(h.background);
	}
	if (h.foreground === undefined) {
		return foreground;
	}
	return color(h.foreground);
}

/** Cache shared highlight styles for one paint, using current font and theme settings. */
export function gridCellStyles(
	highlights: Map<number, Highlight>,
	background: string,
	foreground: string,
	fontSize: number,
	fontFamily: string,
	fontWeight: number
): (id: number) => CellStyle {
	const cellStyles = new Map<number, CellStyle>();
	const cellStyle = (id: number): CellStyle => {
		let style = cellStyles.get(id);
		if (!style) {
			const h = highlights.get(id) || {};
			const textSize = h.codeLens ? fontSize * 0.8 : fontSize;
			style = {
				highlight: h,
				background: cellBackground(h, background, foreground),
				foreground: cellForeground(h, background, foreground),
				font: h.codeLens
					? `${fontWeight} ${textSize}px ${fontFamily}`
					: `${h.italic ? 'italic ' : ''}${h.bold ? Math.max(700, fontWeight) : fontWeight} ${textSize}px ${fontFamily}`,
				textSize,
				special: h.special === undefined ? undefined : color(h.special),
				accent: h.diagnostic ? color(h.special ?? h.foreground ?? 0xcccccc) : undefined
			};
			cellStyles.set(id, style);
		}
		return style;
	};
	return cellStyle;
}
