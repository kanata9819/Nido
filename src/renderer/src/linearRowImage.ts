// Interpolate light, rather than encoded sRGB values, so thin strokes do not
// darken whenever they pass between two physical pixel rows.
const linear = Uint16Array.from({ length: 256 }, (_, value) => {
    const encoded = value / 255;
    return Math.round(
        (encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4) * 65535
    );
});
const encoded = Uint8Array.from({ length: 65536 }, (_, value) => {
    const light = value / 65535;
    return Math.round(
        (light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055) * 255
    );
});

interface RowImage {
    edges: Uint32Array;
    left: number;
    top: number;
    image: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    pixels: ImageData;
    phase: number;
}

/** Correct opaque row interiors; native compositing retains their clipped edges. */
export class LinearRowImages {
    private rows = new WeakMap<HTMLCanvasElement, RowImage | null>();

    prepare(source: HTMLCanvasElement, background: string): void {
        if (!this.rows.has(source)) {
            this.rows.set(source, this.create(source, background));
        }
    }

    paint(
        context: CanvasRenderingContext2D,
        source: HTMLCanvasElement,
        top: number,
        dpr: number,
        background: string
    ): void {
        const origin = Math.floor(top);
        const phase = top - origin;
        if (phase < 0.000001 || phase > 0.999999) {
            return;
        }
        this.prepare(source, background);
        const row = this.rows.get(source);
        if (!row) {
            return;
        }
        if (row.phase !== phase) {
            const data = row.pixels.data;
            const edges = row.edges;
            // Flat areas never change. Only update channels at vertical edges.
            for (let i = 0; i < edges.length; i += 3) {
                data[edges[i]] =
                    encoded[Math.round(edges[i + 1] * (1 - phase) + edges[i + 2] * phase)];
            }
            row.context.putImageData(row.pixels, 0, 0);
            row.phase = phase;
        }
        // The image is already shifted: copy it at integral physical coordinates.
        context.drawImage(
            row.image,
            row.left / dpr,
            (origin + row.top) / dpr,
            row.image.width / dpr,
            row.image.height / dpr
        );
    }

    private create(source: HTMLCanvasElement, background: string): RowImage | null {
        const pixels = source
            .getContext('2d')!
            .getImageData(0, 0, source.width, source.height).data;
        const rgb = Number.parseInt(background.slice(1), 16);
        const red = (rgb >> 16) & 255;
        const green = (rgb >> 8) & 255;
        const blue = rgb & 255;
        let left = source.width;
        let right = 0;
        let top = source.height;
        let bottom = 0;
        for (let y = 0; y < source.height; y++) {
            for (let x = 0; x < source.width; x++) {
                const offset = (y * source.width + x) * 4;
                if (
                    pixels[offset] === red &&
                    pixels[offset + 1] === green &&
                    pixels[offset + 2] === blue
                ) {
                    continue;
                }
                left = Math.min(left, x);
                right = Math.max(right, x + 1);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y + 2);
            }
        }
        // Fractionally covered row boundaries must keep their original alpha.
        top = Math.max(1, top);
        bottom = Math.min(source.height, bottom);
        if (right <= left || bottom <= top) {
            return null;
        }
        const image = source.ownerDocument.createElement('canvas');
        image.width = right - left;
        image.height = bottom - top;
        const context = image.getContext('2d', { alpha: false })!;
        const data = context.createImageData(image.width, image.height);
        data.data.fill(255);
        const edges: number[] = [];
        const stride = source.width * 4;
        for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
                const current = (top + y) * stride + (left + x) * 4;
                const destination = (y * image.width + x) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    const a = pixels[current + channel];
                    const b = pixels[current - stride + channel];
                    data.data[destination + channel] = a;
                    if (a !== b) {
                        edges.push(destination + channel, linear[a], linear[b]);
                    }
                }
            }
        }
        return {
            edges: new Uint32Array(edges),
            left,
            top,
            image,
            context,
            pixels: data,
            phase: -1
        };
    }
}
