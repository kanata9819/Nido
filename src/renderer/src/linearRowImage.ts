interface Texture {
  image: WebGLTexture;
  pixels: number;
}

interface Program {
  image: WebGLProgram;
  viewport: WebGLUniformLocation | null;
  row: WebGLUniformLocation | null;
  phase: WebGLUniformLocation | null;
}

const vertex = `#version 300 es
uniform vec2 viewport;
uniform vec3 row;
void main() {
    vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
    // Leave fractional row boundaries to the native alpha compositor.
    vec2 pixel = vec2(corner.x * row.y, row.x + 1.0 + corner.y * (row.z - 1.0));
    gl_Position = vec4(pixel / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 viewport;
uniform vec3 row;
uniform float phase;
out vec4 color;
void main() {
    ivec2 pixel = ivec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y - row.x);
    // sRGB textures decode before interpolation, preserving actual light.
    vec3 current = texelFetch(source, pixel, 0).rgb;
    vec3 previous = texelFetch(source, pixel - ivec2(0, 1), 0).rgb;
    vec3 light = mix(current, previous, phase);
    vec3 encoded = mix(12.92 * light, 1.055 * pow(light, vec3(1.0 / 2.4)) - 0.055,
                       step(vec3(0.0031308), light));
    color = vec4(encoded, 1.0);
}`;

/** Correct fractional opaque rows on the GPU, without CPU pixel transfers. */
export class LinearRowImages {
  private static readonly documents = new WeakMap<Document, LinearRowImages>();

  static forDocument(document: Document): LinearRowImages {
    let rows = this.documents.get(document);
    if (!rows) {
      rows = new LinearRowImages(document);
      this.documents.set(document, rows);
    }
    return rows;
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly textures = new Map<HTMLCanvasElement, Texture>();
  private program?: Program;
  private cachedPixels = 0;
  private maxPixels = 0;
  private painted = false;
  private unavailable = false;
  private pending: { source: HTMLCanvasElement; top: number }[] = [];

  private constructor(document: Document) {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Software WebGL is slower than native Canvas2D scrolling.
      failIfMajorPerformanceCaveat: true
    });
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.textures.clear();
      this.cachedPixels = 0;
      this.program = undefined;
    });
  }

  begin(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || this.unavailable) {
      return false;
    }
    this.program ??= this.createProgram(gl);
    if (!this.program) {
      this.unavailable = true;
      return false;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.maxPixels = width * height * 2;
    this.painted = false;
    this.pending = [];
    return true;
  }

  invalidate(source: HTMLCanvasElement): void {
    const texture = this.textures.get(source);
    if (texture) {
      this.gl!.deleteTexture(texture.image);
      this.textures.delete(source);
      this.cachedPixels -= texture.pixels;
    }
  }

  private prepare(source: HTMLCanvasElement): WebGLTexture | undefined {
    const gl = this.gl!;
    let texture = this.textures.get(source);
    if (!texture) {
      const image = gl.createTexture();
      if (!image) {
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      texture = { image, pixels: source.width * source.height };
      this.cachedPixels += texture.pixels;
    }
    // Refresh insertion order for a bounded LRU cache.
    this.textures.delete(source);
    this.textures.set(source, texture);
    return texture.image;
  }

  paint(source: HTMLCanvasElement, top: number): void {
    this.pending.push({ source, top });
  }

  private paintRow(source: HTMLCanvasElement, top: number): void {
    const origin = Math.floor(top);
    const phase = top - origin;
    if (phase < 0.000001 || phase > 0.999999) {
      return;
    }
    const texture = this.prepare(source);
    if (!texture) {
      return;
    }
    const gl = this.gl!;
    if (!this.painted) {
      // Native-position rows already use Canvas2D. Upload only rows that
      // actually need fractional correction, including after gutter edits.
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.DITHER);
      gl.useProgram(this.program!.image);
      gl.uniform2f(this.program!.viewport, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform3f(this.program!.row, origin, source.width, source.height);
    gl.uniform1f(this.program!.phase, phase);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.painted = true;
  }

  finish(context: CanvasRenderingContext2D, dpr: number, contentHeight: number): void {
    // Keep Canvas2D and WebGL work together instead of switching contexts per row.
    for (const { source, top } of this.pending) {
      this.paintRow(source, top);
    }
    if (this.painted) {
      context.save();
      context.beginPath();
      context.rect(0, 0, this.canvas.width / dpr, contentHeight);
      context.clip();
      // One GPU composite for the viewport, at integral physical coordinates.
      context.drawImage(this.canvas, 0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
      context.restore();
    }
    // Retain two viewports, including during partial cursor repaints.
    // Scrolling through a large file must not accumulate GPU textures.
    for (const [source, texture] of this.textures) {
      if (this.cachedPixels <= this.maxPixels) {
        break;
      }
      this.gl!.deleteTexture(texture.image);
      this.textures.delete(source);
      this.cachedPixels -= texture.pixels;
    }
  }

  private createProgram(gl: WebGL2RenderingContext): Program | undefined {
    const program = gl.createProgram();
    if (!program) {
      return;
    }
    for (const [type, code] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment]
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) {
        gl.deleteProgram(program);
        return;
      }
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }
    return {
      image: program,
      viewport: gl.getUniformLocation(program, 'viewport'),
      row: gl.getUniformLocation(program, 'row'),
      phase: gl.getUniformLocation(program, 'phase')
    };
  }
}
