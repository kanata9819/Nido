/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Replay output is serialized directly. */
import { Grid } from '../../src/renderer/src/grid/grid';
import type { Redraw } from '../../src/shared/types';
import { GlyphAtlas, type GlyphAtlasOptions, type GlyphInstanceKernel } from './glyphAtlas';

const columns = 160;
const rows = 49;
const lineHeight = 19;
const fontSize = 15;
const family = '"Consolas", "Yu Gothic UI", "Segoe UI Emoji", monospace';
const weight = 400;
const foregrounds = ['#d4d4d4', '#569cd6', '#6a9955', '#ce9178'];
const background = '#191e23';
const frameCount = 40;

type Mode = 'canvas' | 'atlas-ts' | 'atlas-rust';
type Trial = { mode: Mode; coldMs: number; p95Ms: number; atlasGlyphs?: number };
const modes: Mode[] = ['canvas', 'atlas-ts', 'atlas-rust'];
type Line = [string, number][];
const mixed: [string, number][] = [
	['日', 2],
	['本', 2],
	['語', 2],
	['ひ', 2],
	['カ', 2],
	['e\u0301', 1],
	['😀', 2],
	['👩‍💻', 2],
	[' ', 1],
	['W', 1],
	['j', 1]
];

function line(number: number, unicode: boolean): Line {
	const cells: Line = Array.from(`${String(number).padStart(4)} `, (text) => [text, 0]);
	const ascii = 'const value = example(argument); ';
	for (let index = 0; cells.length < columns; index++) {
		const [text, width] = unicode
			? mixed[index % mixed.length]
			: [ascii[index % ascii.length], 1];
		const highlight = Math.floor(index / 7) % foregrounds.length;
		if (cells.length + width > columns) {
			cells.push([' ', 0]);
			break;
		}
		cells.push([text, highlight]);
		if (width === 2) cells.push(['', highlight]);
	}
	return cells;
}

function initial(unicode: boolean): Redraw {
	return [
		['grid_resize', [1, columns, rows + 1]],
		[
			'default_colors_set',
			[Number.parseInt(foregrounds[0].slice(1), 16), Number.parseInt(background.slice(1), 16)]
		],
		[
			'hl_attr_define',
			...foregrounds.map((color, id) => [
				id,
				{ foreground: Number.parseInt(color.slice(1), 16) },
				{},
				[]
			])
		],
		[
			'grid_line',
			...Array.from({ length: rows }, (_, row) => [1, row, 0, line(1000 + row, unicode)])
		],
		['flush']
	];
}

const motion = Array.from({ length: frameCount }, (_, index): Redraw => {
	const incoming = 8;
	return [
		['nido_scroll', [1, 0, rows, 0, columns, incoming, 0]],
		['grid_scroll', [1, 0, rows, 0, columns, incoming, 0]],
		[
			'grid_line',
			...Array.from({ length: incoming }, (_, row) => [
				1,
				rows - incoming + row,
				0,
				line(1000 + rows + index * incoming + row, false)
			]),
			...Array.from({ length: rows }, (_, row) => [
				1,
				row,
				0,
				Array.from(String(Math.abs(row - (index % rows))).padStart(4), (text) => [text, 0])
			])
		],
		['flush']
	];
});

function viewport(): { options: GlyphAtlasOptions; width: number; height: number } {
	const dpr = window.devicePixelRatio;
	const font = `${weight} ${fontSize}px ${family}`;
	const context = document.createElement('canvas').getContext('2d')!;
	context.font = font;
	const pitch = Math.round(context.measureText('M').width * dpr);
	return {
		options: { columns, rows, lineHeight, font, fontSize, pitch, dpr, background, foregrounds },
		width: pitch * columns,
		height: Math.round((rows + 1) * lineHeight * dpr)
	};
}

function setup(unicode: boolean, engine: Mode, module: WebAssembly.Module) {
	const { options, width, height } = viewport();
	const grid = new Grid();
	grid.busy = true;
	grid.pixelScrollEnabled = true;
	grid.scrolling = true;
	grid.apply(initial(unicode));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const { dpr, pitch } = options;
	canvas.style.width = `${width / dpr}px`;
	canvas.style.height = `${height / dpr}px`;
	document.body.append(canvas);
	const atlas =
		engine === 'canvas'
			? undefined
			: new GlyphAtlas(
					canvas,
					options,
					new WebAssembly.Instance(module).exports as unknown as GlyphInstanceKernel
				);
	const paint = (physicalOffset: number): void => {
		grid.scrollFraction = physicalOffset / (lineHeight * dpr);
		if (atlas) {
			grid.prepareLayout(height / dpr, pitch / dpr, lineHeight);
			atlas.prepare(grid.cells);
			const count = atlas.pack(engine === 'atlas-ts' ? 'ts' : 'rust');
			atlas.draw(count, grid.scrollOffset * dpr);
		} else {
			grid.draw(
				canvas,
				width / dpr,
				height / dpr,
				fontSize,
				family,
				false,
				undefined,
				lineHeight,
				weight
			);
		}
	};
	return { canvas, grid, paint, atlas };
}

