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
  const pixels = delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
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
