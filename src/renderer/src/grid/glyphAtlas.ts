// Draws opaque grid rows from a GPU glyph atlas. Each tile is one cell's pixels, rasterized by
// Canvas2D together with the neighbours whose ink or background reaches into the cell, so text
// keeps its native LCD antialiasing and matches a row image exactly at rest. Tiles are drawn as
// one instanced quad per cell; fractional rows blend with the pixel above in linear light, like
// LinearRowImages.

/** One atlas page and its tiles for a single font, size and theme. */
export interface Page {
	texture: WebGLTexture;
	tiles: Map<string, number>;
	/** Shared by all grids using these tiles and cleared with them. */
	highlightIds: Map<string, number>;
	cellIds: Map<string, number>;
	pitch: number;
	height: number;
	across: number;
	capacity: number;
	/** Increases whenever the page is cleared, so cached row slots can be recognised as stale. */
	generation: number;
	/** The page filled up during a frame; it is cleared at the start of the next one. */
	full: boolean;
}

/** The compiled shaders and their uniform locations. */
interface Program {
	program: WebGLProgram;
	viewport: WebGLUniformLocation | null;
	tile: WebGLUniformLocation | null;
	background: WebGLUniformLocation | null;
}

const pageSize = 2048;
// The widest canvas that tile windows are painted on before one upload.
const maxBatchWidth = 8192;
const maxPages = 4;
// Each instance is the cell's left edge and row top in device pixels, its slot (0 for the plain
// background) and, packed as slot * 256 + line, the tile line drawn just above this row.
const instanceFloats = 4;

const vertex = `#version 300 es
precision highp float;
layout(location = 0) in vec4 instance;
uniform vec2 viewport;
uniform ivec3 tile;
flat out ivec2 origin;
flat out ivec2 current;
flat out ivec2 above;
flat out float phase;
ivec2 slotOrigin(int slot) {
    return slot > 0 ? ivec2((slot % tile.z) * tile.x, (slot / tile.z) * tile.y) : ivec2(-1);
}
void main() {
    float top = floor(instance.y);
    phase = instance.y - top;
    origin = ivec2(int(instance.x), int(top));
    current = slotOrigin(int(instance.z));
    int packed = int(instance.w);
    above = slotOrigin(packed >> 8);
    // The line of the tile above that shares this row's first pixel, or -1 for the background.
    if (above.x >= 0) above.y += packed & 255;
    vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
    vec2 pixel = vec2(origin) + corner * vec2(tile.xy);
    gl_Position = vec4(pixel / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D atlas;
uniform vec2 viewport;
uniform ivec3 tile;
flat in ivec2 origin;
flat in ivec2 current;
flat in ivec2 above;
flat in float phase;
out vec4 color;
uniform vec3 backgroundColor;
vec3 sampleTile(ivec2 base, ivec2 local) {
    return base.x >= 0 ? texelFetch(atlas, base + local, 0).rgb : backgroundColor;
}
vec3 decode(vec3 value) {
    return mix(value / 12.92, pow((value + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), value));
}
void main() {
    ivec2 local = ivec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y) - origin;
    vec3 value = sampleTile(current, local);
    if (phase == 0.0) {
        // Rows at whole pixels copy their tile exactly.
        color = vec4(value, 1.0);
        return;
    }
    // Blend with the pixel above in linear light.
    vec3 previous = local.y > 0
        ? sampleTile(current, local - ivec2(0, 1))
        : sampleTile(above, ivec2(local.x, 0));
    vec3 light = mix(decode(value), decode(previous), phase);
    vec3 encoded = mix(12.92 * light, 1.055 * pow(light, vec3(1.0 / 2.4)) - 0.055,
                       step(vec3(0.0031308), light));
    color = vec4(encoded, 1.0);
}`;

/** Paints the cells around one tile, from the left edge of the translated context. */
export type TilePainter = (context: CanvasRenderingContext2D) => void;

/** Tiles are opaque, so text keeps native LCD antialiasing like an opaque row image. */
function tileContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	return canvas.getContext('2d', { alpha: false })!;
}

/** Shared GPU atlas for the grids of one document, since WebGL contexts are limited. */
export class GlyphAtlas {
	private static readonly documents = new WeakMap<Document, GlyphAtlas>();

	static forDocument(document: Document): GlyphAtlas {
		let atlas = this.documents.get(document);
		if (!atlas) {
			atlas = new GlyphAtlas(document);
			this.documents.set(document, atlas);
		}
		return atlas;
	}

	readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext | null;
	private readonly pages = new Map<string, Page>();
	/** Tile windows painted since the last upload. */
	private readonly batch: HTMLCanvasElement;
	private batched: { slot: number; left: number }[] = [];
	private batchPage?: Page;
	private program?: Program;
	private buffer?: WebGLBuffer;
	private instances = new Float32Array(4096 * instanceFloats);
	private count = 0;
	private unavailable = false;
	/** Tiles rasterized since the atlas was created, for tests and measurements. */
	rasterizations = 0;

	private constructor(document: Document) {
		this.canvas = document.createElement('canvas');
		this.batch = document.createElement('canvas');
		this.gl = this.canvas.getContext('webgl2', {
			alpha: true,
			premultipliedAlpha: true,
			antialias: false,
			depth: false,
			stencil: false,
			preserveDrawingBuffer: false,
			// Software WebGL is slower than native Canvas2D painting.
			failIfMajorPerformanceCaveat: true
		});
		this.canvas.addEventListener('webglcontextlost', (event) => {
			event.preventDefault();
			this.pages.clear();
			this.batched = [];
			this.program = undefined;
			this.buffer = undefined;
		});
	}

	/** Whether the atlas can draw on this machine. */
	get available(): boolean {
		return !!this.gl && !this.gl.isContextLost() && !this.unavailable;
	}

	/**
	 * The page for one font, size and theme, or undefined when WebGL is unavailable. A page that
	 * filled up during the previous frame starts empty again.
	 */
	page(style: string, pitch: number, height: number): Page | undefined {
		const gl = this.gl;
		if (
			!gl ||
			gl.isContextLost() ||
			this.unavailable ||
			pitch < 1 ||
			height < 1 ||
			height > 255
		) {
			return undefined;
		}
		this.program ??= this.createProgram(gl);
		if (!this.program) {
			this.unavailable = true;
			return undefined;
		}
		let page = this.pages.get(style);
		if (page && (page.pitch !== pitch || page.height !== height)) {
			this.deletePage(style, page);
			page = undefined;
		}
		if (!page) {
			page = this.createPage(gl, pitch, height);
			if (!page) {
				return undefined;
			}
			this.pages.set(style, page);
			for (const [key, old] of this.pages) {
				if (this.pages.size <= maxPages) {
					break;
				}
				this.deletePage(key, old);
			}
		} else {
			// Keep recently used pages; the oldest is dropped first.
			this.pages.delete(style);
			this.pages.set(style, page);
		}
		if (page.full) {
			if (this.batchPage === page) {
				this.batched = [];
			}
			page.tiles.clear();
			page.highlightIds.clear();
			page.cellIds.clear();
			page.generation++;
			page.full = false;
		}
		return page;
	}

	/**
	 * The slot of a tile, rasterizing it on first use. The painter fills `width` device pixels;
	 * `source` is where the tile's cell starts in them. Returns undefined when the page is full; the
	 * caller then paints its row without the atlas.
	 */
	slot(
		page: Page,
		key: string,
		paint: TilePainter,
		width: number,
		source: number
	): number | undefined {
		const cached = page.tiles.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const slot = page.tiles.size + 1;
		if (slot >= page.capacity) {
			page.full = true;
			return undefined;
		}
		// Windows are painted side by side in one row, unclipped and at the top as in a row
		// image: clipping or moving them down changes antialiasing at their edges. They upload
		// together, so Canvas2D flushes once per batch.
		const batch = this.batch;
		const across = Math.max(1, Math.floor(maxBatchWidth / width));
		if (this.batched.length && (this.batchPage !== page || this.batched.length >= across)) {
			this.upload();
		}
		if (batch.width < across * width || batch.height !== page.height) {
			batch.width = across * width;
			batch.height = page.height;
		}
		const left = this.batched.length * width;
		const context = tileContext(batch);
		context.save();
		context.translate(left, 0);
		paint(context);
		context.restore();
		this.batchPage = page;
		this.batched.push({ slot, left: left + source });
		page.tiles.set(key, slot);
		this.rasterizations++;
		return slot;
	}

	/** Start drawing a frame of the given size in device pixels. */
	begin(width: number, height: number): void {
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		this.count = 0;
	}

	/** Queue one cell; `above` is the slot and line drawn just above it, packed by the caller. */
	push(left: number, top: number, slot: number, above: number): void {
		if ((this.count + 1) * instanceFloats > this.instances.length) {
			const grown = new Float32Array(this.instances.length * 2);
			grown.set(this.instances);
			this.instances = grown;
		}
		const offset = this.count * instanceFloats;
		this.instances[offset] = left;
		this.instances[offset + 1] = top;
		this.instances[offset + 2] = slot;
		this.instances[offset + 3] = above;
		this.count++;
	}

