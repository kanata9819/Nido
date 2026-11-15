/**
 * Place a popup card next to the editor cursor: below it, or above it when it does not fit,
 * and kept 12px inside `host`. `anchor` is the editor's input element, which follows the
 * cursor. Used by the hover and diagnostic cards.
 */
export function placeNearCursor(
	element: HTMLElement,
	anchor: HTMLElement,
	host: HTMLElement
): void {
	const margin = 12;
	const below = anchor.offsetTop + anchor.offsetHeight + 10;
	const above = anchor.offsetTop - element.offsetHeight - 10;
	const fitsBelow = below + element.offsetHeight <= host.clientHeight - margin;
	const left = Math.min(anchor.offsetLeft, host.clientWidth - element.offsetWidth - margin);
	const top = Math.min(
		fitsBelow ? below : above,
		host.clientHeight - element.offsetHeight - margin
	);
	element.style.left = `${Math.max(margin, left)}px`;
	element.style.top = `${Math.max(margin, top)}px`;
}
