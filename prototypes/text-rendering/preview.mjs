import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import electron from 'electron';

const root = fileURLToPath(new URL('.', import.meta.url));
const server = await createServer({
    configFile: false,
    root,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } }
});
await server.listen();
const url = server.resolvedUrls.local[0];
process.stdout.write(`Text comparison: ${url}\n`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [resolve(root, 'main.cjs'), `--comparison-url=${url}`], {
    env,
    stdio: 'inherit',
    windowsHide: true
});
child.on('error', async (error) => {
    process.stderr.write(`${error.message}\n`);
    await server.close();
    process.exitCode = 1;
});
child.on('exit', async (code) => {
    await server.close();
    process.exitCode = code ?? 1;
});
process.on('SIGINT', () => child.kill());
