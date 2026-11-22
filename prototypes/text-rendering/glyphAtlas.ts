import type { Cell } from '../../src/renderer/src/grid/gridTypes';

export interface GlyphInstanceKernel {
	memory: WebAssembly.Memory;
	__heap_base: WebAssembly.Global;
	glyph_instances(base: number, length: number): number;
}

export interface GlyphAtlasOptions {
	columns: number;
	rows: number;
	dpr: number;
	pitch: number;
	lineHeight: number;
	font: string;
	fontSize: number;
	background: string;
	foregrounds: string[];
}

const slotsAcross = 64;
const slotsDown = 24;
const gutter = 4;
const glyphKeyBase = 2048;
type Glyph = { id: number; cell: Cell; left: number; right: number };

const vertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in uvec2 instance;
uniform vec2 viewport;
uniform ivec3 grid;
uniform vec2 vertical;
flat out ivec2 tile;
flat out ivec2 origin;
flat out float phase;
void main() {
  int cell = int(instance.x), slot = int(instance.y) - 1;
  int row = cell / grid.x;
  tile = ivec2((slot % ${slotsAcross}) * (grid.y + ${2 * gutter}) + ${gutter}, (slot / ${slotsAcross}) * grid.z);
  float top = floor(float(row) * vertical.x + 0.5) - vertical.y;
  origin = ivec2((cell % grid.x) * grid.y, int(floor(top)));
  phase = fract(top);
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 pixel = vec2(origin) + corner * vec2(grid.y, grid.z);
  gl_Position = vec4(pixel / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D atlas;
uniform vec2 viewport;
uniform vec3 background;
flat in ivec2 tile;
flat in ivec2 origin;
flat in float phase;
out vec4 pixel;
void main() {
  ivec2 xy = ivec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y) - origin;
  vec3 light = texelFetch(atlas, tile + xy, 0).rgb;
  if (phase != 0.0) {
    vec3 previous = xy.y == 0 ? background : texelFetch(atlas, tile + xy - ivec2(0, 1), 0).rgb;
    light = mix(light, previous, phase);
  }
  vec3 encoded = mix(12.92 * light, 1.055 * pow(light, vec3(1.0 / 2.4)) - 0.055,
                     step(vec3(0.0031308), light));
  pixel = vec4(encoded, 1.0);
}`;

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
	const program = gl.createProgram()!;
	for (const [type, source] of [
		[gl.VERTEX_SHADER, vertex],
		[gl.FRAGMENT_SHADER, fragment]
	] as const) {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			throw new Error(gl.getShaderInfoLog(shader) ?? 'Glyph shader compilation failed');
		}
		gl.attachShader(program, shader);
		gl.deleteShader(shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(gl.getProgramInfoLog(program) ?? 'Glyph shader linking failed');
	}
	return program;
}

export class GlyphAtlas {
	private readonly gl: WebGL2RenderingContext;
	private readonly scratch: CanvasRenderingContext2D;
	private readonly words = new Map<number, number>();
	private readonly glyphs = new Map<string, Glyph>();
	private readonly rowWords = new WeakMap<Cell[], Uint32Array>();
	private readonly cells: Uint32Array;
	private readonly instances: Uint32Array;
	private readonly base: number;
	private readonly rowHeight: number;
	private readonly vertical: WebGLUniformLocation | null;
	private readonly background: [number, number, number];

	constructor(
		readonly canvas: HTMLCanvasElement,
		private readonly options: GlyphAtlasOptions,
		private readonly kernel: GlyphInstanceKernel
	) {
		const { pitch, dpr, lineHeight, font, background } = options;
		this.rowHeight = Math.ceil(lineHeight * dpr);
		const value = Number.parseInt(background.slice(1), 16);
		this.background = [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
		const base = Number(kernel.__heap_base.value);
		this.base = base;
		const count = options.columns * options.rows;
		const end = base + count * 3 * Uint32Array.BYTES_PER_ELEMENT;
		const missing = end - kernel.memory.buffer.byteLength;
		if (missing > 0) kernel.memory.grow(Math.ceil(missing / 65536));
		this.cells = new Uint32Array(kernel.memory.buffer, base, count);
		this.instances = new Uint32Array(kernel.memory.buffer, base + count * 4, count * 2);

		const tile = canvas.ownerDocument.createElement('canvas');
		tile.width = pitch + 2 * gutter;
		tile.height = this.rowHeight;
		this.scratch = tile.getContext('2d', { alpha: false })!;
		this.scratch.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.scratch.font = font;
		this.scratch.textBaseline = 'alphabetic';
		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			depth: false,
			failIfMajorPerformanceCaveat: true
		});
		if (!gl) throw new Error('The glyph prototype requires WebGL 2');
		this.gl = gl;
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.disable(gl.DITHER);
		const program = createProgram(gl);
		gl.useProgram(program);
		gl.uniform2f(gl.getUniformLocation(program, 'viewport'), canvas.width, canvas.height);
		gl.uniform3i(
			gl.getUniformLocation(program, 'grid'),
			options.columns,
			pitch,
			this.rowHeight
		);
		const linear = this.background.map((value) =>
			value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
		);
		gl.uniform3fv(gl.getUniformLocation(program, 'background'), linear);
		this.vertical = gl.getUniformLocation(program, 'vertical');
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texStorage2D(
			gl.TEXTURE_2D,
			1,
			gl.SRGB8_ALPHA8,
			tile.width * slotsAcross,
			tile.height * slotsDown
		);
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 0, 0);
		gl.vertexAttribDivisor(0, 1);
	}

	get rasterizations(): number {
		return this.words.size;
	}

	private glyph(cell: Cell): Glyph | undefined {
		if (!cell.text || cell.text === ' ') return undefined;
		const key = `${cell.highlight}:${cell.text}`;
		let glyph = this.glyphs.get(key);
		if (!glyph) {
			if (this.glyphs.size >= glyphKeyBase - 1)
				throw new Error('Prototype glyph key is full');
			const bounds = this.scratch.measureText(cell.text);
			// The font's measured outline excludes some antialiased edge pixels.
			glyph = {
				id: this.glyphs.size + 1,
				cell,
				left: -bounds.actualBoundingBoxLeft * this.options.dpr - 2,
				right: bounds.actualBoundingBoxRight * this.options.dpr + 2
			};
			this.glyphs.set(key, glyph);
		}
		return glyph;
	}

	private visibleGlyph(glyph: Glyph | undefined, x: number): Glyph | undefined {
		return glyph && x + glyph.right > 0 && x + glyph.left < this.options.pitch
			? glyph
			: undefined;
	}

	private cellTile(glyphs: (Glyph | undefined)[], column: number): number {
		const { pitch, dpr, lineHeight, fontSize, background, foregrounds } = this.options;
		let key = 0;
		// shortcut: cover the fixture's two-cell glyphs and nearest ink fringes, use measured spans for arbitrary text.
		for (let offset = -2; offset <= 1; offset++) {
			const glyph = this.visibleGlyph(glyphs[column + offset], offset * pitch);
			key = key * glyphKeyBase + (glyph?.id ?? 0);
		}
		if (!key) return 0;
		const cached = this.words.get(key);
		if (cached !== undefined) return cached;
		const slot = this.words.size;
		// shortcut: one fixed atlas page for the replay, add eviction before accepting arbitrary buffers.
		if (slot >= slotsAcross * slotsDown) throw new Error('Prototype glyph atlas is full');
		const ctx = this.scratch;
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
		const baseline = Math.round(((lineHeight + fontSize) / 2 - 3) * dpr) / dpr;
		// Preserve Canvas draw order and LCD blending where the adjacent glyphs touch.
		for (let offset = -2; offset <= 1; offset++) {
			const x = offset * pitch;
			const glyph = this.visibleGlyph(glyphs[column + offset], x);
			if (glyph) {
				ctx.fillStyle = foregrounds[glyph.cell.highlight];
				ctx.fillText(glyph.cell.text, (gutter + x) / dpr, baseline);
			}
		}
		const gl = this.gl;
		gl.texSubImage2D(
			gl.TEXTURE_2D,
			0,
			(slot % slotsAcross) * ctx.canvas.width,
			Math.floor(slot / slotsAcross) * ctx.canvas.height,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			ctx.canvas
		);
		const word = slot + 1;
		this.words.set(key, word);
		return word;
	}

	prepare(rows: Cell[][]): void {
		const { columns } = this.options;
		for (let index = 0; index < this.options.rows; index++) {
			const row = rows[index];
			let words = this.rowWords.get(row);
			// shortcut: replay redraws detach rows on edit, use explicit damage for in-place edits.
			if (!words) {
				words = new Uint32Array(columns);
				const glyphs = row.map((cell) => this.glyph(cell));
				for (let column = 0; column < columns; column++) {
					words[column] = this.cellTile(glyphs, column);
				}
				this.rowWords.set(row, words);
			}
			this.cells.set(words, index * columns);
		}
	}

	pack(mode: 'ts' | 'rust'): number {
		if (mode === 'rust') return this.kernel.glyph_instances(this.base, this.cells.length);
		let count = 0;
		for (let index = 0; index < this.cells.length; index++) {
			const word = this.cells[index];
			if (word) {
				this.instances[count * 2] = index;
				this.instances[count * 2 + 1] = word;
				count++;
			}
		}
		return count;
	}

	draw(count: number, scrollOffset: number): void {
		const gl = this.gl;
		gl.clearColor(...this.background, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.uniform2f(this.vertical, this.options.lineHeight * this.options.dpr, scrollOffset);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances, 0, count * 2);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
	}

	checkInstances(): void {
		const count = this.pack('ts');
		const expected = this.instances.slice(0, count * 2);
		if (
			this.pack('rust') !== count ||
			expected.some((word, index) => word !== this.instances[index])
		) {
			throw new Error('Rust and TypeScript produced different GPU instances');
		}
	}

	readPixels(): Uint8Array {
		const gl = this.gl;
		const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
		gl.readPixels(
			0,
			0,
			this.canvas.width,
			this.canvas.height,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			pixels
		);
		const error = gl.getError();
		if (error !== gl.NO_ERROR) throw new Error(`Glyph WebGL error ${error}`);
		return pixels;
	}

	dispose(): void {
		this.gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}
