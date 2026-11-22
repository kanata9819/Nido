import { _electron } from '@playwright/test';
import { createServer } from 'vite';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(process.argv[2] ?? 'test-results/text-rendering/glyph-atlas');
await mkdir(output, { recursive: true });
const binary = resolve(output, 'glyph-instances.wasm');
const build = spawnSync(
	'rustc',
	[
		'--target=wasm32-unknown-unknown',
		'--crate-type=cdylib',
		'--edition=2024',
		'-Copt-level=3',
		'-Cpanic=abort',
		'-Cstrip=symbols',
		'-Clink-arg=--export=__heap_base',
		'-Clink-arg=-zstack-size=32768',
		resolve(root, 'glyphInstances.rs'),
		'-o',
		binary
	],
	{ stdio: 'inherit', windowsHide: true }
);
if (build.error) throw build.error;
if (build.status !== 0)
	throw new Error('Glyph kernel build failed. Install the wasm32-unknown-unknown Rust target.');
const wasm = await readFile(binary);

const server = await createServer({
	configFile: false,
	root,
	server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } },
	plugins: [
		{
			name: 'glyph-atlas-replay',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url === '/') {
						response.setHeader('Content-Type', 'text/html; charset=utf-8');
						response.end(
							'<!doctype html><meta charset="utf-8"><body data-glyph-replay></body>'
						);
					} else if (request.url === '/glyph-instances.wasm') {
						response.setHeader('Content-Type', 'application/wasm');
						response.end(wasm);
					} else next();
				});
			}
		}
	]
});
await server.listen();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
	const running = await _electron.launch({
		args: [
			resolve(root, 'main.cjs'),
			`--comparison-url=${server.resolvedUrls.local[0]}`,
			'--comparison-hidden',
			'--force-device-scale-factor=1.25'
		],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.waitForSelector('body[data-glyph-replay]', { state: 'attached' });
		console.log('Comparing pixels and replaying scroll in Electron…');
		const report = await page.evaluate(async () => {
			const { runGlyphAtlasReplay } = await import('/glyphAtlasReplay.ts');
			return runGlyphAtlasReplay();
		});
		if (report.dpr !== 1.25) throw new Error(`Unexpected device scale ${report.dpr}`);
		const runtime = await running.evaluate(({ app }) => ({
			electron: process.versions.electron,
			chromium: process.versions.chrome,
			gpu: app.getGPUFeatureStatus()
		}));
		const path = resolve(output, 'measurements.json');
		await writeFile(path, JSON.stringify({ runtime, ...report }, null, 2));
		console.log(path);
		if (
			report.pixels.some(
				({ phase, maxChannelDelta }) => maxChannelDelta > (phase === 0 ? 0 : 1)
			)
		) {
			throw new Error(
				'Glyph atlas exceeded the pixel difference tolerance. See measurements.json.'
			);
		}
	} finally {
		await running.close();
	}
} finally {
	await server.close();
}
