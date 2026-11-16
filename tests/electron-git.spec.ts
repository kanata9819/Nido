import { test, expect, type Page } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import { attachEditorDiagnostics, recordEditorDiagnostics } from './helpers/editor-diagnostics';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseWorkspace } from './helpers/electron-shared';
import { launchEnv } from './helpers/launch-env';

test('Git changes can be reviewed, staged and committed with the keyboard', async () => {
	const testInfo = test.info();
	const root = await mkdtemp(join(tmpdir(), 'nido-git-ui-'));
	const repository = join(root, 'repo');
	await mkdir(repository);
	const git = (...args: string[]): string =>
		execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
	git('init');
	git('config', 'user.name', 'Nido Test');
	git('config', 'user.email', 'nido-test@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	await writeFile(
		join(repository, 'main.rs'),
		'fn main() {}\n' +
			Array.from({ length: 150 }, (_, i) => `// ${i} ${'long diff line '.repeat(20)}\n`).join(
				''
			)
	);
	const env = launchEnv();
	delete env.ELECTRON_RUN_AS_NODE;
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	let diagnosticPage: Page | undefined;
	try {
		const executablePath = process.env.NIDO_PACKAGED_EXE;
		running = await electron.launch({
			executablePath,
			args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
			env
		});
		const page = await running.firstWindow();
		diagnosticPage = page;
		await recordEditorDiagnostics(page);
		async function checkDiffKeys(label: string, listLabel: string): Promise<void> {
			const preview = page.getByLabel(label, { exact: true });
			await page.keyboard.press('Control+l');
			await expect(preview).toBeFocused();
			const top = (): Promise<number> => preview.evaluate((node) => node.scrollTop);
			const viewportHeight = await preview.evaluate((node) => node.clientHeight);
			const original = page.getByLabel(`${label} original`, { exact: true });
			await page.keyboard.press('g');
			await page.keyboard.press('j');
			await expect.poll(top).toBeGreaterThan(0);
			await page.keyboard.press('k');
			// Display scaling can round line steps to fractional CSS pixels.
			await expect.poll(top).toBeLessThan(1);
			for (const [down, up] of [
				['Control+d', 'Control+u'],
				['Control+f', 'Control+b']
			]) {
				await page.keyboard.press(down);
				await expect.poll(top).toBeGreaterThan(viewportHeight * 0.4);
				await page.keyboard.press(up);
				await expect.poll(top).toBeLessThan(1);
			}
			await page.keyboard.press('Shift+g');
			await expect.poll(top).toBeGreaterThan(1000);
			await expect
				.poll(async () =>
					Math.abs((await top()) - (await original.evaluate((node) => node.scrollTop)))
				)
				.toBeLessThanOrEqual(1);
			await page.keyboard.press('g');
			await expect.poll(top).toBe(0);
			await page.keyboard.press('l');
			await expect.poll(() => preview.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
			await page.keyboard.press('h');
			await expect.poll(() => preview.evaluate((node) => node.scrollLeft)).toBeLessThan(1);
			await page.keyboard.press('Control+h');
			await expect(page.getByRole('listbox', { name: listLabel })).toBeFocused();
		}
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, repository);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		// This Git fixture has no Cargo project; formatter failures have dedicated regression coverage.
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Format on save' }).uncheck();
		await page.keyboard.press('Escape');
		const explorer = page.getByRole('complementary', { name: 'File explorer' });
		await expect(explorer.getByLabel('Git: Untracked', { exact: true })).toHaveText('U');
		await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS(
			'color',
			'rgb(159, 198, 142)'
		);
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
		await expect(
			page
				.getByRole('dialog', { name: 'files palette' })
				.getByRole('button', { name: /main.rs/ })
		).toBeVisible();
		await page.keyboard.press('Enter');
		const fileTabs = page.getByRole('tablist', { name: 'Files', exact: true });
		await expect(fileTabs.getByLabel('Git: Untracked', { exact: true })).toHaveText('U');
		await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS(
			'color',
			'rgb(159, 198, 142)'
		);
		const gitButton = page.getByRole('button', { name: 'Source control', exact: true });
		await gitButton.click();
		const panel = page.getByRole('region', { name: 'Git changes' });
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await gitButton.focus();
		await expect(gitButton).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'git palette' })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+Shift+g');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
		await expect(page.getByLabel('Git diff', { exact: true })).toContainText('fn main() {}');
		await expect(panel.getByText('Before', { exact: true })).toBeVisible();
		await expect(panel.getByText('After', { exact: true })).toBeVisible();
		await expect(
			page.getByLabel('Git diff', { exact: true }).locator('code span').first()
		).toBeVisible();
		const dialog = page.getByRole('dialog', { name: 'git palette' });
		const bounds = await dialog.boundingBox();
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		expect(bounds!.width).toBeGreaterThan(viewport.width * 0.75);
		expect(bounds!.width).toBeLessThan(viewport.width * 0.95);
		expect(bounds!.height).toBeGreaterThan(viewport.height * 0.6);
		expect(bounds!.height).toBeLessThan(viewport.height * 0.85);
		const original = page.getByLabel('Git diff original', { exact: true });
		const updated = page.getByLabel('Git diff', { exact: true });
		expect((await original.boundingBox())!.x).toBeLessThan((await updated.boundingBox())!.x);
		await checkDiffKeys('Git diff', 'Changed files');
		await page.keyboard.press('s');
		await expect(page.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
		await expect(fileTabs.getByLabel('Git: Added (staged)', { exact: true })).toHaveText('A');
		await expect(explorer.getByLabel('Git: Added (staged)', { exact: true })).toHaveText('A');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('u');
		await expect(page.getByRole('heading', { name: 'Staged changes' })).toHaveCount(0);
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('s');
		await expect(panel.getByRole('heading', { name: 'Staged changes' })).toBeVisible();
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.screenshot({ path: 'test-results/nido-git.png' });
		await page.keyboard.press('c');
		await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeFocused();
		await page.keyboard.type('First commit');
		await page.keyboard.press('Control+Enter');
		await expect(panel.getByText('Working tree clean.')).toBeVisible();
		await expect(fileTabs.locator('[data-status]')).toHaveCount(0);
		await expect(explorer.locator('[data-status]')).toHaveCount(0);
		expect(git('log', '-1', '--format=%s').trim()).toBe('First commit');
		const originalBranch = git('branch', '--show-current').trim();
		await writeFile(join(repository, 'notes.txt'), 'extra file\n');
		git('add', 'notes.txt');
		git('commit', '--amend', '--no-edit');
		await page.keyboard.press('Tab');
		await page.keyboard.press('2');
		const browser = page.getByRole('region', { name: 'Git browser' });
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('listbox', { name: 'Commit history' })).toBeFocused();
		await expect(page.getByRole('option', { name: /First commit/ })).toBeVisible();
		await expect(browser.getByText('Commits: 1', { exact: true })).toBeVisible();
		const details = page.getByRole('region', { name: 'Commit details' });
		await expect(details.getByRole('heading', { name: 'First commit' })).toBeVisible();
		await expect(details.locator('code')).toHaveText(git('rev-parse', 'HEAD').trim());
		await page.keyboard.press('Control+l');
		await expect(details).toBeFocused();
		await page.screenshot({ path: 'test-results/nido-commit-details.png' });
		await page.keyboard.press('Control+h');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('listbox', { name: 'Commit files' })).toBeVisible();
		await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('fn main() {}');
		await expect(
			page.getByLabel('Commit diff', { exact: true }).locator('code span').first()
		).toBeVisible();
		await checkDiffKeys('Commit diff', 'Commit files');
		await page.keyboard.press('Control+l');
		await page.keyboard.press('n');
		await expect(browser.getByText('Change 1 / 1 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('Shift+n');
		await expect(browser.getByText('Change 1 / 1 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('Control+h');
		await page.keyboard.press('j');
		await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('extra file');
		await page.keyboard.press('k');
		await expect(page.getByLabel('Commit diff', { exact: true })).toContainText('fn main() {}');
		await page.screenshot({ path: 'test-results/nido-git-history.png' });
		await page.keyboard.press('Escape');
		await expect(page.getByRole('listbox', { name: 'Commit history' })).toBeFocused();
		const source = await readFile(join(repository, 'main.rs'), 'utf8');
		await writeFile(
			join(repository, 'main.rs'),
			source
				.replace('fn main() {}', 'fn main() { println!("Nido"); }')
				.replace('// 70 ', '// updated 70 ')
				.replace('// 140 ', '// updated 140 ')
		);
		await page.keyboard.press('1');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByLabel('Git diff original', { exact: true })).toContainText(
			'fn main() {}'
		);
		await expect(page.getByLabel('Git diff', { exact: true })).toContainText(
			'fn main() { println!("Nido"); }'
		);
		// Offscreen rows are mounted on demand; verify the last row through actual scrolling.
		await updated.evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		await expect(original).toContainText('// 149');
		await expect(updated).toContainText('// 149');
		await updated.evaluate((node) => {
			node.scrollTop = 0;
		});
		for (const label of ['Git diff original', 'Git diff']) {
			const code = page.getByLabel(label, { exact: true }).locator('code').first();
			await expect(code.locator('span').first()).toHaveText('fn');
			await expect
				.poll(() =>
					code
						.locator('span')
						.evaluateAll(
							(spans) =>
								new Set(spans.map((span) => getComputedStyle(span).color)).size
						)
				)
				.toBeGreaterThan(1);
		}
		await checkDiffKeys('Git diff', 'Changed files');
		await page.keyboard.press('Control+l');
		await page.keyboard.press('n');
		await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
		await expect.poll(() => updated.evaluate((node) => node.scrollTop)).toBeLessThan(1);
		await page.keyboard.press('n');
		await expect(panel.getByText('Change 2 / 3 · n / N', { exact: true })).toBeVisible();
		await expect.poll(() => updated.evaluate((node) => node.scrollTop)).toBeGreaterThan(1000);
		await expect
			.poll(() =>
				page
					.getByLabel('Git diff original', { exact: true })
					.evaluate((node) => node.scrollTop)
			)
			.toBeGreaterThan(1000);
		await page.keyboard.press('n');
		await expect(panel.getByText('Change 3 / 3 · n / N', { exact: true })).toBeVisible();
		await page.getByLabel('Git diff original', { exact: true }).focus();
		await page.keyboard.press('Shift+n');
		await expect(panel.getByText('Change 2 / 3 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('Shift+n');
		await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('Shift+n');
		await expect(panel.getByText('Change 3 / 3 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('n');
		await expect(panel.getByText('Change 1 / 3 · n / N', { exact: true })).toBeVisible();
		await page.keyboard.press('Control+h');
		await page.screenshot({ path: 'test-results/nido-git-side-by-side.png' });
		await page.keyboard.press('3');
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('listbox', { name: 'Branches' })).toBeFocused();
		const branchDetails = page.getByRole('region', { name: 'Branch details' });
		await expect(
			branchDetails.getByRole('heading', { name: originalBranch, exact: true })
		).toBeVisible();
		await expect(branchDetails.getByText('Currently checked out')).toBeVisible();
		await page.keyboard.press('Control+l');
		await expect(branchDetails).toBeFocused();
		await page.screenshot({ path: 'test-results/nido-branch-details.png' });
		await page.keyboard.press('Control+h');
		await page.keyboard.press('n');
		await expect(page.getByRole('textbox', { name: 'New branch name' })).toBeFocused();
		await page.keyboard.type('feature-123');
		await page.keyboard.press('Enter');
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		await expect(browser.locator('strong').first()).toHaveText('feature-123');
		expect(git('branch', '--show-current').trim()).toBe('feature-123');
		await expect(page.getByRole('listbox', { name: 'Branches' })).toBeFocused();
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		expect(git('branch', '--show-current').trim()).toBe(originalBranch);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Space');
		await page.keyboard.press('g');
		await expect(panel).toBeVisible();
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('c');
		await page.keyboard.type('Draft 123');
		await page.keyboard.press('Tab');
		await page.keyboard.press('2');
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('1');
		await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
			'Draft 123'
		);
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+p');
		await page.getByRole('textbox', { name: 'Filter items' }).fill('main.rs');
		await expect(
			page
				.getByRole('dialog', { name: 'files palette' })
				.getByRole('button', { name: /main.rs/ })
		).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('i');
		await page.keyboard.type('unsaved');
		await page.keyboard.press('Escape');
		await expect(fileTabs.getByLabel('Unsaved', { exact: true })).toHaveCount(1);
		await page.keyboard.press('Control+Shift+g');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('3');
		await expect(browser).toHaveAttribute('aria-busy', 'false');
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await expect(browser.getByRole('alert')).toContainText('Save unsaved editor changes');
		expect(git('branch', '--show-current').trim()).toBe(originalBranch);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+s');
		await expect.poll(() => readSavedFile(join(repository, 'main.rs'))).toContain('unsaved');
		await expect(fileTabs.getByLabel('Git: Modified', { exact: true })).toHaveText('M');
		await expect(explorer.getByLabel('Git: Modified', { exact: true })).toHaveText('M');
		await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS(
			'color',
			'rgb(217, 183, 119)'
		);
		await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS(
			'color',
			'rgb(217, 183, 119)'
		);
		await expect(fileTabs.getByLabel('Unsaved', { exact: true })).toHaveCount(0);
		await page.screenshot({ path: 'test-results/nido-git-tab-status.png' });
		git('add', 'main.rs');
		await expect(fileTabs.getByLabel('Git: Modified (staged)', { exact: true })).toHaveText(
			'M'
		);
		git('commit', '-m', 'External commit');
		await expect(fileTabs.locator('[data-status]')).toHaveCount(0);
		await page.keyboard.press('Escape');
		for (const [severity, label, color] of [
			[1, 'error', 'rgb(229, 155, 150)'],
			[2, 'warning', 'rgb(217, 183, 119)']
		] as const) {
			await page.keyboard.type(
				`:lua vim.diagnostic.set(vim.api.nvim_create_namespace('nido-test'), 0, {{lnum=0,col=0,severity=${severity},message='Test diagnostic'}})`
			);
			await page.keyboard.press('Enter');
			await expect(fileTabs.getByLabel(`1 ${label}`, { exact: true })).toBeVisible();
			await expect(fileTabs.getByText('main.rs', { exact: true })).toHaveCSS('color', color);
			await expect(explorer.getByText('main.rs', { exact: true })).toHaveCSS('color', color);
		}
		await page.keyboard.type(
			":lua vim.diagnostic.reset(vim.api.nvim_create_namespace('nido-test'))"
		);
		await page.keyboard.press('Enter');
		await expect(fileTabs.locator('[data-diagnostic]')).toHaveCount(0);
		await expect(explorer.locator('[data-diagnostic]')).toHaveCount(0);
	} catch (error) {
		if (diagnosticPage) await attachEditorDiagnostics(diagnosticPage, testInfo);
		throw error;
	} finally {
		await running?.evaluate(({ app }) => app.exit(0));
		await running?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('stage all keeps HEAD gutter marks until commit and preserves unsaved edits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-stage-all-ui-'));
	const workspace = join(root, 'repo');
	await mkdir(workspace);
	const git = (...args: string[]): string =>
		execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
	git('init', '-q');
	git('config', 'user.name', 'Nido Test');
	git('config', 'user.email', 'nido@example.test');
	git('config', 'commit.gpgsign', 'false');
	await writeFile(join(workspace, 'main.txt'), 'before\n');
	await writeFile(join(workspace, 'deleted.txt'), 'deleted\n');
	git('add', '.');
	git('commit', '-qm', 'Initial');
	await writeFile(join(workspace, 'main.txt'), 'changed\n');
	await writeFile(join(workspace, 'new.txt'), 'new\n');
	await rm(join(workspace, 'deleted.txt'));
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
		await page.keyboard.type(':edit main.txt');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas:visible');
		await expect(canvas).toHaveAttribute('aria-description', /▎.*changed/);
		// The actual Neovim sign highlight must paint the entire row, including spacing.
		await expect
			.poll(() =>
				canvas.evaluate((element: HTMLCanvasElement) => {
					const ctx = element.getContext('2d')!;
					const height = Math.round(18 * devicePixelRatio);
					const { data, width } = ctx.getImageData(0, 0, element.width, height);
					for (let x = 0; x < width; x++) {
						let continuous = true;
						for (let y = 0; y < height; y++) {
							const index = (y * width + x) * 4;
							if (
								data[index] !== 0 ||
								data[index + 1] !== 120 ||
								data[index + 2] !== 212
							) {
								continuous = false;
								break;
							}
						}
						if (continuous) return true;
					}
					return false;
				})
			)
			.toBe(true);
		await page.keyboard.type('A unsaved');
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /changed unsaved/);
		await page.keyboard.press('Control+Shift+g');
		const panel = page.getByRole('region', { name: 'Git changes' });
		await expect(
			panel.getByRole('button', { name: 'Stage all (S)', exact: true })
		).toBeEnabled();
		await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
		await page.keyboard.press('Shift+s');
		await expect(
			panel.getByRole('heading', { name: 'Staged changes', exact: true })
		).toBeVisible();
		await expect(
			panel.getByRole('button', { name: 'Stage all (S)', exact: true })
		).toBeDisabled();
		expect(git('diff', '--cached', '--name-only').trim().split('\n')).toEqual([
			'deleted.txt',
			'main.txt',
			'new.txt'
		]);
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /▎.*changed unsaved/);
		await page.keyboard.press('Control+Shift+g');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		await page.getByRole('textbox', { name: 'Commit message' }).fill('Stage all commit');
		await page.keyboard.press('Control+Enter');
		await expect(panel.getByText('Working tree clean.', { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(canvas).toHaveAttribute('aria-description', /▎.*changed unsaved/);
		expect(git('show', 'HEAD:main.txt')).toBe('changed\n');
		await page.keyboard.type('u');
		await expect(canvas).toHaveAttribute('aria-description', /changed/);
		await expect(canvas).not.toHaveAttribute('aria-description', /▎|▸/);
		expect(git('log', '--format=%s', '-1').trim()).toBe('Stage all commit');
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
