interface GridKernel {
	memory: WebAssembly.Memory;
	__heap_base: WebAssembly.Global;
	horizontal_spans(
		buffer: number,
		columns: number,
		left: number,
		right: number,
		shift: number,
		margin: number
	): number;
	grid_line_changes(buffer: number, stride: number, columns: number): number;
}

interface GridWasm {
	kernel: GridKernel;
	base: number;
	scratch: Uint32Array;
}

let wasm: GridWasm | undefined;
let loading: Promise<boolean> | undefined;

export function loadGridWasm(): Promise<boolean> {
	return (loading ??= import('./horizontalSpansWasm')
		.then(async ({ default: bytes }) => {
			const binary = Uint8Array.from(atob(bytes), (byte) => byte.charCodeAt(0));
			const { instance } = await WebAssembly.instantiate(binary);
			const kernel = instance.exports as unknown as GridKernel;
			const base = Number(kernel.__heap_base.value);
			wasm = { kernel, base, scratch: new Uint32Array(kernel.memory.buffer, base) };
			return true;
		})
		.catch(() => false));
}

/** Shared by synchronous kernels. Consume the output before invoking another kernel. */
export function gridWasmBuffer(words: number): GridWasm | undefined {
	if (wasm && words > wasm.scratch.length) {
		const { kernel, base, scratch } = wasm;
		kernel.memory.grow(
			Math.ceil(((words - scratch.length) * Uint32Array.BYTES_PER_ELEMENT) / 65536)
		);
		wasm.scratch = new Uint32Array(kernel.memory.buffer, base);
	}
	return wasm;
}
