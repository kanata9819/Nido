/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Probes execute as JavaScript in Electron. */
import { _electron } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(process.argv[2] ?? 'test-results/text-rendering');
await mkdir(output, { recursive: true });
const server = await createServer({
    configFile: false,
    root,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } }
});
await server.listen();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const report = [];
try {
    for (const scale of [1, 1.25, 1.5]) {
        const running = await _electron.launch({
            args: [
                resolve(root, 'main.cjs'),
                `--comparison-url=${server.resolvedUrls.local[0]}`,
                '--comparison-hidden',
                `--force-device-scale-factor=${scale}`
            ],
            env
        });
        try {
            const page = await running.firstWindow();
            const runtime = await running.evaluate(({ app }) => ({
                electron: process.versions.electron,
                chromium: process.versions.chrome,
                gpu: app.getGPUFeatureStatus()
            }));
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.waitForSelector('body[data-ready="true"]');
            for (const motion of ['direct', 'layer'])
                for (const weight of [350, 400]) {
                    await page.selectOption('#motion', motion);
                    await page.selectOption('#weight', String(weight));
                    await page.waitForFunction(
                        (weight) =>
                            document
                                .querySelector('#status')
                                .textContent.includes(`太さ ${weight}`),
                        weight
                    );
                    const geometry = await page.evaluate(() => {
                        const grid = window.textComparison.grid;
                        const rect = (selector) => {
                            const bounds = document.querySelector(selector).getBoundingClientRect();
                            return {
                                x: bounds.left,
                                y: bounds.top,
                                width: bounds.width,
                                height: bounds.height
                            };
                        };
                        return {
                            dpr: devicePixelRatio,
                            cellWidth: grid.cellWidth,
                            lineHeight: grid.cellHeight,
                            canvas: rect('#canvas'),
                            dom: rect('#dom'),
                            cells: grid.cells[20].map((cell) => cell.text).join('')
                        };
                    });
                    if (Math.abs(geometry.dpr - scale) > 0.001)
                        throw new Error('Unexpected device scale.');
                    const frames = [];
                    for (const phase of [
                        ...Array.from({ length: 9 }, (_, index) => index / 8),
                        1,
                        1
                    ]) {
                        await page.evaluate(
                            (offset) => window.textComparison.setOffset(offset),
                            phase / scale
                        );
                        await page.evaluate(
                            () =>
                                new Promise((done) =>
                                    requestAnimationFrame(() => requestAnimationFrame(done))
                                )
                        );
                        const png = await page.screenshot({
                            path:
                                phase === 0 || phase === 0.5
                                    ? resolve(
                                          output,
                                          `comparison-${scale}-${weight}-${motion}-${phase === 0 ? 'rest' : 'motion'}.png`
                                      )
                                    : undefined
                        });
                        const metrics = await running.evaluate(
                            ({ nativeImage }, { png, geometry, compare }) => {
                                const image = nativeImage.createFromBuffer(
                                    Buffer.from(png, 'base64')
                                );
                                const pixels = image.toBitmap();
                                const width = image.getSize().width;
                                const linear = (value) =>
                                    value <= 0.04045
                                        ? value / 12.92
                                        : ((value + 0.055) / 1.055) ** 2.4;
                                const background = linear(18 / 255);
                                const sample = (pane) => {
                                    const left = Math.round(
                                        (pane.x + 4 * geometry.cellWidth) * geometry.dpr
                                    );
                                    const top =
                                        Math.round(pane.y * geometry.dpr) +
                                        Math.round(20 * geometry.lineHeight * geometry.dpr) -
                                        3;
                                    const right = Math.round(
                                        (pane.x + 10 * geometry.cellWidth) * geometry.dpr
                                    );
                                    const bottom =
                                        top + Math.ceil(geometry.lineHeight * geometry.dpr) + 4;
                                    let energy = 0,
                                        moment = 0,
                                        fringes = 0,
                                        inkPixels = 0,
                                        signature = 2166136261;
                                    for (let y = top; y < bottom; y++) {
                                        for (let x = left; x < right; x++) {
                                            const index = (y * width + x) * 4;
                                            const [b, g, r] = pixels.subarray(index, index + 3);
                                            for (const value of [r, g, b])
                                                signature = Math.imul(signature ^ value, 16777619);
                                            const light =
                                                0.2126 * linear(r / 255) +
                                                0.7152 * linear(g / 255) +
                                                0.0722 * linear(b / 255) -
                                                background;
                                            energy += light;
                                            moment += light * (y - top);
                                            const coverage = [
                                                (r - 18) / (86 - 18),
                                                (g - 18) / (156 - 18),
                                                (b - 18) / (214 - 18)
                                            ];
                                            if (Math.max(...coverage) > 0.05) {
                                                inkPixels++;
                                                if (
                                                    Math.max(...coverage) - Math.min(...coverage) >
                                                    0.12
                                                )
                                                    fringes++;
                                            }
                                        }
                                    }
                                    return {
                                        energy,
                                        centroid: moment / energy,
                                        fringes,
                                        inkPixels,
                                        signature: signature >>> 0
                                    };
                                };
                                const compareRow = (row) => {
                                    const left = Math.round(geometry.canvas.x * geometry.dpr);
                                    const right = Math.round(geometry.dom.x * geometry.dpr);
                                    const top = Math.round(
                                        row * geometry.lineHeight * geometry.dpr
                                    );
                                    const canvasY =
                                        Math.round(geometry.canvas.y * geometry.dpr) + top;
                                    const domY = Math.round(geometry.dom.y * geometry.dpr) + top;
                                    const columns = Math.floor(
                                        Math.min(geometry.canvas.width, geometry.dom.width) *
                                            geometry.dpr
                                    );
                                    let differentChannels = 0;
                                    for (
                                        let y = 0;
                                        y < Math.floor(geometry.lineHeight * geometry.dpr);
                                        y++
                                    ) {
                                        for (let x = 0; x < columns; x++) {
                                            const a = ((canvasY + y) * width + left + x) * 4;
                                            const b = ((domY + y) * width + right + x) * 4;
                                            for (let channel = 0; channel < 3; channel++) {
                                                if (pixels[a + channel] !== pixels[b + channel])
                                                    differentChannels++;
                                            }
                                        }
                                    }
                                    return differentChannels;
                                };
                                return {
                                    canvas: sample(geometry.canvas),
                                    dom: sample(geometry.dom),
                                    restDifferences: compare
                                        ? {
                                              latin: compareRow(20),
                                              japanese: compareRow(19),
                                              unicode: compareRow(22)
                                          }
                                        : undefined
                                };
                            },
                            {
                                png: png.toString('base64'),
                                geometry,
                                compare: phase === 0 && motion === 'direct'
                            }
                        );
                        frames.push({ phase, ...metrics });
                    }
                    const summary = (renderer) => {
                        const samples = frames.slice(0, 9).map((frame) => frame[renderer]);
                        const energies = samples.map((sample) => sample.energy);
                        const steps = samples
                            .slice(1)
                            .map((sample, index) => samples[index].centroid - sample.centroid);
                        return {
                            energyVariationPercent:
                                (100 * (Math.max(...energies) - Math.min(...energies))) /
                                (energies.reduce((a, b) => a + b) / energies.length),
                            largestCentroidStepPx: Math.max(...steps.map(Math.abs)),
                            restFringePixels: samples[0].fringes,
                            restInkPixels: samples[0].inkPixels,
                            pausedPixelsStable: frames
                                .slice(-3)
                                .every(
                                    (frame) =>
                                        frame[renderer].signature ===
                                        frames.at(-1)[renderer].signature
                                )
                        };
                    };
                    const entry = {
                        scale,
                        weight,
                        motion,
                        runtime,
                        geometry,
                        canvas: summary('canvas'),
                        dom: summary('dom'),
                        frames
                    };
                    await page.evaluate(() => {
                        const cells = [...document.querySelectorAll('#dom .cell')];
                        cells.find((cell) => cell.textContent === 'u').dataset.probe = 'latin';
                        cells.find((cell) => cell.textContent === '漢').dataset.probe = 'japanese';
                    });
                    const client = await page.context().newCDPSession(page);
                    await client.send('DOM.enable');
                    await client.send('CSS.enable');
                    const { root: documentNode } = await client.send('DOM.getDocument');
                    entry.fonts = {};
                    for (const probe of ['latin', 'japanese']) {
                        const { nodeId } = await client.send('DOM.querySelector', {
                            nodeId: documentNode.nodeId,
                            selector: `[data-probe="${probe}"]`
                        });
                        entry.fonts[probe] = (
                            await client.send('CSS.getPlatformFontsForNode', { nodeId })
                        ).fonts;
                    }
                    await client.detach();
                    for (const renderer of ['canvas', 'dom']) {
                        if (
                            !entry[renderer].pausedPixelsStable ||
                            frames.some(
                                (frame) =>
                                    !Number.isFinite(frame[renderer].centroid) ||
                                    frame[renderer].energy <= 0
                            )
                        ) {
                            throw new Error(`Invalid or unstable ${renderer} samples.`);
                        }
                    }
                    report.push(entry);
                    process.stdout.write(
                        `${JSON.stringify({ scale, weight, motion, canvas: entry.canvas, dom: entry.dom, fonts: entry.fonts })}\n`
                    );
                }
            await page.locator('#dom').hover();
            await page.mouse.wheel(0, 0.25);
            await page.waitForFunction(
                () => Number(document.querySelector('#offset').value) > 1 / devicePixelRatio
            );
            await page.click('#reset');
            await page.waitForFunction(() => document.querySelector('#offset').value === '0');
            await page.click('#animate');
            await page.waitForFunction(() => Number(document.querySelector('#offset').value) > 0.1);
            await page.click('#animate');
            const stopped = await page.inputValue('#offset');
            await page.evaluate(
                () =>
                    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
            );
            if ((await page.inputValue('#offset')) !== stopped)
                throw new Error('Animation did not pause.');
            for (const family of ['cascadia', 'consolas', 'meiryo']) {
                await page.selectOption('#family', family);
                for (const size of ['13', '15']) {
                    await page.selectOption('#size', size);
                    await page.waitForFunction(
                        (size) =>
                            getComputedStyle(document.querySelector('#dom')).fontSize ===
                            `${size}px`,
                        size
                    );
                    if (
                        (await page.evaluate(() => window.textComparison.grid.cellHeight)) <
                        Number(size)
                    )
                        throw new Error('Incorrect line metrics.');
                }
            }
            if (errors.length) throw new Error(errors.join('\n'));
        } finally {
            await running.close();
        }
    }
    await writeFile(resolve(output, 'measurements.json'), JSON.stringify(report, null, 2));
} finally {
    await server.close();
}
