export function scrollOffset(distance: number, elapsed: number): number {
    const progress = Math.min(1, Math.max(0, elapsed / 120));
    return distance * (1 - progress) ** 3;
}

export function accumulateScroll(
    remainder: number,
    delta: number,
    mode: number,
    lineHeight: number,
    pageHeight: number
): { lines: number; remainder: number } {
    let unit = 1;
    if (mode === 1) {
        unit = lineHeight;
    } else if (mode === 2) {
        unit = pageHeight;
    }
    const pixels = delta * unit;
    if (!pixels || !Number.isFinite(pixels)) {
        return { lines: 0, remainder };
    }
    if (Math.sign(pixels) !== Math.sign(remainder)) {
        remainder = 0;
    }
    const total = remainder + pixels;
    const lines = Math.trunc(total / lineHeight);
    return { lines, remainder: total - lines * lineHeight };
}
