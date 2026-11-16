import { test, expect, type Page } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import { attachEditorDiagnostics, recordEditorDiagnostics } from './helpers/editor-diagnostics';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorkspace } from './helpers/electron-shared';
import { launchEnv } from './helpers/launch-env';

test('Rust Run and Debug work from shortcuts and the command menu without CodeLens rows', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-runnable-ui-'));
	const workspace = join(root, 'workspace');
	const runMarker = join(workspace, 'main-ran');
	await mkdir(join(workspace, 'src'), { recursive: true });
	await writeFile(
		join(workspace, 'Cargo.toml'),
		'[package]\nname="nido_lens_ui"\nversion="0.1.0"\nedition="2021"\n'
	);
	await writeFile(
		join(workspace, 'src/main.rs'),
		'fn main() {\n    println!("keyboard-run"); std::fs::write("main-ran", "yes").unwrap();\n}\n#[test]\nfn keyboard_test() { println!("keyboard-test"); }\n' +
			Array.from({ length: 4 }, (_, index) => `#[test]\nfn extra_${index}() {}\n`).join('')
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await recordEditorDiagnostics(page);
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const input = page.getByRole('textbox', { name: 'Neovim input' });
		await expect(input).toBeFocused();
		await page.keyboard.type(':edit src/main.rs');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /fn main/);
		const readyFile = join(root, 'runnables-ready');
		const id = await page.evaluate(
			() =>
				(window as unknown as Window & { editorDiagnostics: { id: string } })
					.editorDiagnostics.id
		);
		await page.evaluate(({ id, keys }) => window.nido.input(id, keys), {
			id,
			keys: `<Cmd>lua local buffer = vim.api.nvim_get_current_buf(); local function ready()
local client = vim.lsp.get_clients({bufnr=buffer, name='rust_analyzer'})[1]
if not client or not client.initialized then vim.defer_fn(ready, 100); return end
client:request('experimental/runnables',
  {textDocument={uri=vim.uri_from_bufnr(buffer)}, position=vim.NIL}, function(err, items)
if not err and items and #vim.tbl_filter(function(item)
  return item.kind == 'cargo' and item.location and item.location.targetRange
end, items) >= 6 then
vim.fn.writefile({'ready'}, ${JSON.stringify(readyFile.replaceAll('\\', '/'))})
else vim.defer_fn(ready, 100) end
end, buffer)
end; ready()<CR>`.replaceAll('\n', ' ')
		});
		await expect
			.poll(() => readFile(readyFile, 'utf8').catch(() => ''), { timeout: 30000 })
			.toContain('ready');
		await expect(canvas).not.toHaveAttribute('aria-description', /Run \(gR\)|Run Tests/);
		await expect(canvas).toHaveAttribute('aria-description', /extra_3/);
		await canvas.evaluate((node: HTMLCanvasElement) => {
			const ctx = node.getContext('2d')!;
			const clear = ctx.fillRect.bind(ctx);
			ctx.fillRect = (x, y, width, height) => {
				if (x === 0 && y === 0 && height === node.clientHeight) {
					node.setAttribute('data-code-points', '[]');
				}
				clear(x, y, width, height);
			};
			const pointsByImage = new WeakMap<
				HTMLCanvasElement,
				{ value: string; x: number; y: number; font: number }[]
			>();
			const text = CanvasRenderingContext2D.prototype.fillText;
			CanvasRenderingContext2D.prototype.fillText = function (value, x, y, ...rest) {
				const points = pointsByImage.get(this.canvas) || [];
				points.push({ value, x, y, font: parseFloat(this.font) });
				pointsByImage.set(this.canvas, points);
				text.call(this, value, x, y, ...rest);
			};
			const draw = ctx.drawImage.bind(ctx);
			ctx.drawImage = ((...args: Parameters<typeof draw>) => {
				draw(...args);
				if ((args as unknown[]).length !== 5) return;
				for (const { value, x, y: localY, font } of pointsByImage.get(
					args[0] as HTMLCanvasElement
				) || []) {
					const y = localY + Number(args[2]);
					if (value === 'f' || value === 'p') {
						const points = JSON.parse(node.getAttribute('data-code-points') || '[]');
						points.push({ value, x, y, font });
						node.setAttribute('data-code-points', JSON.stringify(points));
					}
				}
			}) as typeof draw;
		});
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
		await expect
			.poll(async () => {
				const points = JSON.parse((await canvas.getAttribute('data-code-points')) || '[]');
				return points.filter((point: { value: string }) => point.value === 'f').length;
			})
			.toBeGreaterThanOrEqual(2);
		const points = JSON.parse((await canvas.getAttribute('data-code-points'))!) as {
			value: string;
			x: number;
			y: number;
			font: number;
		}[];
		const main = points.find((point) => point.value === 'f')!;
		const testFunction = points.find(
			(point) => point.value === 'f' && point.y > main.y && point.x === main.x
		)!;
		const body = points.find((point) => point.value === 'p')!;
		const lineHeight = await page.evaluate(() =>
			Number(localStorage.getItem('nido.lineHeight'))
		);
		expect(body.y - main.y).toBeCloseTo(lineHeight, 0);
		expect(testFunction.y - main.y).toBeCloseTo(4 * lineHeight, 0);
		await canvas.click({ position: { x: testFunction.x + 2, y: testFunction.y - 4 } });
		await expect(page.getByText('Ln 5, Col 1', { exact: true })).toBeVisible();
		await expect
			.poll(() => input.evaluate((node) => (node as HTMLElement).offsetTop))
			.toBeCloseTo(testFunction.y - (lineHeight + main.font) / 2 + 3, 0);
		await expect(input).toBeFocused();
		await page.keyboard.type('gg');
		await expect(page.getByText('Ln 1, Col 1', { exact: true })).toBeVisible();
		await page.keyboard.type('gR');
		const output = page.getByLabel('Debug output');
		await expect(output).toContainText('keyboard-run', { timeout: 15000 });
		await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
			'Run · finished'
		);
		await expect(input).toBeFocused();
		await page.keyboard.type('5GgR');
		await expect(output).toContainText('keyboard-test', { timeout: 15000 });
		await expect(output).toContainText('Process exited: 0');
		await rm(runMarker, { force: true });
		await page.keyboard.type('gggD');
		await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
			'Debug · finished',
			{ timeout: 15000 }
		);
		await expect.poll(() => readFile(runMarker, 'utf8').catch(() => '')).toBe('yes');
		await expect(input).toBeFocused();
		for (const action of ['Run', 'Debug']) {
			await rm(runMarker, { force: true });
			await page.keyboard.press('Control+Shift+p');
			await page
				.getByRole('textbox', { name: 'Filter items' })
				.fill(`${action} Rust at cursor`);
			await page.keyboard.press('Enter');
			await expect(page.getByRole('region', { name: 'Debugger', exact: true })).toContainText(
				`${action} · finished`,
				{ timeout: 15000 }
			);
			await expect.poll(() => readFile(runMarker, 'utf8').catch(() => '')).toBe('yes');
			await expect(input).toBeFocused();
		}
		await expect(canvas).not.toHaveAttribute('aria-description', /Run \(gR\)|Run Tests/);
		await page.screenshot({ path: 'test-results/rust-runnables-without-codelens.png' });
	} catch (error) {
		await attachEditorDiagnostics(await running.firstWindow(), test.info());
		throw error;
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

for (const animations of [true, false]) {
	test(`navigation notices use native cards without stealing editor focus (animations ${animations})`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-native-notice-'));
		const workspace = join(root, 'workspace');
		await mkdir(workspace);
		await writeFile(join(workspace, 'notes.txt'), 'hello\n');
		const env = launchEnv();
		delete env.ELECTRON_RUN_AS_NODE;
		const running = await electron.launch({
			args: ['.', `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		try {
			const page = await running.firstWindow();
			await page.evaluate(
				(enabled) => localStorage.setItem('nido.animations', String(enabled)),
				animations
			);
			await page.reload();
			await expect(
				page.getByRole('heading', { name: 'Make yourself at home.' })
			).toBeVisible();
			await page.keyboard.press('Control+Shift+n');
			await chooseWorkspace(page, workspace);
			const input = page.getByRole('textbox', { name: 'Neovim input' });
			await expect(input).toBeFocused();
			await page.keyboard.type(':edit notes.txt');
			await page.keyboard.press('Enter');
			await expect(page.locator('canvas:visible')).toHaveAttribute(
				'aria-description',
				/hello/
			);
			await page.keyboard.type(':lua vim.notify("No locations found", vim.log.levels.INFO)');
			await page.keyboard.press('Enter');
			const notice = page.getByRole('status', { name: 'Code navigation' });
			await expect(notice).toContainText('No locations found');
			await expect(input).toBeFocused();
			await page.screenshot({ path: 'test-results/native-notification.png' });
			await page.keyboard.press('Escape');
			await expect(notice).toHaveCount(0);
			await page.keyboard.type(':lua vim.notify("No locations found", vim.log.levels.INFO)');
			await page.keyboard.press('Enter');
			await expect(notice).toBeVisible();
			await expect(notice).toHaveCSS('opacity', '1');
			await expect(notice).toHaveCSS('transition-duration', animations ? '0.3s' : '0s');
			const displayedAt = Date.now();
			if (animations) {
				await expect
					.poll(
						async () =>
							Number(
								await notice.evaluate(
									(element) => getComputedStyle(element).opacity
								)
							),
						{
							intervals: [50],
							timeout: 2500
						}
					)
					.toBeLessThan(1);
				expect(Date.now() - displayedAt).toBeGreaterThan(1700);
			}
			await expect(notice).toHaveCount(0, { timeout: 3000 });
			expect(Date.now() - displayedAt).toBeGreaterThan(1700);
			await expect(input).toBeFocused();
			await page.clock.install({ time: new Date(0) });
			await page.clock.pauseAt(new Date(1000));
			const showError = async (): Promise<void> => {
				await running.evaluate(({ BrowserWindow }) => {
					BrowserWindow.getAllWindows()[0].webContents.send('nido:event', {
						type: 'error',
						id: 'test',
						message:
							"Error: Error invoking remote method 'nido:editorConfig': Error: Workspace is no longer running."
					});
				});
			};
			const error = page
				.getByRole('alert')
				.filter({ hasText: 'Workspace is no longer running.' });
			await showError();
			await expect(error).toHaveText('Workspace is no longer running.');
			await expect(input).toBeFocused();
			await expect(error).toHaveCSS('transition-duration', animations ? '0.3s' : '0s');
			// The same error again restarts its eight seconds.
			await page.clock.runFor(7000);
			await showError();
			await page.clock.runFor(7500);
			await expect(error).toHaveCSS('opacity', '1');
			await page.clock.runFor(500);
			if (animations) {
				await expect(error).toHaveAttribute('data-fading', 'true');
				await page.clock.runFor(300);
			}
			await expect(error).toHaveCount(0);
			await expect(input).toBeFocused();
			await showError();
			await expect(error).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(error).toHaveCount(0);
			await showError();
			await page.getByRole('button', { name: 'Dismiss error' }).click();
			await expect(error).toHaveCount(0);
			await expect(input).toBeFocused();
		} finally {
			await running.evaluate(({ app }) => app.exit(0));
			await running.close();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
}

test('Ctrl star and hash searches show readable matches, counts and controls', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-word-search-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'words.txt'), 'alpha beta alpha\nalpha\n');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const input = page.getByRole('textbox', { name: 'Neovim input' });
		await expect(input).toBeFocused();
		await page.keyboard.type(':edit words.txt');
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/alpha beta alpha/
		);
		await page.keyboard.press('Escape');
		await page.keyboard.type('gg0');
		await page.keyboard.press('Control+Shift+*');
		const search = page.getByRole('status', { name: 'Search matches' });
		await expect(search).toContainText('alpha');
		await expect(search).toContainText('2 / 3');
		await page.keyboard.press('Control+Shift+#');
		await expect(search).toContainText('1 / 3');
		await search.getByRole('button', { name: 'Next search match', exact: true }).click();
		await expect(search).toContainText('3 / 3');
		await expect(input).toBeFocused();
		await page.screenshot({ path: 'test-results/word-search.png' });
		await page.keyboard.press('Escape');
		await expect(search).toHaveCount(0);
		await page.keyboard.type('/beta');
		await page.keyboard.press('Enter');
		await expect(search).toContainText('beta');
		await expect(search).toContainText('1 / 1');
		await search.getByRole('button', { name: 'Clear search highlights', exact: true }).click();
		await expect(search).toHaveCount(0);
		expect(await readFile(join(workspace, 'words.txt'), 'utf8')).toBe(
			'alpha beta alpha\nalpha\n'
		);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('completion opens on typing and Ctrl Space, accepts with Tab, and files show diagnostic counts', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-completion-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'tsconfig.json'), '{}');
	await writeFile(
		join(workspace, 'main.ts'),
		'const amount = 1;\nconst getOldUser = 1;\nconst getUserName = 1;\nconst getUser = 1;\n'
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.setViewportSize({ width: 1100, height: 720 });
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const input = page.getByRole('textbox', { name: 'Neovim input' });
		await expect(input).toBeFocused();
		await page.evaluate(() => {
			const stop = window.nido.onEvent((event) => {
				if (event.type !== 'redraw') return;
				document.documentElement.dataset.completionSession = event.id;
				stop();
			});
		});
		await page.keyboard.type(':edit main.ts');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /const amount/);
		await page.keyboard.type(
			":lua assert(vim.wait(20000, function() local c = vim.lsp.get_clients({bufnr=0})[1]; return c and c.initialized end, 50)); print('COMPLETION_READY')"
		);
		await page.keyboard.press('Enter');
		await expect(
			page.getByRole('dialog', { name: 'Neovim messages', exact: true })
		).toContainText('COMPLETION_READY', {
			timeout: 25000
		});
		await page.keyboard.type(
			":lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=0,col=0,severity=1,message='Error 1'}, {lnum=0,col=0,severity=1,message='Error 2'}, {lnum=0,col=0,severity=2,message='Warning 1'}, {lnum=0,col=0,severity=2,message='Warning 2'}, {lnum=0,col=0,severity=2,message='Warning 3'}})"
		);
		await page.keyboard.press('Enter');
		const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		const tree = page.getByRole('tree', { name: 'Project files' });
		for (const host of [tabs, tree]) {
			await expect(host.getByLabel('2 errors', { exact: true })).toBeVisible();
			await expect(host.getByLabel('3 warnings', { exact: true })).toBeVisible();
		}
		await page.evaluate(() => {
			const state = window as unknown as Window & { completionLatency: Promise<number> };
			state.completionLatency = new Promise((resolve) => {
				let start = 0;
				const onKey = (event: KeyboardEvent): void => {
					if (event.key === 'm') start = performance.now();
				};
				document.addEventListener('keydown', onKey);
				const observer = new MutationObserver(() => {
					if (!start || !document.querySelector('[aria-label="Code completion"]')) return;
					observer.disconnect();
					document.removeEventListener('keydown', onKey);
					resolve(performance.now() - start);
				});
				observer.observe(document.body, { childList: true, subtree: true });
			});
		});
		await page.keyboard.type('Goam');
		const menu = page.getByRole('listbox', { name: 'Code completion' });
		await expect(menu).toBeVisible({ timeout: 15000 });
		const completionMs = await page.evaluate(
			() =>
				(window as unknown as Window & { completionLatency: Promise<number> })
					.completionLatency
		);
		console.log(`Automatic completion: ${completionMs.toFixed(1)} ms`);
		await expect(menu.getByRole('option').first()).toContainText('amount');
		const sessionId = await page.evaluate(
			() => document.documentElement.dataset.completionSession!
		);
		await expect(canvas).toHaveAttribute('aria-description', /\bam[ \t]+(?:ERROR[^\n]*)?\n/);
		const inputTop = await input.evaluate((node) => (node as HTMLElement).offsetTop);
		const menuTop = await menu.evaluate((node) => node.parentElement!.offsetTop);
		await page.evaluate(({ id, keys }) => window.nido.input(id, keys), {
			id: sessionId,
			keys: "<Cmd>lua vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace('completion-lens-test'), 1, 0, {virt_lines={{{'Run Tests', 'NidoCodeLens'}}}, virt_lines_above=true})<CR>"
		});
		await expect(canvas).toHaveAttribute('aria-description', /Run Tests/);
		await expect
			.poll(() => input.evaluate((node) => (node as HTMLElement).offsetTop))
			.toBeGreaterThan(inputTop);
		const lensHeight =
			(await input.evaluate((node) => (node as HTMLElement).offsetTop)) - inputTop;
		await expect
			.poll(() => menu.evaluate((node) => node.parentElement!.offsetTop))
			.toBe(menuTop + lensHeight);
		await page.evaluate(({ id, keys }) => window.nido.input(id, keys), {
			id: sessionId,
			keys: "<Cmd>lua vim.api.nvim_buf_clear_namespace(0, vim.api.nvim_create_namespace('completion-lens-test'), 0, -1)<CR>"
		});
		await expect
			.poll(() => menu.evaluate((node) => node.parentElement!.offsetTop))
			.toBe(menuTop);
		await expect(menu.getByRole('option').first().getByRole('img')).toHaveAttribute(
			'aria-label',
			/Variable|Constant/
		);
		await expect(
			menu.getByRole('option').first().getByRole('img').locator('svg')
		).toBeVisible();
		await menu.evaluate((element) => element.setAttribute('data-test-continuity', 'kept'));
		await page.keyboard.type('oun', { delay: 180 });
		await expect(menu).toHaveAttribute('data-test-continuity', 'kept');
		await page.keyboard.press('Backspace');
		await expect(canvas).toHaveAttribute('aria-description', /amou[ \t]+(?:ERROR[^\n]*)?\n/);
		await expect(menu).toHaveAttribute('aria-busy', 'false');
		await expect(menu).toHaveAttribute('data-test-continuity', 'kept');
		await page.keyboard.press('Tab');
		await expect(menu).toHaveCount(0);
		await expect(canvas).toHaveAttribute('aria-description', /amount/);
		await page.keyboard.type('.to');
		await expect(menu.getByRole('option').filter({ hasText: 'toFixed' })).toBeVisible();
		await expect(
			menu.getByRole('option').filter({ hasText: 'toFixed' }).getByRole('img')
		).toHaveAttribute('aria-label', 'Method');
		await expect(menu.getByText('Method', { exact: true })).toHaveCount(0);
		await expect(menu).toHaveAttribute('aria-busy', 'false');
		const methodCandidates = await menu.getByRole('option').allTextContents();
		expect(methodCandidates.length).toBeGreaterThan(1);
		const popupBounds = await menu.boundingBox();
		await page.keyboard.type('F');
		await expect(canvas).toHaveAttribute(
			'aria-description',
			/amount\.toF[ \t]+(?:ERROR[^\n]*)?\n/
		);
		await expect(menu.getByRole('option')).toHaveText([/^toFixed/]);
		expect(await menu.boundingBox()).toEqual(popupBounds);
		await page.keyboard.press('Backspace');
		// A broader prefix must restore the same candidates, regardless of server version.
		await expect(menu.getByRole('option')).toHaveText(methodCandidates);
		expect(await menu.boundingBox()).toEqual(popupBounds);
		await page.keyboard.press('Control+e');
		await expect(menu).toHaveCount(0);
		await page.keyboard.press('Control+Space');
		await expect(menu).toBeVisible();
		const index = (await menu.getByRole('option').allTextContents()).findIndex((text) =>
			text.includes('toFixed')
		);
		expect(index).toBeGreaterThanOrEqual(0);
		for (let step = 0; step <= index; step++) {
			await page.keyboard.press('ArrowDown');
			await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
		}
		await expect(menu.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Control+n');
		await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
		await page.keyboard.press('Control+p');
		await expect(menu.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
		await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
		await menu.getByRole('option').nth(index).click();
		await expect(menu).toBeVisible();
		await expect(canvas).not.toHaveAttribute('aria-description', /amount.toFixed/);
		await expect(input).toBeFocused();
		await page.screenshot({ path: 'test-results/nido-completion.png' });
		await expect(menu).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('Tab');
		await expect(menu).toHaveCount(0);
		await expect(canvas).toHaveAttribute('aria-description', /amount.toFixed/);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(workspace, 'main.ts')))
			.toContain('amount.toFixed');
		await page.keyboard.type(':');
		await expect(page.getByText('COMMAND', { exact: true })).toBeVisible();
		await page.keyboard.type('edit note.txt');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'note.txt', exact: true })).toBeVisible();
		await page.keyboard.press('i');
		await page.keyboard.press('Tab');
		await page.keyboard.type('plain');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(workspace, 'note.txt')))
			.toMatch(/^ {2}plain\r?\n$/);
		await page.keyboard.type(':');
		await expect(page.getByText('COMMAND', { exact: true })).toBeVisible();
		await page.keyboard.type('edit main.ts');
		await page.keyboard.press('Enter');
		await expect(canvas).toHaveAttribute('aria-description', /getOldUser/);
		await page.keyboard.press('Escape');
		await page.keyboard.type('GogetU');
		await expect(menu).toBeVisible();
		await expect(
			menu.getByRole('option').first().getByText('getUser', { exact: true })
		).toBeVisible();
		await expect(canvas).toHaveAttribute('aria-description', /getU[ \t]+(?:ERROR[^\n]*)?\n/);
		await expect(menu).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(workspace, 'main.ts')))
			.toMatch(/\ngetUser\r?\n$/);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Markdown preview renders unsaved edits and supports keyboard scrolling and dismissal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-markdown-preview-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	const source =
		'# Preview\n\n**Bold** and *italic*.\n\n| Name | Value |\n| --- | --- |\n| Nido | 42 |\n\n```ts\nconst value = 42;\n```\n\n- [x] Done\n\n[Unsafe](javascript:alert(1))\n<script>window.previewUnsafe = true</script>\n\n' +
		Array.from({ length: 50 }, (_, index) => `Paragraph ${index + 1}.\n\n`).join('');
	await writeFile(join(workspace, 'preview.md'), source);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('preview.md');
		await expect(page.getByRole('button', { name: /preview.md/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /Preview/);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type('Go## Unsaved heading');
		await page.keyboard.press('Escape');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/Unsaved heading/
		);
		await page.keyboard.press('Control+Shift+v');
		const popup = page.getByRole('region', { name: 'Markdown preview', exact: true });
		const content = page.getByLabel('Markdown preview content', { exact: true });
		await expect(popup).toBeVisible();
		await expect(content).toBeFocused();
		await expect(content.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
		await expect(content.locator('strong')).toHaveText('Bold');
		await expect(content.getByRole('table')).toContainText('42');
		await expect(content.locator('pre')).toContainText('const value = 42');
		await expect(content.getByRole('heading', { name: 'Unsaved heading' })).toHaveCount(1);
		await expect(content.locator('script')).toHaveCount(0);
		await expect(content.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
		expect(await page.evaluate(() => 'previewUnsafe' in window)).toBe(false);
		expect(await readFile(join(workspace, 'preview.md'), 'utf8')).toBe(source);
		await page.keyboard.press('Control+j');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await expect(popup).toBeVisible();
		await page.keyboard.type('Go## Live heading');
		await page.keyboard.press('Escape');
		await expect(content.getByRole('heading', { name: 'Live heading' })).toHaveCount(1);
		expect(await readFile(join(workspace, 'preview.md'), 'utf8')).toBe(source);
		await content.focus();
		await page.keyboard.press('Control+d');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
		await page.keyboard.press('Control+u');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
		await popup.screenshot({ path: 'test-results/nido-markdown-preview.png' });
		await page.keyboard.press('Control+Shift+v');
		await expect(popup).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+Shift+v');
		await expect(popup).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(popup).toBeHidden();
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('diagnostic jumps show native cards with severity, keyboard navigation and dismissal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-diagnostic-card-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	const source = 'fn main() {\n    let byte = 42u8;\n    let text = String::from(byte);\n}\n';
	await writeFile(join(workspace, 'main.rs'), source);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
		await expect(editor).toBeFocused();
		// Keep this UI regression independent of the installed Rust toolchain and server timing.
		await page.keyboard.type(":lua vim.lsp.enable('rust_analyzer', false)");
		await page.keyboard.press('Enter');
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/String::from/
		);
		await page.keyboard.type(
			":lua vim.diagnostic.set(vim.api.nvim_create_namespace('native-card-test'), 0, {{lnum=1,col=8,severity=2,source='rustc',code='unused_variables',message='Unused variable `byte`'}, {lnum=2,col=15,severity=1,source='rustc',code='E0277',message='The trait bound `String: From<u8>` is not satisfied' .. string.char(10) .. '`String` implements `From<&str>`.' .. string.char(10) .. 'Consider converting the byte to a character first.'}, {lnum=2,col=23,severity=2,source='rustc',code='unused_parens',message='Unnecessary parentheses around function argument' .. string.char(10) .. '`#[warn(unused_parens)]` is enabled by default.'}})"
		);
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/trait bound/
		);
		await page.keyboard.type('gg0]d');
		const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
		const content = page.getByLabel('Diagnostic content', { exact: true });
		// A jump from the editor focuses the card so its scroll keys work.
		await expect(content).toBeFocused();
		await expect(popup).toContainText('unused_variables');
		await page.keyboard.press('Escape');
		await expect(popup).toHaveCount(0);
		await expect(editor).toBeFocused();
		// ]d also works inside the card.
		await page.keyboard.type(']d');
		await expect(content).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await page.keyboard.type('gl');
		await expect(content).toBeFocused();
		await expect(popup).toContainText('2 on this line');
		await expect(popup).toContainText('Ln 3, Col 16');
		await expect(content.locator('article[data-severity="error"]')).toContainText('E0277');
		await expect(content.locator('article[data-severity="warning"]')).toContainText(
			'unused_parens'
		);
		await expect(content.locator('h3 code').first()).toHaveText('String: From<u8>');
		await expect
			.poll(() =>
				popup.evaluate((node) => {
					const host = node.parentElement!;
					const anchor = host.querySelector<HTMLTextAreaElement>(
						'[data-editor-input="editor"]'
					)!;
					const expectedLeft = Math.max(
						12,
						Math.min(
							anchor.offsetLeft,
							host.clientWidth - (node as HTMLElement).offsetWidth - 12
						)
					);
					return Math.abs((node as HTMLElement).offsetLeft - expectedLeft);
				})
			)
			.toBeLessThan(1);
		await page.screenshot({ path: 'test-results/nido-diagnostic-card.png' });
		await popup.screenshot({ path: 'test-results/nido-diagnostic-details.png' });
		await page.keyboard.type('2]d');
		await expect(popup).toContainText('unused_variables');
		await page.keyboard.type('[d');
		await expect(popup).toContainText('E0277');
		await page.keyboard.press('Escape');
		await expect(popup).toHaveCount(0);
		await expect(editor).toBeFocused();
		await page.keyboard.type('gl');
		await expect(popup).toContainText('E0277');
		await page.keyboard.press('Control+k');
		await expect(popup).toHaveCount(0);
		await expect(
			page.getByRole('dialog', { name: 'Type information', exact: true })
		).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await page.keyboard.type('gl');
		await expect(popup).toBeVisible();
		await page.keyboard.press('Tab');
		await expect(
			popup.getByRole('button', { name: 'Previous diagnostic', exact: true })
		).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(
			popup.getByRole('button', { name: 'Next diagnostic', exact: true })
		).toBeFocused();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Enter');
		await expect(popup).toHaveCount(0);
		await expect(editor).toBeFocused();
		await page.keyboard.type(
			":lua assert(#vim.api.nvim_list_wins() == 1); vim.diagnostic.reset(vim.api.nvim_create_namespace('native-card-test')); vim.notify('Diagnostic windows verified')"
		);
		await page.keyboard.press('Enter');
		await expect(page.getByText('Diagnostic windows verified', { exact: true })).toBeVisible();
		await page.keyboard.type('gl');
		await expect(page.getByText('No diagnostics on this line.', { exact: true })).toBeVisible();
		await expect(popup).toHaveCount(0);
		expect(await readFile(join(workspace, 'main.rs'), 'utf8')).toBe(source);
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('type information is a selectable Nido card with keyboard scrolling and dismissal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-hover-card-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'tsconfig.json'), '{}');
	await writeFile(
		join(workspace, 'sample.ts'),
		[
			'/**',
			' * カーソル位置を更新します。',
			' *',
			' * Returns the **screen position** from `row` and `column`.',
			' *',
			' * ## Usage',
			' *',
			' * - **row**: vertical position',
			' * - *column*: horizontal position',
			' *',
			' * > Positions start at zero.',
			' *',
			' * | Field | Type |',
			' * | --- | --- |',
			' * | row | number |',
			' *',
			' * [Documentation](https://example.com/docs)',
			' * [Unsafe](javascript:alert(1))',
			' * ![Remote illustration](https://example.com/image.png)',
			' * <script>window.hoverUnsafe = true</script>',
			...Array.from(
				{ length: 25 },
				(_, index) => ` *\n * Detail ${index + 1}: coordinates are measured in cells.`
			),
			' */',
			'export function setCursor(row: number, column: number, coordinateSpaceOptionsForViewportAndDocumentPositionCalculation?: { coordinateSpace: "viewport" | "document" }): number {',
			'  return row * 80 + column;',
			'}',
			'setCursor(1, 2);',
			''
		].join('\n')
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
		await expect(editor).toBeFocused();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.ts');
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/カーソル位置/
		);
		await page.keyboard.type('G0');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/setCursor/
		);
		const popup = page.getByRole('dialog', { name: 'Type information', exact: true });
		await expect(async () => {
			await editor.focus();
			await page.keyboard.press('Control+k');
			await expect(popup.locator('pre')).toContainText('setCursor', { timeout: 1000 });
		}).toPass({ timeout: 15000 });
		const content = page.getByLabel('Type information content', { exact: true });
		await expect(content).toBeFocused();
		await expect(content).toContainText('カーソル位置を更新します');
		await expect(content.getByRole('heading', { name: 'Usage' })).toBeVisible();
		await expect(content.locator('ul li')).toHaveCount(2);
		await expect(content.locator('blockquote')).toContainText('Positions start at zero');
		await expect(content.getByRole('table')).toContainText('number');
		await expect(content.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
			'href',
			'https://example.com/docs'
		);
		await expect(content.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
		await expect(content.locator('img, script')).toHaveCount(0);
		await running.evaluate(({ shell, app }) => {
			shell.openExternal = async (url) => {
				app.setName(url);
			};
		});
		await content.getByRole('link', { name: 'Documentation' }).focus();
		await page.keyboard.press('Enter');
		await expect
			.poll(() => running.evaluate(({ app }) => app.getName()))
			.toBe('https://example.com/docs');
		expect(
			await page.evaluate(() =>
				window.nido.openDocumentation('file:///C:/Windows').then(
					() => false,
					() => true
				)
			)
		).toBe(true);
		await content.focus();
		await page.keyboard.press('Home');
		await expect(
			popup.locator('pre code span span').filter({ hasText: /^function$/ })
		).toHaveCSS('color', 'rgb(86, 156, 214)');
		await expect
			.poll(
				async () =>
					await popup
						.locator('pre code span span')
						.evaluateAll(
							(spans) =>
								new Set(spans.map((span) => getComputedStyle(span).color)).size
						)
			)
			.toBeGreaterThan(1);
		expect(await page.evaluate(() => 'hoverUnsafe' in window)).toBe(false);
		const signature = popup.locator('pre').first();
		expect(await signature.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
		await page.keyboard.press('l');
		await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
		await page.keyboard.press('h');
		await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBe(0);
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
		await page.keyboard.press('ArrowLeft');
		await expect.poll(() => signature.evaluate((node) => node.scrollLeft)).toBe(0);
		await page.keyboard.press('j');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
		await page.keyboard.press('k');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
		await page.keyboard.press('Home');
		await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
		for (const [down, up, fraction] of [
			['d', 'u', 0.5],
			['f', 'b', 1]
		] as const) {
			const height = await content.evaluate((node) => node.clientHeight);
			await page.keyboard.press(`Control+${down}`);
			await expect
				.poll(() => content.evaluate((node) => node.scrollTop))
				.toBeCloseTo(height * fraction, 0);
			await page.keyboard.press(`Control+${up}`);
			await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
		}
		await popup.screenshot({ path: 'test-results/nido-type-information.png' });
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Close type information' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(content.getByRole('link', { name: 'Documentation' })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByRole('button', { name: 'Close type information' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(popup).toBeHidden();
		await expect(editor).toBeFocused();
		await page.keyboard.press('K');
		await expect(popup.locator('pre')).toContainText('setCursor');
		await page.keyboard.press('Control+c');
		await expect(popup).toBeHidden();
		await expect(editor).toBeFocused();
		await page.keyboard.press('Control+k');
		await expect(popup.locator('pre')).toContainText('setCursor');
		await page.getByRole('button', { name: 'Close type information' }).click();
		await expect(popup).toBeHidden();
		await expect(editor).toBeFocused();
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Problems can be selected, filtered, opened and cleared with the keyboard', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-problems-'));
	await writeFile(
		join(root, 'sample.txt'),
		'first line\nsecond line\nthird line\nfourth line\nfifth line\n'
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + join(root, 'profile')],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('treeitem', { name: 'sample.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('sample.txt');
		await expect(page.getByRole('button', { name: /sample.txt/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type(
			":lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=2,col=1,severity=2,message='Sample warning'}, {lnum=4,col=2,severity=1,message='Sample error'}})"
		);
		await page.keyboard.press('Enter');
		await page.keyboard.press('Control+Shift+m');
		const problems = page.getByRole('listbox', { name: 'Problems', exact: true });
		await expect(problems).toBeFocused();
		await expect(problems.getByRole('option')).toHaveCount(2);
		await expect(problems.getByRole('option').first()).toContainText('Sample error');
		await page.keyboard.press('j');
		await expect(problems.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		await expect(page.getByText('Ln 3, Col 2', { exact: true })).toBeVisible();
		await page.keyboard.press('Control+Shift+m');
		await page.keyboard.press('/');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('Sample error');
		await expect(problems.getByRole('option')).toHaveCount(1);
		await page.keyboard.press('Enter');
		await expect(page.getByText('Ln 5, Col 3', { exact: true })).toBeVisible();
		await page.keyboard.type(
			":lua vim.diagnostic.reset(vim.api.nvim_create_namespace('nido-test'))"
		);
		await page.keyboard.press('Enter');
		await page.keyboard.press('Control+Shift+m');
		await expect(page.getByText('No problems reported.')).toBeVisible();
		await page.keyboard.press('Control+Shift+m');
		await expect(problems).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('references stay accessible after jumping and can be closed with the keyboard', async () => {
	test.setTimeout(120000);
	const testInfo = test.info();
	const root = await mkdtemp(join(tmpdir(), 'nido-references-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	let diagnosticPage: Page | undefined;
	try {
		await mkdir(join(root, 'src'));
		await writeFile(
			join(root, 'Cargo.toml'),
			'[package]\nname="nido_references"\nversion="0.1.0"\nedition="2021"\n'
		);
		await writeFile(
			join(root, 'src/main.rs'),
			'fn greet() -> u32 { 42 }\nfn main() {\n    let answer = greet();\n    println!("{answer}");\n}\n'
		);
		const executablePath = process.env.NIDO_PACKAGED_EXE;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const page = await running.firstWindow();
		diagnosticPage = page;
		await recordEditorDiagnostics(page);
		await page.evaluate(() => {
			Object.assign(window, { referenceState: { id: '', version: 0 } });
			window.nido.onEvent((event) => {
				if (event.type === 'state') {
					Object.assign(window, {
						referenceState: {
							id: event.id,
							version: event.state.references?.version || 0
						}
					});
				}
			});
		});
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
		await expect(page.getByRole('button', { name: /main.rs/ })).toBeVisible();
		await page.keyboard.press('Enter');
		// A cold rust-analyzer can still be scanning the standard library after 30 seconds.
		await expect(async () => {
			const before = await page.evaluate(
				() =>
					(window as unknown as Window & { referenceState: { version: number } })
						.referenceState.version
			);
			// Ctrl+K requests hover when the editor is already focused.
			await page.keyboard.press('Control+l');
			await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
			await page.keyboard.type('gg0wgr', { delay: 20 });
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.nido.inputMode(
							(window as unknown as Window & { referenceState: { id: string } })
								.referenceState.id
						)
					)
				)
				.toBe('n');
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as unknown as Window & { referenceState: { version: number } })
								.referenceState.version
					)
				)
				.toBeGreaterThan(before);
			const version = await page.evaluate(
				() =>
					(window as unknown as Window & { referenceState: { version: number } })
						.referenceState.version
			);
			const results = page.getByRole('listbox', { name: 'Reference results' });
			await expect(results).toHaveAttribute('data-reference-version', String(version));
			await expect(results).toHaveAttribute('aria-busy', 'false');
			await expect(
				page.getByRole('listbox', { name: 'Reference results' }).getByRole('option')
			).toHaveCount(2, {
				timeout: 1000
			});
			await expect(
				page.getByRole('region', { name: 'Reference preview', exact: true })
			).toHaveAttribute('aria-busy', 'false');
			await expect(
				page.getByRole('region', { name: 'Reference preview', exact: true })
			).toContainText('fn main()');
		}).toPass({ timeout: 90000 });
		const list = page.getByRole('listbox', { name: 'Reference results' });
		await expect(list).toBeFocused();
		const preview = page.getByRole('region', { name: 'Reference preview', exact: true });
		await expect(preview).toContainText('fn main()');
		await expect(preview.locator('[data-current="true"]')).toContainText('fn greet()');
		await page.keyboard.press('j');
		await expect(preview.locator('[data-current="true"]')).toContainText('let answer');
		await expect(
			page
				.getByRole('listbox', { name: 'Reference results' })
				.getByRole('option', { selected: true })
		).toContainText('let answer');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await expect(preview).toBeHidden();
		await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
		await page.keyboard.press('Control+j');
		await expect(list).toBeFocused();
		await expect(preview).toContainText('println!');
		await expect(
			page
				.getByRole('listbox', { name: 'Reference results' })
				.getByRole('option', { selected: true })
		).toContainText('let answer');
		await page.screenshot({ path: 'test-results/nido-references.png' });
		await page.keyboard.press('k');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+j');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
		await page.keyboard.press('Control+j');
		await expect(list).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press('d');
		await expect(page.getByRole('region', { name: 'References' })).toBeHidden();
		await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
		await expect(page.getByRole('tab', { name: '[Untitled]', exact: true })).toHaveCount(0);
		await page.keyboard.press('Shift+F12');
		await expect(page.getByRole('region', { name: 'References' })).toBeVisible();
	} catch (error) {
		if (diagnosticPage) await attachEditorDiagnostics(diagnosticPage, testInfo);
		throw error;
	} finally {
		await running?.evaluate(({ app }) => app.exit(0));
		await running?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('Rust debugger keyboard controls stop, inspect and step in the packaged app', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-debug-ui-'));
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	try {
		await mkdir(join(root, 'src'));
		await mkdir(join(root, 'src/bin'));
		await writeFile(join(root, 'src/bin/other.rs'), 'fn main() {}');
		await writeFile(
			join(root, 'Cargo.toml'),
			'[package]\nname="nido_debug_ui"\nversion="0.1.0"\nedition="2021"\n'
		);
		await writeFile(
			join(root, 'src/main.rs'),
			'fn main() {\n    let mut number = 21; let mut pair = [number; 20];\n    let answer = number * 2;\n    println!("answer={answer}");\n    number += 1;\n    pair[0] = number;\n    println!("{pair:?} {number}");\n}\n'
		);
		const executablePath = process.env.NIDO_PACKAGED_EXE;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		await running.evaluate(({ dialog }) => {
			dialog.showOpenDialog = async () => {
				throw new Error('Native folder picker must not be used');
			};
		});
		const page = await running.firstWindow();
		await page.evaluate(() => {
			window.nido.onEvent((event) => {
				if (event.type === 'state' && event.state.debug?.status === 'paused') {
					document.documentElement.dataset.debugPausedLocation =
						event.state.debug.location || '';
				}
			});
		});
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
			'aria-busy',
			'false'
		);
		await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
		await page.keyboard.press('Control+l');
		await expect(page.getByRole('textbox', { name: 'Folder path' })).toBeFocused();
		await page.keyboard.type('relative-path');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('alert')).toContainText('absolute folder path');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root, true);
		await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
		await expect(page.getByRole('button', { name: /main.rs.*src/ })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
		await page.keyboard.type('3G');
		await page.keyboard.press('F9');
		await expect(page.getByRole('region', { name: 'Debugger' })).toBeVisible();
		await page.keyboard.press('F5');
		await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
			'Choose an executable:',
			{ timeout: 90000 }
		);
		await page.keyboard.press('Control+j');
		await expect(page.locator('[data-debug-target]:focus')).toHaveCount(1);
		for (
			let i = 0;
			i < 10 &&
			!(await page
				.getByRole('button', { name: 'nido_debug_ui', exact: true })
				.evaluate((element) => element === document.activeElement));
			i++
		)
			await page.keyboard.press('l');
		await expect(
			page.getByRole('button', { name: 'nido_debug_ui', exact: true })
		).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
			'Debug · paused',
			{
				timeout: 30000
			}
		);
		await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeVisible();
		await page.keyboard.press('Control+k');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+h');
		await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
		await page.keyboard.press('Control+l');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press('d');
		await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toBeVisible();
		await page.keyboard.press('F10');
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.debugPausedLocation))
			.toMatch(/main\.rs:4$/);
		await expect(page.getByRole('region', { name: 'Debugger' })).toHaveCount(0);
		await page.keyboard.press('Control+j');
		await expect(page.getByRole('treeitem', { name: /^answer = 42/ })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: /^number = 21/ })).toBeFocused();
		await page.keyboard.press('j');
		const pair = page.getByRole('treeitem', { name: /^pair = / });
		await expect(pair).toBeFocused();
		await page.keyboard.press('l');
		await expect(pair).toHaveAttribute('aria-expanded', 'true');
		const childVariables = page.locator('[data-debug-variable][aria-level="2"]');
		await expect(childVariables).toHaveCount(20);
		await page.keyboard.press('l');
		await expect(childVariables.first()).toBeFocused();
		await page.keyboard.press('Control+d');
		const jumpedId = await page
			.locator('[data-debug-variable]:focus')
			.getAttribute('data-debug-variable');
		expect(jumpedId).not.toBe(await childVariables.first().getAttribute('data-debug-variable'));
		await page.keyboard.press('Control+k');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(page.locator(`[data-debug-variable="${jumpedId}"]`)).toBeFocused();
		await page.keyboard.press('Control+u');
		await expect(childVariables.first()).toBeFocused();
		await page.keyboard.press('Tab');
		const output = page.getByLabel('Debug output');
		await expect(output).toBeFocused();
		await page.keyboard.press('Home');
		const beforeScroll = await output.evaluate((element) => element.scrollTop);
		await page.keyboard.press('Control+d');
		await expect
			.poll(() => output.evaluate((element) => element.scrollTop))
			.toBeGreaterThan(beforeScroll);
		await page.keyboard.press('Control+u');
		await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
		await page.keyboard.press('Control+j');
		await expect(childVariables.first()).toBeFocused();
		await page.keyboard.press('h');
		await expect(pair).toBeFocused();
		await page.keyboard.press('h');
		await expect(pair).toHaveAttribute('aria-expanded', 'false');
		await expect(childVariables).toHaveCount(0);
		await page.keyboard.press('Enter');
		await expect(pair).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('F10');
		await expect(page.getByRole('region', { name: 'Debugger' })).toContainText('main.rs:5');
		await page.keyboard.press('F10');
		await expect(page.getByRole('treeitem', { name: /^number = 22.*changed/ })).toHaveAttribute(
			'data-changed',
			'true'
		);
		await page.keyboard.press('F10');
		await expect(
			page.locator('[data-debug-variable][aria-level="2"][data-changed]')
		).toHaveCount(1);
		await expect(pair).toHaveAttribute('aria-expanded', 'true');
		const variablesBox = await page.getByLabel('Debug variables').boundingBox();
		const consoleBox = await page.getByLabel('Debug output').boundingBox();
		expect(consoleBox!.y).toBeGreaterThan(variablesBox!.y + variablesBox!.height);
		await page.screenshot({ path: 'test-results/nido-debugger.png' });
		await page.keyboard.press('Shift+F5');
		await expect(page.getByRole('region', { name: 'Debugger' })).toContainText(
			'Debug · finished'
		);
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true });
	}
});
