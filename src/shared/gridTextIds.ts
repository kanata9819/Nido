export const gridTextMask = (1 << 17) - 1;
export const firstGridGrapheme = 0x10002;

/** Exact cell text IDs. Zero represents a missing cell and one a wide-cell continuation. */
export class GridTextIds {
	private readonly ids = new Map<string, number>();
	readonly graphemes: string[] = [];

	id(text: string): number | undefined {
		if (text.length < 2) {
			return text.length ? text.charCodeAt(0) + 2 : 1;
		}
		const id = this.ids.get(text);
		if (id !== undefined) {
			return id;
		}
		const next = firstGridGrapheme + this.graphemes.length;
		if (next > gridTextMask) {
			return undefined;
		}
		this.ids.set(text, next);
		this.graphemes.push(text);
		return next;
	}

	text(id: number): string {
		return gridTextFromId(id, this.graphemes);
	}

	word(text: string, highlight: number): number | undefined {
		if (highlight >>> 0 !== highlight || highlight >= 32768) {
			return undefined;
		}
		const code = this.id(text);
		return code === undefined ? undefined : ((highlight << 17) | code) >>> 0;
	}
}

export function gridTextFromId(id: number, graphemes: readonly string[]): string {
	return id >= firstGridGrapheme
		? graphemes[id - firstGridGrapheme]
		: id === 1
			? ''
			: String.fromCharCode(id - 2);
}
