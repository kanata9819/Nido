import type { Browser, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type {} from '../renderer/harness';

/** Long enough for a cold dependency optimization and transform on a CI runner. */
export const harnessWarmupTimeout = 120_000;

/**
 * page.goto can resolve before the harness module has defined window.rendererTest, so a test
 * that calls it right after navigating failed now and then with "Cannot read properties of
 * undefined". Every Page shares one prototype; once a harness server starts, navigating to the
 * harness itself (path "/", e.g. "?view=app") waits until window.rendererTest is defined.
 * Other navigations, such as the probe pages tests route to, behave exactly as before.
 */
const harnessPage = (url: string): boolean => {
	try {
		return new URL(url).pathname === '/';
	} catch {
		return false;
	}
};
/**
 * Renderer tests now and then fail because a page never got a module from the Vite server:
 * the harness never loads, or `import()` of a source file fails with "Failed to fetch
 * dynamically imported module". Neither the browser nor Vite says why, so print what each
 * side saw. Aborted requests are left out: closing a page aborts its requests.
 */
const instrumentedPages = new WeakSet<Page>();
/**
 * Windows CI runners now and then fail requests with net::ERR_NO_BUFFER_SPACE (WSAENOBUFS), the
 * error for running out of socket resources. Count the machine's TCP connections by state and
 * by process the first time it happens, while those sockets still exist, to show what holds them.
 */
const socketReport = String.raw`
$connections = Get-NetTCPConnection
'[harness] TCP connections by state:'
$connections | Group-Object State | Sort-Object Count -Descending |
	ForEach-Object { "[harness]   $($_.Name): $($_.Count)" }
'[harness] TCP connections by process (largest five):'
$connections | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 5 |
	ForEach-Object {
		$process = Get-Process -Id $_.Name -ErrorAction SilentlyContinue
		"[harness]   $($process.ProcessName) ($($_.Name)): $($_.Count)"
	}
netsh int ipv4 show dynamicport tcp | ForEach-Object { "[harness] $_" }
`;
let socketsReported = false;
function reportSockets(): void {
	if (socketsReported || process.platform !== 'win32') {
		return;
	}
	socketsReported = true;
	execFile(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-Command', socketReport],
		{ windowsHide: true, timeout: 30_000 },
		(error, stdout, stderr) =>
			console.log(
				error ? `[harness] socket report failed: ${stderr || error}` : stdout.trimEnd()
			)
	);
}
function reportLoadFailures(page: Page): void {
	if (instrumentedPages.has(page)) {
		return;
	}
	instrumentedPages.add(page);
	page.on('requestfailed', (request) => {
		const reason = request.failure()?.errorText ?? 'unknown';
		if (!reason.includes('ERR_ABORTED')) {
			console.log(`[harness] request failed: ${request.url()} (${reason})`);
		}
		if (reason.includes('ERR_NO_BUFFER_SPACE')) {
			reportSockets();
		}
	});
	page.on('response', (response) => {
		if (response.status() >= 400) {
			console.log(`[harness] ${response.status()} for ${response.url()}`);
		}
	});
	page.on('pageerror', (error) => console.log(`[harness] page error: ${error.message}`));
}
const reportServerErrors: Plugin = {
	name: 'report-harness-server-errors',
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			response.on('finish', () => {
				if (response.statusCode >= 400) {
					console.log(
						`[harness] Vite answered ${response.statusCode} for ${request.url}`
					);
				}
			});
			next();
		});
	}
};

const patchedPrototypes = new WeakSet<object>();
function waitForHarnessAfterNavigation(page: Page): void {
	const prototype = Object.getPrototypeOf(page) as Page;
	if (patchedPrototypes.has(prototype)) {
		return;
	}
	patchedPrototypes.add(prototype);
	const { goto, reload } = prototype;
	prototype.goto = async function (this: Page, ...args: Parameters<Page['goto']>) {
		reportLoadFailures(this);
		const response = await goto.apply(this, args);
		if (harnessPage(args[0])) {
			await this.waitForFunction(() => window.rendererTest !== undefined);
		}
		return response;
	};
	prototype.reload = async function (this: Page, ...args: Parameters<Page['reload']>) {
		const response = await reload.apply(this, args);
		if (harnessPage(this.url())) {
			await this.waitForFunction(() => window.rendererTest !== undefined);
		}
		return response;
	};
}

/**
 * Start the Vite server for the renderer test harness (`tests/renderer`) and warm it.
 *
 * Its dependency cache is kept apart from other Vite configurations, so starting one does
 * not re-optimize the other's dependencies. A cold CI runner then optimizes and transforms
 * the whole app once, here, rather than inside the first tests' timeouts.
 */
export async function startHarnessServer(
	browser: Browser
): Promise<{ server: ViteDevServer; origin: string }> {
	const server = await createServer({
		configFile: false,
		root: resolve('tests/renderer'),
		cacheDir: resolve('node_modules/.vite-harness'),
		plugins: [react(), reportServerErrors],
		server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd()] } }
	});
	try {
		await server.listen();
		const origin = server.resolvedUrls!.local[0];
		const page = await browser.newPage();
		waitForHarnessAfterNavigation(page);
		try {
			await page.goto(`${origin}?view=app`, { timeout: harnessWarmupTimeout });
			await page.waitForFunction(() => window.rendererTest !== undefined, undefined, {
				timeout: harnessWarmupTimeout
			});
		} finally {
			await page.close();
		}
		return { server, origin };
	} catch (error) {
		await server.close();
		throw error;
	}
}