function differences(
	canvas: HTMLCanvasElement,
	reference: Uint8ClampedArray,
	gpu: Uint8Array
): {
	pixels: number;
	differing: number;
	overTwo: number;
	maxChannelDelta: number;
	columnsOverTwo: Record<number, number>;
} {
	const { width, height } = canvas;
	const columnsOverTwo: Record<number, number> = {};
	let differing = 0,
		overTwo = 0,
		maxChannelDelta = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = (y * width + x) * 4;
			const right = ((height - 1 - y) * width + x) * 4;
			const delta = Math.max(
				Math.abs(reference[left] - gpu[right]),
				Math.abs(reference[left + 1] - gpu[right + 1]),
				Math.abs(reference[left + 2] - gpu[right + 2])
			);
			differing += Number(delta > 0);
			overTwo += Number(delta > 2);
			if (delta > 2) {
				const column = Math.floor((x * columns) / width);
				columnsOverTwo[column] = (columnsOverTwo[column] ?? 0) + 1;
			}
			maxChannelDelta = Math.max(maxChannelDelta, delta);
		}
	}
	return { pixels: width * height, differing, overTwo, maxChannelDelta, columnsOverTwo };
}

function p95(values: number[]): number {
	return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

export async function runGlyphAtlasReplay() {
	const wasm = await WebAssembly.compileStreaming(fetch('/glyph-instances.wasm'));
	const pixels: ({ unicode: boolean; phase: number; frame: number } & ReturnType<
		typeof differences
	>)[] = [];
	const packing = { ts: [] as number[], rust: [] as number[] };
	for (const unicode of [false, true]) {
		const reference = setup(unicode, 'canvas', wasm);
		const candidate = setup(unicode, 'atlas-rust', wasm);
		const atlas = candidate.atlas!;
		const compare = (phase: number, frame: number): void => {
			reference.paint(phase);
			candidate.paint(phase);
			const expected = reference.canvas
				.getContext('2d')!
				.getImageData(0, 0, reference.canvas.width, reference.canvas.height).data;
			pixels.push({
				unicode,
				phase,
				frame,
				...differences(reference.canvas, expected, atlas.readPixels())
			});
		};
		for (const phase of [0, 0.25, 0.75]) compare(phase, 0);
		atlas.checkInstances();
		if (!unicode) {
			for (let trial = 0; trial < 9; trial++) {
				for (const mode of (trial % 2 ? ['ts', 'rust'] : ['rust', 'ts']) as (
					'ts' | 'rust'
				)[]) {
					const start = performance.now();
					for (let frame = 0; frame < 4000; frame++) atlas.pack(mode);
					if (trial >= 2) packing[mode].push((performance.now() - start) / 4000);
				}
			}
			for (const redraw of motion) {
				reference.grid.apply(redraw);
				candidate.grid.apply(redraw);
				reference.paint(0.25);
				candidate.paint(0.25);
			}
			compare(0, frameCount);
			compare(0.25, frameCount);
			atlas.checkInstances();
		}
		atlas.dispose();
		document.body.replaceChildren();
	}

	const measurements: { dense: boolean; trials: Trial[] }[] = [];
	for (const dense of [false, true]) {
		const trials: Trial[] = [];
		for (let trial = 0; trial < 3; trial++) {
			for (const mode of [...modes.slice(trial), ...modes.slice(0, trial)]) {
				const { paint, grid, atlas } = setup(false, mode, wasm);
				const coldStart = performance.now();
				paint(0.25);
				const coldMs = performance.now() - coldStart;
				const durations: number[] = [];
				for (let frame = 0; frame < frameCount; frame++) {
					await new Promise((resolve) => setTimeout(resolve, 16));
					const start = performance.now();
					if (dense) grid.apply(motion[frame]);
					paint(((frame % 3) + 1) / 4);
					durations.push(performance.now() - start);
				}
				trials.push({
					mode,
					coldMs,
					p95Ms: p95(durations),
					atlasGlyphs: atlas?.rasterizations
				});
				atlas?.dispose();
				document.body.replaceChildren();
			}
		}
		measurements.push({ dense, trials });
	}
	return { dpr: devicePixelRatio, columns, rows, frameCount, pixels, packing, measurements };
}
