/**
 * The list index that a navigation key selects: Home and End jump to the ends, j/ArrowDown
 * and k/ArrowUp move by one without wrapping.
 */
export function listIndex(key: string, index: number, length: number): number {
	if (key === 'Home') {
		return 0;
	}
	if (key === 'End') {
		return length - 1;
	}
	const step = ['j', 'ArrowDown'].includes(key) ? 1 : -1;
	return Math.max(0, Math.min(length - 1, index + step));
}
