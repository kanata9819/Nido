/** Check the hardware-only path without leaving a spare GPU context alive. */
export function supportsHardwareWebGL(): boolean {
    const context = document
        .createElement('canvas')
        .getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
}

// Follow glyphs through offscreen rasterization so scroll probes measure their
// position, including coverage changes within a physical pixel.
export function installRowImageProbe(): void {
    const transform = CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform = function (...args) {
        if (!this.canvas.isConnected) {
            this.canvas.dataset.rowText = '';
            delete this.canvas.dataset.rowBaseline;
        }
        Reflect.apply(transform, this, args);
    };
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
        if (!this.canvas.isConnected) {
            this.canvas.dataset.rowText = (this.canvas.dataset.rowText ?? '') + args[0];
            this.canvas.dataset.rowBaseline = String(args[2] * this.getTransform().d);
        }
        text.apply(this, args);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const source = args[0];
        if (!this.canvas.isConnected && source instanceof HTMLCanvasElement) {
            this.canvas.dataset.rowText = source.dataset.rowText ?? '';
            const scale =
                args.length === 3
                    ? 1
                    : args.length === 5
                      ? Number(args[4]) / source.height
                      : Number(args[8]) / Number(args[4]);
            const y = Number(args[args.length === 9 ? 6 : 2]);
            this.canvas.dataset.rowBaseline = String(
                Number(source.dataset.rowBaseline ?? 0) * scale + y
            );
        }
        Reflect.apply(draw, this, args);
    };
}
