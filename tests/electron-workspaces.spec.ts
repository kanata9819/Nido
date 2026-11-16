import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import { recordEditorDiagnostics } from './helpers/editor-diagnostics';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseWorkspace } from './helpers/electron-shared';
import { launchEnv } from './helpers/launch-env';

test('Ctrl+S preserves inline diagnostics, file tabs and Git badges throughout saving', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-save-display-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	await mkdir(join(root, 'src'));
	await writeFile(join(root, '.gitignore'), '/target/\n/profile/\n');
	await writeFile(
		join(root, 'Cargo.toml'),
		'[package]\nname="save_display"\nversion="0.1.0"\nedition="2021"\n'
	);
	await writeFile(join(root, 'src/main.rs'), 'fn main() {}\n');
	const git = (...args: string[]): void => {
		execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
	};
	git('init');
	git('add', '.');
	git(
		'-c',
		'user.name=Nido test',
		'-c',
		'user.email=test@example.invalid',
		'commit',
		'-m',
		'fixture'
	);
	await writeFile(join(root, 'src/main.rs'), 'fn main() { let unused = 42; }\n');
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.evaluate(() => localStorage.setItem('nido.formatOnSave', 'true'));
		await page.reload();
		await recordEditorDiagnostics(page);
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		const id = await page.evaluate(
			() =>
				(window as unknown as Window & { editorDiagnostics: { id: string } })
					.editorDiagnostics.id
		);
		await page.evaluate(async (id) => {
			await window.nido.openFile(id, 'Cargo.toml');
			await window.nido.openFile(id, 'src/main.rs');
		}, id);
		const canvas = page.locator('canvas[aria-label="Neovim editor display"]');
		await expect(canvas).toHaveAttribute('aria-description', /WARN.*unused variable/, {
			timeout: 30000
		});
		const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		await expect(tabs.locator('[data-status="M"]').filter({ hasText: /^M$/ })).toHaveCount(1);
		const selectedTitle = await tabs.getByRole('tab', { selected: true }).getAttribute('title');
		expect(selectedTitle).toContain('main.rs');
		await page.screenshot({ path: 'test-results/save-display-before.png' });
		await page.evaluate(() => {
			const samples: {
				tabs: string[];
				selected: string | null;
				badges: number;
				diagnosticPixels: number;
				diagnosticTextPixels: number;
			}[] = [];
			const observe = (): void => {
				const list = document.querySelector('[role="tablist"][aria-label="Files"]')!;
				const surface = document.querySelector<HTMLCanvasElement>(
					'canvas[aria-label="Neovim editor display"]'
				)!;
				const pixels = surface
					.getContext('2d')!
					.getImageData(0, 0, surface.width, Math.min(surface.height, 200)).data;
				let diagnosticPixels = 0;
				let diagnosticTextPixels = 0;
				for (let i = 0; i < pixels.length; i += 4) {
					if (pixels[i] === 37 && pixels[i + 1] === 34 && pixels[i + 2] === 26)
						diagnosticPixels++;
					if (pixels[i] === 203 && pixels[i + 1] === 195 && pixels[i + 2] === 173)
						diagnosticTextPixels++;
				}
				samples.push({
					tabs: Array.from(
						list.querySelectorAll('[role="tab"]'),
						(tab) => tab.getAttribute('title') || ''
					),
					selected:
						list.querySelector('[aria-selected="true"]')?.getAttribute('title') || null,
					badges: Array.from(list.querySelectorAll('[data-status="M"]')).filter(
						(node) => node.textContent === 'M'
					).length,
					diagnosticPixels,
					diagnosticTextPixels
				});
				if (samples.length < 240) requestAnimationFrame(observe);
			};
			(
				window as unknown as Window & { saveDisplaySamples?: typeof samples }
			).saveDisplaySamples = samples;
			requestAnimationFrame(observe);
		});
		for (let i = 0; i < 3; i++) {
			await page.keyboard.type('A ');
			if (i !== 1) await page.keyboard.press('Escape');
			await page.keyboard.press('Control+s');
			await page.waitForTimeout(500);
			if (i === 1) await page.keyboard.press('Escape');
		}
		await page.waitForTimeout(1500);
		const samples = await page.evaluate(
			() =>
				(
					window as unknown as Window & {
						saveDisplaySamples: {
							tabs: string[];
							selected: string | null;
							badges: number;
							diagnosticPixels: number;
							diagnosticTextPixels: number;
						}[];
					}
				).saveDisplaySamples
		);
		const info = test.info();
		await info.attach('save-display-frames', {
			body: JSON.stringify(samples),
			contentType: 'application/json'
		});
		expect(samples.length).toBeGreaterThan(30);
		expect(
			samples.filter(
				(sample) =>
					sample.tabs.length !== 2 ||
					sample.selected !== selectedTitle ||
					sample.badges !== 1 ||
					!sample.diagnosticPixels ||
					!sample.diagnosticTextPixels
			)
		).toEqual([]);
		await page.screenshot({ path: 'test-results/save-display-after.png' });
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('favorite workspaces support keyboard access, existing tabs, restart and missing folders', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-favorites-ui-'));
	const alpha = join(root, 'Alpha');
	const beta = join(root, 'Beta');
	await mkdir(alpha);
	await mkdir(beta);
	const profile = join(root, 'profile');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
	try {
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, alpha);
		const alphaStar = page.getByRole('button', {
			name: 'Favorite workspace Alpha',
			exact: true
		});
		await expect(alphaStar).toHaveAttribute('aria-pressed', 'false');
		await alphaStar.click();
		await expect(alphaStar).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, beta);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+Shift+p');
		await page
			.getByRole('textbox', { name: 'Filter items' })
			.fill('Add workspace to favorites');
		await page.keyboard.press('Enter');
		await expect(
			page.getByRole('button', { name: 'Favorite workspace Beta', exact: true })
		).toHaveAttribute('aria-pressed', 'true');

		await page.keyboard.press('Control+Shift+n');
		const choices = page.getByRole('listbox', { name: 'Folders' });
		await expect(choices).toBeFocused();
		await expect(choices.getByRole('option', { name: /^Favorite / })).toHaveCount(0);
		await page.keyboard.press('Control+f');
		await expect(choices.getByRole('option', { name: /^Favorite / })).toHaveCount(2);
		await page.keyboard.press('j');
		await expect(
			choices.getByRole('option', { name: 'Favorite Beta (editor)', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('k');
		await page.keyboard.press('Enter');
		await expect(
			page.getByRole('tab', { name: 'Workspace Alpha', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(2);

		await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(1);
		await page.keyboard.press('Control+Shift+n');
		await page.keyboard.press('Control+f');
		await expect(
			choices.getByRole('option', { name: 'Favorite Alpha (editor)', exact: true })
		).toBeVisible();
		await choices
			.getByRole('button', { name: 'Remove favorite Beta (editor)', exact: true })
			.click();
		await expect(
			choices.getByRole('option', { name: 'Favorite Beta (editor)', exact: true })
		).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: 'Favorite workspace Beta', exact: true })
		).toHaveAttribute('aria-pressed', 'false');
		await page.screenshot({ path: 'test-results/workspace-favorites.png' });
		await choices.getByRole('option', { name: 'Favorite Alpha (editor)', exact: true }).click();
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(2);
		await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
		await page.getByRole('button', { name: 'Close workspace Beta', exact: true }).click();
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
		const closed = running.waitForEvent('close');
		await page.evaluate(() => {
			void window.nido.windowAction('close');
		});
		await closed;
		running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
		page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
		await page.keyboard.press('Control+f');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Favorite workspace Alpha', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'Close workspace Alpha', exact: true }).click();
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
		await rm(alpha, { recursive: true, force: true });
		await page.keyboard.press('Control+Shift+n');
		await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
		await page.keyboard.press('Control+f');
		await page.keyboard.press('Enter');
		await expect(page.getByText(/ENOENT/)).toBeVisible();
		await expect(page.getByRole('tab', { name: /^Workspace / })).toHaveCount(0);
		await page
			.getByRole('button', { name: 'Remove favorite Alpha (editor)', exact: true })
			.click();
		await expect(page.getByRole('option', { name: /^Favorite / })).toHaveCount(0);
		await expect
			.poll(async () => JSON.parse(await readFile(join(profile, 'favorites.json'), 'utf8')))
			.toEqual([]);
		const rejected = await page.evaluate(async () => {
			try {
				await window.nido.setWorkspaceFavorite('relative', 'editor', true);
				return false;
			} catch {
				return true;
			}
		});
		expect(rejected).toBe(true);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('window commands minimize, maximize, restore and close from the keyboard with unsaved protection', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-window-keyboard-'));
	const path = join(root, 'notes.txt');
	await writeFile(path, 'original\n');
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({
		args: ['.', `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	let closed = false;
	try {
		const page = await running.firstWindow();
		const editor = page.getByRole('textbox', { name: 'Neovim input' });
		const guide = page.getByRole('dialog', { name: 'Keyboard commands' });
		const command = async (title: string): Promise<void> => {
			await page.keyboard.press('Control+Shift+p');
			// The palette opens on its list; i starts typing the filter.
			await page.keyboard.press('i');
			await expect(page.getByRole('textbox', { name: 'Filter items' })).toBeFocused();
			await page.keyboard.type(title);
			await page.keyboard.press('Enter');
		};
		const isMaximized = (): Promise<boolean> =>
			running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
		const minimizeAndReturn = async (): Promise<void> => {
			await expect
				.poll(() =>
					running.evaluate(({ BrowserWindow }) =>
						BrowserWindow.getAllWindows()[0].isMinimized()
					)
				)
				.toBe(true);
			// Returning to a minimized app is handled by Windows (for example, Alt+Tab).
			// Restore only the fixture window so the next keyboard action can reach it.
			await running.evaluate(({ BrowserWindow }) => {
				const window = BrowserWindow.getAllWindows()[0];
				window.restore();
				window.focus();
			});
			await page.bringToFront();
			await expect(page.getByRole('dialog', { name: 'commands palette' })).toHaveCount(0);
			await expect(guide).toHaveCount(0);
		};
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await command('Maximize or restore window');
		await expect.poll(isMaximized).toBe(true);
		await command('Maximize or restore window');
		await expect.poll(isMaximized).toBe(false);
		await command('Minimize window');
		await minimizeAndReturn();

		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(editor).toBeFocused();
		await page.keyboard.type(':edit notes.txt');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'notes.txt', exact: true })).toBeVisible();
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /original/);

		await page.keyboard.press('Space');
		for (const title of ['Minimize window', 'Maximize or restore window', 'Quit Nido']) {
			await expect(guide.getByRole('button', { name: title, exact: false })).toBeVisible();
		}
		await page.keyboard.press('+');
		await expect.poll(isMaximized).toBe(true);
		await expect(guide).toHaveCount(0);
		await expect(editor).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press('+');
		await expect.poll(isMaximized).toBe(false);
		await page.keyboard.press('Space');
		await page.keyboard.press('-');
		await minimizeAndReturn();
		await expect(editor).toBeFocused();

		await page.keyboard.type('gg0iunsaved ');
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /unsaved original/);
		await running.evaluate(({ dialog }) => {
			const probe = dialog as typeof dialog & { windowKeyboardPrompts: number };
			probe.windowKeyboardPrompts = 0;
			dialog.showMessageBox = async () => {
				probe.windowKeyboardPrompts++;
				return { response: 1, checkboxChecked: false };
			};
		});
		await page.keyboard.press('Space');
		await page.keyboard.press('q');
		await expect
			.poll(() =>
				running.evaluate(
					({ dialog }) =>
						(dialog as typeof dialog & { windowKeyboardPrompts: number })
							.windowKeyboardPrompts
				)
			)
			.toBe(1);
		await expect(editor).toBeFocused();
		await expect(guide).toHaveCount(0);
		await expect(canvas).toHaveAttribute('aria-description', /unsaved original/);
		assert.equal(await readSavedFile(path), 'original\n');

		await page.keyboard.type('A kept');
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /unsaved original kept/);
		await running.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
		});
		const didClose = running.waitForEvent('close');
		await command('Quit Nido');
		await didClose;
		closed = true;
		assert.equal(await readSavedFile(path), 'unsaved original kept\n');
	} finally {
		if (!closed) {
			await running.evaluate(({ app }) => app.exit(0));
		}
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('window size and maximized state survive restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-window-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const options = {
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`],
		env
	};
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	const waitForStartup = async (): Promise<void> => {
		const page = await running!.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
	};
	try {
		running = await electron.launch(options);
		await waitForStartup();
		await expect(
			(await running.firstWindow())
				.getByRole('button', { name: 'Maximize', exact: true })
				.locator('svg')
		).toHaveClass(/lucide-square/);
		await running.evaluate(({ BrowserWindow, screen }) => {
			const area = screen.getPrimaryDisplay().workAreaSize;
			BrowserWindow.getAllWindows()[0].setSize(
				Math.min(1000, area.width),
				Math.min(680, area.height)
			);
		});
		const originalSize = await running.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].getSize()
		);
		await running.close();
		running = await electron.launch(options);
		await waitForStartup();
		await expect
			.poll(() =>
				running!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
			)
			.toEqual(originalSize);
		await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
		await expect
			.poll(() =>
				running!.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].isMaximized()
				)
			)
			.toBe(true);
		await expect(
			(await running.firstWindow())
				.getByRole('button', { name: 'Restore window', exact: true })
				.locator('svg')
		).toHaveClass(/lucide-copy/);
		await running.close();
		running = await electron.launch(options);
		await waitForStartup();
		await expect
			.poll(() =>
				running!.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].isMaximized()
				)
			)
			.toBe(true);
		const page = await running.firstWindow();
		const restore = page.getByRole('button', { name: 'Restore window', exact: true });
		await expect(restore.locator('svg')).toHaveClass(/lucide-copy/);
		await restore.click();
		await expect
			.poll(() =>
				running!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
			)
			.toEqual(originalSize);
		const maximize = page.getByRole('button', { name: 'Maximize', exact: true });
		await expect(maximize.locator('svg')).toHaveClass(/lucide-square/);
		await maximize.click();
		await expect(restore.locator('svg')).toHaveClass(/lucide-copy/);
		await expect
			.poll(() =>
				running!.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].isMaximized()
				)
			)
			.toBe(true);
		await running.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].unmaximize()
		);
		await expect(maximize.locator('svg')).toHaveClass(/lucide-square/);
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('terminal toggle, focus, background execution and standalone terminal sessions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-terminal-ui-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const executablePath = process.env.NIDO_PACKAGED_EXE;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, root);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+@');
		const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
		await expect(terminal).toBeVisible();
		const explorerBounds = await page
			.getByRole('complementary', { name: 'File explorer' })
			.boundingBox();
		const terminalBounds = await terminal.boundingBox();
		assert.ok(explorerBounds && terminalBounds);
		assert.ok(terminalBounds.x >= explorerBounds.x + explorerBounds.width);
		assert.ok(
			explorerBounds.y + explorerBounds.height >= terminalBounds.y + terminalBounds.height - 1
		);
		await expect(page.getByRole('contentinfo').locator('[data-mode]')).toHaveText('NORMAL');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await expect(terminal.locator('canvas')).toHaveAttribute('aria-description', /PS .*?>/, {
			timeout: 15000
		});
		await page.keyboard.type(
			"$nidoValue = 'alive'; Start-Sleep -Milliseconds 500; Set-Content background.txt $nidoValue"
		);
		await page.keyboard.press('Enter');
		await page.keyboard.press('Control+@');
		await expect(terminal).toBeHidden();
		await expect
			.poll(async () => readFile(join(root, 'background.txt'), 'utf8').catch(() => ''))
			.toContain('alive');
		await page.keyboard.press('Control+j');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await page.keyboard.press('Control+k');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+j');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await page.keyboard.type('Set-Content preserved.txt $nidoValue');
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => readFile(join(root, 'preserved.txt'), 'utf8').catch(() => ''))
			.toContain('alive');
		await page.keyboard.press('Control+Shift+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('Open debug panel');
		await page.keyboard.press('Enter');
		const debuggerPanel = page.getByRole('region', { name: 'Debugger', exact: true });
		await expect(debuggerPanel).toBeVisible();
		await expect(debuggerPanel).toContainText('Debug · idle');
		await expect
			.poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
			.toBe(true);
		await expect(terminal).toBeHidden();
		await page.keyboard.press('Control+@');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await page.keyboard.press('Control+@');
		await expect(terminal).toBeHidden();
		await page.keyboard.press('Space');
		await expect(
			page
				.getByRole('dialog', { name: 'Keyboard commands' })
				.getByRole('button', { name: 'Shift+D Open debug panel' })
		).toBeVisible();
		await page
			.getByRole('dialog', { name: 'Keyboard commands' })
			.screenshot({ path: 'test-results/nido-keyboard-commands.png' });
		await page.keyboard.press('D');
		await expect(debuggerPanel).toBeVisible();
		await expect
			.poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
			.toBe(true);
		await page.keyboard.press('Control+@');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await expect(terminal.getByRole('button', { name: /Restart shell/ })).toHaveCSS(
			'font-size',
			'12px'
		);
		await page.keyboard.press('Control+Shift+r');
		await expect(terminal.locator('canvas')).not.toHaveAttribute(
			'aria-description',
			/preserved\.txt/
		);
		await expect(terminal.locator('canvas')).toHaveAttribute('aria-description', /PS .*?>/, {
			timeout: 15000
		});
		await page.keyboard.type('Set-Content restarted.txt ([string]::IsNullOrEmpty($nidoValue))');
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => readFile(join(root, 'restarted.txt'), 'utf8').catch(() => ''))
			.toContain('True')
			.catch(async (error) => {
				await page.screenshot({ path: 'test-results/restart-failure.png' });
				throw error;
			});
		await page.screenshot({ path: 'test-results/nido-terminal.png' });
		await page.keyboard.press('Control+Shift+p');
		await page.keyboard.type('New terminal session');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: 'folders palette' })).toContainText(
			'New terminal session'
		);
		await expect(page.getByRole('combobox', { name: 'Session type' })).toHaveCount(0);
		await expect(page.getByRole('listbox', { name: 'Folders' })).toHaveAttribute(
			'aria-busy',
			'false'
		);
		await expect(page.getByRole('listbox', { name: 'Folders' })).toBeFocused();
		await page.screenshot({ path: 'test-results/nido-session-keyboard.png' });
		await page.keyboard.press('Control+Enter');
		const input = page.getByRole('textbox', { name: 'Terminal input' });
		await expect(input).toHaveCount(1);
		await expect(input).toBeFocused();
		await expect(page.locator('canvas[aria-label="Terminal display"]:visible')).toHaveAttribute(
			'aria-description',
			/PS .*?>/,
			{ timeout: 15000 }
		);
		await page.keyboard.type("Set-Content standalone.txt 'separate'");
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => readFile(join(root, 'standalone.txt'), 'utf8').catch(() => ''))
			.toContain('separate');
		await page.keyboard.press('Control+Tab');
		await page.keyboard.press('Control+j');
		await expect(terminal.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		const closed = running.waitForEvent('close');
		await page.evaluate(() => {
			void window.nido.windowAction('close');
		});
		await closed;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const restored = await running.firstWindow();
		await expect(restored.getByRole('tab', { name: /^Workspace / })).toHaveCount(2, {
			timeout: 15000
		});
		await restored.keyboard.press('Alt+2');
		await expect(restored.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		await expect(
			restored.locator('canvas[aria-label="Terminal display"]:visible')
		).toHaveAttribute('aria-description', /PS .*?>/, { timeout: 15000 });
		await restored.keyboard.type("Set-Content restored.txt 'restored'");
		await restored.keyboard.press('Enter');
		await expect
			.poll(async () => readFile(join(root, 'restored.txt'), 'utf8').catch(() => ''))
			.toContain('restored');
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('normal shutdown restores workspace order, active file and cursors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-restart-'));
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	if (executablePath) {
		for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
		env.VIMINIT = 'lua error("Personal configuration must not run")';
	}
	// Exact RGB samples below require one CSS pixel to map to one physical pixel.
	const args = [
		...(executablePath ? [] : ['.']),
		'--force-device-scale-factor=1',
		`--user-data-dir=${join(root, 'profile')}`
	];
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		await mkdir(join(root, 'One'));
		await mkdir(join(root, 'Two'));
		await writeFile(join(root, 'One', 'a.txt'), 'first line\nsecond line\nthird line\n');
		await writeFile(join(root, 'One', 'b.txt'), 'another line\n');
		await writeFile(join(root, 'One', 'mixed.txt'), 'first\r\nsecond\n');
		await writeFile(
			join(root, 'One', 'highlight.rs'),
			'fn main() { let greeting = "hello"; }\n'
		);
		await writeFile(
			join(root, 'One', 'Cargo.toml'),
			'[package]\nname = "nido_highlight_fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "highlight.rs"\n'
		);
		running = await electron.launch({ executablePath, args, env });
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, join(root, 'One'));
		await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toBeVisible();
		await expect(page.getByRole('treeitem', { name: 'a.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('mixed.txt');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('Mixed');
		await expect(page.getByRole('alert')).toContainText('Mixed line endings detected');
		await page.getByRole('button', { name: 'Dismiss error' }).click();
		await page.getByRole('combobox', { name: 'Line endings' }).selectOption('LF');
		await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('LF');
		assert.equal(await readFile(join(root, 'One', 'mixed.txt'), 'utf8'), 'first\r\nsecond\n');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(root, 'One', 'mixed.txt')))
			.toBe('first\nsecond\n');
		await page.keyboard.press('Control+Shift+p');
		await page
			.getByRole('textbox', { name: 'Filter items' })
			.fill('Convert line endings to CRLF');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('combobox', { name: 'Line endings' })).toHaveValue('CRLF');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(root, 'One', 'mixed.txt')))
			.toBe('first\r\nsecond\r\n');
		await page.keyboard.press('Space');
		await page.keyboard.press('d');
		await expect(page.getByRole('tab', { name: 'mixed.txt', exact: true })).toHaveCount(0);
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('highlight.rs');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: /^highlight\.rs/ })).toBeVisible();
		await expect
			.poll(() =>
				page.locator('canvas:visible').evaluate((element) => {
					const canvas = element as HTMLCanvasElement;
					const pixels = canvas
						.getContext('2d')!
						.getImageData(0, 0, canvas.width, canvas.height).data;
					let keyword = false,
						string = false;
					for (let i = 0; i < pixels.length; i += 4) {
						if (pixels[i] === 86 && pixels[i + 1] === 156 && pixels[i + 2] === 214)
							keyword = true;
						if (pixels[i] === 206 && pixels[i + 1] === 145 && pixels[i + 2] === 120)
							string = true;
					}
					return keyword && string;
				})
			)
			.toBe(true);
		await page.screenshot({ path: 'test-results/nido-rust-highlights.png' });
		const cursorIsVisible = (): Promise<boolean> =>
			page.locator('canvas:visible').evaluate((element) => {
				const canvas = element as HTMLCanvasElement;
				const input = document.querySelector<HTMLTextAreaElement>(
					'textarea[aria-label="Neovim input"]'
				)!;
				const scale = window.devicePixelRatio || 1;
				const pixel = canvas
					.getContext('2d')!
					.getImageData(
						Math.floor((parseFloat(input.style.left) + 1) * scale),
						Math.floor((parseFloat(input.style.top) + 3) * scale),
						1,
						1
					).data;
				return pixel[0] > 80;
			});
		await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
		await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
		await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(true);
		await expect.poll(cursorIsVisible, { intervals: [50] }).toBe(false);
		await page.keyboard.press('ArrowLeft');
		await expect.poll(cursorIsVisible, { intervals: [20], timeout: 400 }).toBe(true);
		await expect
			.poll(() =>
				page.locator('canvas:visible').evaluate((element) => {
					const canvas = element as HTMLCanvasElement;
					const scale = window.devicePixelRatio || 1;
					const ctx = canvas.getContext('2d')!;
					const input = document.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="Neovim input"]'
					)!;
					const top = parseFloat(input.style.top);
					const lineHeight = Number(localStorage.getItem('nido.lineHeight'));
					const sample = (y: number): string =>
						Array.from(
							ctx.getImageData(canvas.width - 2, Math.floor((y + 0.5) * scale), 1, 1)
								.data
						)
							.slice(0, 3)
							.join(',');
					return [
						sample(top),
						sample(top + lineHeight - 1),
						sample(top + lineHeight / 2)
					];
				})
			)
			.toEqual(['70,81,92', '70,81,92', '18,18,18']);
		await expect(page.getByTitle('Rust language server connection')).toHaveText(
			'rust_analyzer'
		);
		await page.keyboard.type(
			":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='begin',title='Indexing',message='example_crate',percentage=42}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
		);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status')).toContainText('Indexing — example_crate (42%)');
		await page.screenshot({ path: 'test-results/nido-lsp-progress.png' });
		await page.keyboard.type(
			":lua vim.lsp.handlers['$/progress'](nil, {token='nido-ui-test',value={kind='end'}}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
		);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status').filter({ hasText: 'example_crate' })).toHaveCount(0);
		await page.keyboard.type(
			":lua vim.lsp.handlers['window/showMessage'](nil, {type=2,message='Failed to run build scripts of some packages.'}, {client_id=vim.lsp.get_clients({name='rust_analyzer'})[1].id})"
		);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('alert')).toContainText(
			'LSP[rust_analyzer][Warning] Failed to run build scripts'
		);
		await expect(page.locator('canvas:visible')).not.toHaveAttribute(
			'aria-description',
			/Press ENTER/
		);
		await page.screenshot({ path: 'test-results/nido-lsp-warning.png' });
		await page.keyboard.press('Escape');
		await expect(page.getByRole('alert', { name: 'Language server' })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type(
			":lua vim.lsp.util.open_floating_preview({'# Nido documentation', '', '**Markdown preview**'}, 'markdown', {})"
		);
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/Markdown preview/
		);
		await expect(page.locator('canvas:visible')).not.toHaveAttribute(
			'aria-description',
			/Parser could not be created|Error executing/
		);
		await page.screenshot({ path: 'test-results/nido-documentation.png' });
		await page.keyboard.press('j');
		await page.keyboard.type('gg0w');
		await expect(async () => {
			await page.keyboard.press('K');
			await expect(page.getByRole('dialog', { name: 'Type information' })).toBeVisible({
				timeout: 1000
			});
		}).toPass({ timeout: 20000 });
		await page.screenshot({ path: 'test-results/nido-hover.png' });
		await page.keyboard.press('Escape');
		for (const [file, keys] of [
			['a.txt', '3G4l'],
			['b.txt', 'gg6l']
		]) {
			await page.keyboard.press('Control+p');
			await page.getByRole('textbox', { name: 'Filter items' }).fill(file);
			await expect(
				page.getByRole('button', { name: `${file} ${file}`, exact: true })
			).toBeVisible();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('tab', { name: file, exact: true })).toBeVisible();
			await page.keyboard.type(keys);
		}
		await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
		await page.keyboard.press('Shift+H');
		await expect(page.getByRole('tab', { name: 'a.txt', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
		await page.keyboard.press('Shift+L');
		await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Shift+L');
		await expect(page.getByRole('tab', { name: /^highlight\.rs/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Shift+H');
		await expect(page.getByRole('tab', { name: 'b.txt', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Control+h');
		await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
		const explorer = page.getByRole('complementary', { name: 'File explorer' });
		await page.keyboard.press('Shift+L');
		await expect(explorer).toHaveCSS('width', '263px');
		await page.keyboard.press('Shift+H');
		await expect(explorer).toHaveCSS('width', '243px');
		const resizeHandle = page.getByRole('separator', { name: 'Explorer width' });
		// Wait for hit testing and layout to settle after the keyboard resize.
		await resizeHandle.hover({ position: { x: 2, y: 100 } });
		const edge = await resizeHandle.boundingBox();
		assert.ok(edge);
		await page.mouse.down();
		try {
			await expect(resizeHandle).toBeFocused();
			await page.mouse.move(edge.x + 2 + 40, edge.y + 100, { steps: 5 });
			await expect(explorer).toHaveCSS('width', '283px');
		} finally {
			await page.mouse.up();
		}
		await expect(explorer).toHaveCSS('width', '283px');
		await page.keyboard.press('Control+l');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('i');
		await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
		await expect(page.getByText('INSERT', { exact: true })).toHaveCSS(
			'background-color',
			'rgb(134, 189, 221)'
		);
		await page.keyboard.press('Shift+H');
		await page.keyboard.press('Shift+L');
		await expect(page.locator('canvas:visible')).toHaveAttribute('aria-description', /HL/);
		await expect(page.getByRole('tab', { name: 'b.txt Unsaved', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Escape');
		await page.keyboard.press('u');
		await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, join(root, 'Two'));
		await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toBeVisible();
		// Space h opens Time Machine; Space Shift+H moves the workspace left.
		await page.keyboard.press('Space');
		await page.keyboard.press('Shift+H');
		const closed = running.waitForEvent('close');
		await page.evaluate(() => {
			void window.nido.windowAction('close');
		});
		await closed;
		running = await electron.launch({ executablePath, args, env });
		page = await running.firstWindow();
		await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCSS(
			'width',
			'283px'
		);
		await expect(page.getByRole('tab', { name: 'Workspace Two', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Alt+2');
		await expect(page.getByRole('tab', { name: 'Workspace One', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByText('Ln 1, Col 7', { exact: true })).toBeVisible();
		await page.getByRole('tab', { name: 'a.txt', exact: true }).click();
		await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
	} finally {
		if (running) {
			await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
			await running.close();
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('keyboard-only workspace switching, editing, saving and dirty-close guard', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-e2e-'));
	await mkdir(join(root, 'Nido'));
	await mkdir(join(root, 'Portfolio'));
	await writeFile(
		join(root, 'Nido', 'WorkspaceTabs.tsx'),
		`import { useState } from 'react'\n\ninterface Workspace {\n  id: string\n  name: string\n}\n\nexport function WorkspaceTabs() {\n  const [active, setActive] = useState('nido')\n  const workspaces: Workspace[] = [\n    { id: 'nido', name: 'Nido' },\n    { id: 'portfolio', name: 'Portfolio' }\n  ]\n\n  return (\n    <nav aria-label="Workspaces">\n      {workspaces.map((workspace) => (\n        <button\n          key={workspace.id}\n          onClick={() => setActive(workspace.id)}\n          aria-selected={active === workspace.id}\n        >\n          {workspace.name}\n        </button>\n      ))}\n    </nav>\n  )\n}\n`
	);
	await writeFile(
		join(root, 'Nido', 'App.tsx'),
		'export default function App() { return null }\n'
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	if (executablePath) {
		for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
		env.VIMINIT = 'lua error("Personal configuration must not run")';
	}
	const app = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		});
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, join(root, 'Nido'));
		await expect(page.getByRole('tab', { name: 'Workspace Nido', exact: true })).toBeVisible();
		const welcome = page.getByRole('region', { name: 'Workspace welcome' });
		await expect(welcome).toBeVisible();
		await expect(page.locator('canvas:visible')).not.toHaveAttribute(
			'aria-description',
			/NVIM v/
		);
		await page.screenshot({ path: 'test-results/nido-workspace-welcome.png' });
		await page.keyboard.press('i');
		await expect(welcome).toBeHidden();
		await page.keyboard.type('draft');
		await page.keyboard.press('Escape');
		await expect(welcome).toBeHidden();
		await page.keyboard.press('u');
		await expect(welcome).toBeVisible();
		await page.keyboard.type(':');
		await expect(welcome).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(welcome).toBeVisible();
		await page.getByRole('button', { name: 'Open a file' }).click();
		await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'WorkspaceTabs.tsx' })).toBeVisible();
		await expect(welcome).toBeHidden();
		await page.keyboard.type('gg0i// smoke test');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect
			.poll(() => readSavedFile(join(root, 'Nido', 'WorkspaceTabs.tsx')))
			.toContain('// smoke test');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/smoke test/
		);
		await page.keyboard.press('Control+v');
		await expect(page.getByText('VISUAL', { exact: true })).toBeVisible();
		await expect(page.getByText('VISUAL', { exact: true })).toHaveCSS(
			'background-color',
			'rgb(201, 166, 230)'
		);
		await page.keyboard.press('Escape');
		await expect(page.getByText('NORMAL', { exact: true })).toBeVisible();
		await page.keyboard.type('Go');
		await expect(page.getByText('INSERT', { exact: true })).toBeVisible();
		const input = page.getByRole('textbox', { name: 'Neovim input' });
		const ime = await page.context().newCDPSession(page);
		try {
			for (const text of ['に', 'にほ', '日本語入力']) {
				await ime.send('Input.imeSetComposition', {
					text,
					selectionStart: text.length,
					selectionEnd: text.length
				});
				await expect(input).toHaveValue(text);
				await expect(input).toHaveCSS('opacity', '1');
				await expect(page.locator('canvas:visible')).not.toHaveAttribute(
					'aria-description',
					/日本語入力/
				);
			}
			await page.screenshot({ path: test.info().outputPath('japanese-composition.png') });
			await ime.send('Input.insertText', { text: '日本語入力' });
		} finally {
			await ime.detach();
		}
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/日本語入力/
		);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect
			.poll(
				async () =>
					(await readSavedFile(join(root, 'Nido', 'WorkspaceTabs.tsx')))?.match(
						/日本語入力/g
					)?.length
			)
			.toBe(1);
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/日本語入力/
		);
		await page.keyboard.type('gg');
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, join(root, 'Portfolio'));
		await expect(
			page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
		).toBeVisible();
		await page.keyboard.type('iindependent buffer');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+Tab');
		await expect(
			page.getByRole('tab', { name: 'Workspace Nido', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Space');
		await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Space');
		await page.keyboard.press('e');
		await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'App.tsx', exact: true })).toBeVisible();
		await page.keyboard.press('Space');
		await page.keyboard.press('b');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('WorkspaceTabs');
		await page.keyboard.press('Enter');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/smoke test/
		);
		await page.keyboard.press('Space');
		await page.screenshot({ path: 'test-results/nido-editor.png' });
		await page.keyboard.press('Escape');
		await page.keyboard.press('Alt+2');
		await page.keyboard.press('Space');
		await page.keyboard.press('x');
		await expect(
			page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
		).toBeVisible();
		await expect(
			page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('canvas:visible')).toHaveAttribute(
			'aria-description',
			/independent buffer/
		);
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
		});
		await page.keyboard.press('Space');
		await page.keyboard.press('x');
		await expect(
			page.getByRole('tab', { name: 'Workspace Portfolio', exact: true })
		).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.evaluate(({ app }) => app.exit(0));
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('an untitled draft returns after an abrupt exit without writing a file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-untitled-recovery-'));
	const workspace = join(root, 'workspace');
	const profile = join(root, 'profile');
	await mkdir(workspace);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const launch = (): ReturnType<typeof electron.launch> =>
			electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
		running = await launch();
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const input = page.getByRole('textbox', { name: 'Neovim input' });
		await expect(input).toBeFocused();
		await page.keyboard.type('i');
		await page.keyboard.insertText('untitled 日本語 draft');
		await page.keyboard.press('Escape');
		const layout = join(profile, 'workspaces.json');
		await expect
			.poll(
				async () => {
					const saved = await readSavedFile(layout);
					if (!saved) return false;
					const data = JSON.parse(saved) as {
						workspaces: { untitled?: { lines: string[] }[] }[];
					};
					return data.workspaces.some((item) =>
						item.untitled?.some(
							(draft) => draft.lines.join('\n') === 'untitled 日本語 draft'
						)
					);
				},
				{ timeout: 20000 }
			)
			.toBe(true);
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		running = await launch();
		page = await running.firstWindow();
		expect(await readdir(workspace)).toEqual([]);
		const canvas = page.locator('canvas[aria-label="Neovim editor display"]:visible');
		await expect(canvas).toHaveAttribute('aria-description', /untitled 日本語 draft/);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		expect(await readFile(layout, 'utf8')).toContain('untitled 日本語 draft');
	} finally {
		if (running) {
			await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
			await running.close().catch(() => {});
		}
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('oversized untitled drafts show a localized recovery warning', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-untitled-limit-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
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
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
		await page.keyboard.press('Escape');
		const input = page.getByRole('textbox', { name: 'Neovim入力' });
		await expect(input).toBeFocused();
		await page.keyboard.type(
			":lua vim.api.nvim_buf_set_lines(0, 0, -1, false, {string.rep('x', 8 * 1024 * 1024 + 1)})"
		);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('alert', { name: 'ワークスペースの復元' })).toContainText(
			'無名バッファ100件、1件8 MiB、合計16 MiBまで対応しています',
			{ timeout: 20000 }
		);
	} finally {
		await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await running.close().catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('disabled automatic history excludes untitled drafts from workspace checkpoints', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-untitled-paused-'));
	const workspace = join(root, 'workspace');
	const profile = join(root, 'profile');
	await mkdir(workspace);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	const running = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const automatic = page.getByRole('checkbox', { name: 'Automatic edit history' });
		await automatic.uncheck();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.historyEnabled')))
			.toBe('false');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type('iprivate draft while paused');
		await page.keyboard.press('Escape');
		await expect(
			page.locator('canvas[aria-label="Neovim editor display"]:visible')
		).toHaveAttribute('aria-description', /private draft while paused/);
		// A new window size proves the checkpoint was taken after the edit.
		const bounds = await running.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.unmaximize();
			window.setSize(1000, 700);
			return window.getNormalBounds();
		});
		const layout = join(profile, 'workspaces.json');
		await expect
			.poll(
				async () => {
					const saved = await readSavedFile(layout);
					if (!saved) return false;
					const data = JSON.parse(saved) as {
						window?: { width: number; height: number };
					};
					return (
						data.window?.width === bounds.width && data.window.height === bounds.height
					);
				},
				{ timeout: 20000 }
			)
			.toBe(true);
		const saved = await readFile(layout, 'utf8');
		expect(saved).not.toContain('private draft while paused');
		expect(JSON.parse(saved).workspaces[0].untitled).toBeUndefined();
	} finally {
		await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await running.close().catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
