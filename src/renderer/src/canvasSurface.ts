export interface CanvasSurface {
    left: number;
    top: number;
    width: number;
    height: number;
}

// Match CSS bounds to the backing pixels, including fractional Windows display scaling.
export function alignCanvasSurface(
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    dpr: number
): CanvasSurface {
    const bounds = host.getBoundingClientRect();
    const left = Math.ceil(bounds.left * dpr - 0.001);
    const top = Math.ceil(bounds.top * dpr - 0.001);
    const right = Math.floor(bounds.right * dpr + 0.001);
    const bottom = Math.floor(bounds.bottom * dpr + 0.001);
    const surface = {
        left: left / dpr - bounds.left,
        top: top / dpr - bounds.top,
        width: Math.max(0, right - left) / dpr,
        height: Math.max(0, bottom - top) / dpr
    };
    for (const key of ['left', 'top', 'width', 'height'] as const) {
        // CSS serializes repeating fractions with fewer digits; avoid writing them every frame.
        const current = parseFloat(canvas.style[key]);
        if (!Number.isFinite(current) || Math.abs(current - surface[key]) * dpr > 0.01) {
            canvas.style[key] = `${surface[key]}px`;
        }
    }
    return surface;
}
