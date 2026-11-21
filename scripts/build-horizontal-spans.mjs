import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const grid = new URL('../src/renderer/src/grid/', import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'nido-horizontal-spans-'));
const wasm = join(directory, 'horizontal-spans.wasm');
try {
	const result = spawnSync(
		'rustc',
		[
			'--target=wasm32-unknown-unknown',
			'--crate-type=cdylib',
			'--edition=2024',
			'-Copt-level=3',
			'-Cpanic=abort',
			'-Cstrip=symbols',
			'-Ctarget-feature=+simd128',
			'-Clink-arg=-zstack-size=32768',
			'-Clink-arg=--export=__heap_base',
			fileURLToPath(new URL('horizontalSpans.rs', grid)),
			'-o',
			wasm
		],
		{ stdio: 'inherit' }
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`rustc failed with status ${result.status}`);
	writeFileSync(
		new URL('horizontalSpansWasm.ts', grid),
		`// Generated from horizontalSpans.rs by node scripts/build-horizontal-spans.mjs.\nexport default '${readFileSync(wasm).toString('base64')}';\n`
	);
} finally {
	rmSync(wasm, { force: true });
	rmdirSync(directory);
}