	/**
	 * Upload new tiles and draw the queued cells between device-pixel lines `top` and `bottom`.
	 * Returns false when nothing was drawn.
	 */
	finish(page: Page, background: string, top: number, bottom: number): boolean {
		const gl = this.gl!;
		const program = this.program!;
		if (!this.count || gl.isContextLost()) {
			return false;
		}
		this.upload();
		gl.bindTexture(gl.TEXTURE_2D, page.texture);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.disable(gl.DITHER);
		gl.disable(gl.BLEND);
		gl.useProgram(program.program);
		gl.uniform2f(program.viewport, this.canvas.width, this.canvas.height);
		gl.uniform3i(program.tile, page.pitch, page.height, page.across);
		const value = Number.parseInt(background.slice(1, 7), 16);
		gl.uniform3f(
			program.background,
			(value >> 16) / 255,
			((value >> 8) & 255) / 255,
			(value & 255) / 255
		);
		// A cursor or a changed line repaints only its band, so leave the rest of the frame alone.
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(0, this.canvas.height - bottom, this.canvas.width, bottom - top);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			this.instances.subarray(0, this.count * instanceFloats),
			gl.STREAM_DRAW
		);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
		gl.disable(gl.SCISSOR_TEST);
		return true;
	}

	/** Copy the painted tiles into their page's texture. */
	private upload(): void {
		const page = this.batchPage;
		const gl = this.gl!;
		if (!page || !this.batched.length || gl.isContextLost()) {
			this.batched = [];
			return;
		}
		gl.bindTexture(gl.TEXTURE_2D, page.texture);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.batch.width);
		for (const { slot, left } of this.batched) {
			gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, left);
			gl.texSubImage2D(
				gl.TEXTURE_2D,
				0,
				(slot % page.across) * page.pitch,
				Math.floor(slot / page.across) * page.height,
				page.pitch,
				page.height,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				this.batch
			);
		}
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
		this.batched = [];
	}

	private createPage(
		gl: WebGL2RenderingContext,
		pitch: number,
		height: number
	): Page | undefined {
		const size = Math.min(pageSize, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
		const across = Math.floor(size / pitch);
		const down = Math.floor(size / height);
		if (across < 1 || down < 1) {
			return undefined;
		}
		const texture = gl.createTexture();
		if (!texture) {
			return undefined;
		}
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		// Chromium copies canvases GPU to GPU only into plain RGBA textures; the shader decodes sRGB.
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, across * pitch, down * height);
		return {
			texture,
			tiles: new Map(),
			highlightIds: new Map(),
			cellIds: new Map(),
			pitch,
			height,
			across,
			// Slot 0 means "no tile".
			// Slots are packed with a line number into one float in the instance data.
			capacity: Math.min(across * down, 65536),
			generation: 0,
			full: false
		};
	}

	private deletePage(style: string, page: Page): void {
		if (this.batchPage === page) {
			this.batched = [];
		}
		this.gl?.deleteTexture(page.texture);
		this.pages.delete(style);
	}

	/** Compile the shaders and create the instance buffer; undefined when that fails. */
	private createProgram(gl: WebGL2RenderingContext): Program | undefined {
		const program = gl.createProgram();
		const buffer = gl.createBuffer();
		const vertexArray = gl.createVertexArray();
		if (!program || !buffer || !vertexArray) {
			return undefined;
		}
		for (const [type, code] of [
			[gl.VERTEX_SHADER, vertex],
			[gl.FRAGMENT_SHADER, fragment]
		] as const) {
			const shader = gl.createShader(type);
			if (!shader) {
				gl.deleteProgram(program);
				return undefined;
			}
			gl.shaderSource(shader, code);
			gl.compileShader(shader);
			gl.attachShader(program, shader);
			gl.deleteShader(shader);
		}
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			gl.deleteProgram(program);
			return undefined;
		}
		gl.useProgram(program);
		gl.uniform1i(gl.getUniformLocation(program, 'atlas'), 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindVertexArray(vertexArray);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, instanceFloats, gl.FLOAT, false, 0, 0);
		gl.vertexAttribDivisor(0, 1);
		this.buffer = buffer;
		return {
			program,
			viewport: gl.getUniformLocation(program, 'viewport'),
			tile: gl.getUniformLocation(program, 'tile'),
			background: gl.getUniformLocation(program, 'backgroundColor')
		};
	}
}
