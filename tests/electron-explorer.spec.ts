import { test, expect } from '@playwright/test';
import { electron } from './helpers/electron';
import { readSavedFile } from './helpers/files';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorkspace } from './helpers/electron-shared';

test('explorer commands create, rename, copy, move and recycle files from the keyboard', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-explorer-actions-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'original.txt'), 'hello\n');
	const env = { ...process.env };
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
		const tree = page.getByRole('tree', { name: 'Project files' });
		const menu = page.getByRole('dialog', { name: 'Explorer commands', exact: true });
		const path = menu.getByRole('textbox', { name: /^(Workspace-relative path|Name)$/ });
		const apply = async (value: string): Promise<void> => {
			await expect(menu).toBeVisible();
			await path.fill(value);
			await page.keyboard.press('Enter');
			await expect(menu).toHaveCount(0);
			await expect(tree).toBeFocused();
		};
		const select = async (name: string): Promise<void> => {
			const item = tree.getByRole('treeitem', { name, exact: true });
			await item.click();
			if ((await item.getAttribute('aria-expanded')) === null) {
				await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
				await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
			}
			await tree.focus();
		};
		await expect(
			tree.getByRole('treeitem', { name: 'original.txt', exact: true })
		).toBeVisible();
		await select('original.txt');
		await page.keyboard.press('F2');
		await apply('renamed.txt');
		await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Control+l');
		await page.keyboard.type('A!');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect.poll(() => readSavedFile(join(workspace, 'renamed.txt'))).toBe('hello!\n');
		await expect(
			tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })
		).toHaveAttribute('aria-selected', 'true');
		await tree.focus();
		await expect(tree).toBeFocused();
		await page.keyboard.press('Control+c');
		await expect(page.getByRole('complementary', { name: 'File explorer' })).toContainText(
			'Copied: renamed.txt'
		);
		await page.keyboard.press('Control+v');
		await apply('copy.txt');
		await expect.poll(() => readSavedFile(join(workspace, 'copy.txt'))).toBe('hello!\n');
		await page.keyboard.type(':');
		await expect(menu).toBeVisible();
		await menu.screenshot({ path: 'test-results/explorer-commands.png' });
		await page.keyboard.type('A');
		await apply('nested');
		await page.keyboard.type('a');
		await apply('nested/new.txt');
		await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toBeVisible();
		await select('renamed.txt');
		await page.keyboard.press('Control+x');
		await select('nested');
		await page.keyboard.press('Control+v');
		await apply('nested/renamed.txt');
		await expect
			.poll(() => readSavedFile(join(workspace, 'nested/renamed.txt')))
			.toBe('hello!\n');
		await expect(
			tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })
		).toBeVisible();
		await select('copy.txt');
		await page.keyboard.press('Delete');
		await expect(menu).toContainText('Move copy.txt to the recycle bin?');
		await menu.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(tree.getByRole('treeitem', { name: 'copy.txt', exact: true })).toBeVisible();
		await page.keyboard.press('Delete');
		await menu.getByRole('button', { name: 'Move to recycle bin', exact: true }).click();
		await expect(menu).toHaveCount(0);
		await expect(tree.getByRole('treeitem', { name: 'copy.txt', exact: true })).toHaveCount(0);
		await expect(page.getByRole('tab', { name: 'copy.txt', exact: true })).toHaveCount(0);
		await assert.rejects(readFile(join(workspace, 'copy.txt'), 'utf8'), /ENOENT/);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('explorer supports half-page, page and first/last selection with Vim keys', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-explorer-keys-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await Promise.all(
		Array.from({ length: 80 }, (_, index) =>
			writeFile(join(workspace, `file-${String(index).padStart(2, '0')}.txt`), 'sample\n')
		)
	);
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.press('Control+h');
		const tree = page.getByRole('tree', { name: 'Project files' });
		await expect(tree).toBeFocused();
		await expect(tree).toHaveAttribute('data-row-count', '80');
		const selected = tree.locator('[aria-selected="true"]');
		await page.keyboard.type('gg');
		await expect(selected).toHaveText('file-00.txt');
		const step = await tree.evaluate((node) =>
			Math.max(
				1,
				Math.floor(
					node.clientHeight /
						node.querySelector('[role="treeitem"]')!.getBoundingClientRect().height /
						2
				)
			)
		);
		await page.keyboard.press('Control+d');
		await expect(selected).toHaveText(`file-${String(step).padStart(2, '0')}.txt`);
		await page.keyboard.press('Control+u');
		await expect(selected).toHaveText('file-00.txt');
		await page.keyboard.press('Control+f');
		await expect(selected).not.toHaveText(`file-${String(step).padStart(2, '0')}.txt`);
		await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
		await page.keyboard.press('Control+b');
		await expect(selected).toHaveText('file-00.txt');
		await page.keyboard.press('Shift+g');
		await expect(selected).toHaveText('file-79.txt');
		await page.keyboard.press('Control+d');
		await expect(selected).toHaveText('file-79.txt');
		await page.keyboard.press('Control+g');
		await expect(selected).toHaveText('file-79.txt');
		await tree.dispatchEvent('keydown', { key: 'g', isComposing: true });
		await expect(selected).toHaveText('file-79.txt');
		await page.keyboard.type('gg');
		await expect(selected).toHaveText('file-00.txt');
		await page.keyboard.press('PageDown');
		await expect(selected).not.toHaveText('file-00.txt');
		await page.keyboard.press('PageUp');
		await expect(selected).toHaveText('file-00.txt');
		await expect(tree).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'file-00.txt', exact: true })).toBeVisible();
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('file tabs scroll into view when switching hidden buffers with Shift H and L', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-tab-scroll-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await mkdir(join(workspace, 'nested', 'deep'), { recursive: true });
	await writeFile(join(workspace, 'nested', 'deep', 'target.txt'), 'nested sample\n');
	const files = Array.from(
		{ length: 15 },
		(_, index) => `file-${String(index).padStart(2, '0')}.txt`
	);
	await Promise.all(files.map((file) => writeFile(join(workspace, file), 'sample\n')));
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const executablePath = process.env.NIDO_PACKAGED_EXE;
	const running = await electron.launch({
		executablePath,
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`],
		env
	});
	try {
		const page = await running.firstWindow();
		await page.setViewportSize({ width: 900, height: 650 });
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		const selected = tabs.locator('[role="tab"][aria-selected="true"]');
		const tree = page.getByRole('tree', { name: 'Project files' });
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		const expectSelectedVisible = async (file: string): Promise<void> => {
			await expect(selected).toHaveText(file);
			await expect(tree.locator('[aria-selected="true"]')).toHaveText(file);
			await expect
				.poll(() =>
					selected.evaluate((node) => {
						const tab = node.parentElement!.getBoundingClientRect();
						const list = node.closest('[role="tablist"]')!.getBoundingClientRect();
						return tab.left >= list.left - 1 && tab.right <= list.right + 1;
					})
				)
				.toBe(true);
			await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		};
		for (const file of files) {
			await page.keyboard.type(`:edit ${file}`);
			await page.keyboard.press('Enter');
			await expect(selected).toHaveText(file);
		}
		await expectSelectedVisible(files.at(-1)!);
		await expect.poll(() => tabs.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
		await page.keyboard.press('Shift+L');
		await expectSelectedVisible(files[0]);
		await expect.poll(() => tabs.evaluate((node) => node.scrollLeft)).toBe(0);
		await page.keyboard.press('Shift+H');
		await expectSelectedVisible(files.at(-1)!);
		await page.keyboard.type(':edit nested/deep/target.txt');
		await page.keyboard.press('Enter');
		await expectSelectedVisible('target.txt');
	} finally {
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('explorer zz centers selection without opening or changing files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-explorer-center-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await Promise.all(
		Array.from({ length: 100 }, (_, i) =>
			writeFile(join(workspace, `file${String(i).padStart(3, '0')}.txt`), '')
		)
	);
	const env = { ...process.env };
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
		const tree = page.getByRole('tree', { name: 'Project files' });
		await expect(tree).toHaveAttribute('data-row-count', '100');
		await tree.focus();
		await page.keyboard.press('Home');
		await page.keyboard.type('j'.repeat(50));
		const selected = tree.locator('[aria-selected="true"]');
		const name = await selected.textContent();
		const before = await tree.evaluate((node) => node.scrollTop);
		await page.keyboard.press('z');
		expect(await tree.evaluate((node) => node.scrollTop)).toBe(before);
		await page.keyboard.press('z');
		await expect
			.poll(() =>
				tree.evaluate((node) => {
					const row = node
						.querySelector('[aria-selected="true"]')!
						.getBoundingClientRect();
					const viewport = node.getBoundingClientRect();
					return Math.abs(
						row.top + row.height / 2 - viewport.top - node.clientHeight / 2
					);
				})
			)
			.toBeLessThan(2);
		await expect(selected).toHaveText(name!);
		await expect(tree).toBeFocused();
		const centered = await tree.evaluate((node) => node.scrollTop);
		await page.keyboard.type('zxz');
		expect(await tree.evaluate((node) => node.scrollTop)).toBe(centered);
	} finally {
		await running.evaluate(({ app }) => app.exit(0));
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('file tabs retain reordered positions and the reopened cursor across restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-file-tabs-'));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	const files = ['first.txt', 'second.txt', 'third.txt'];
	await Promise.all(
		files.map((file) => writeFile(join(workspace, file), 'line one\nline two\nline three\n'))
	);
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { args: ['.', `--user-data-dir=${join(root, 'profile')}`], env };
	let running: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		running = await electron.launch(options);
		let page = await running.firstWindow();
		await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
		await page.keyboard.press('Control+Shift+n');
		await chooseWorkspace(page, workspace);
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		let tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		for (const file of files) {
			await page.keyboard.type(`:edit ${file}`);
			await page.keyboard.press('Enter');
			await expect(tabs.getByRole('tab', { selected: true })).toHaveText(file);
		}
		await page.keyboard.type('3G4l');
		await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
		await tabs
			.getByRole('tab', { name: 'first.txt', exact: true })
			.dragTo(tabs.getByRole('tab', { name: 'third.txt', exact: true }));
		const reordered = ['second.txt', 'third.txt', 'first.txt'];
		await expect(tabs.getByRole('tab')).toHaveText(reordered);
		await page.getByRole('button', { name: 'Close file third.txt', exact: true }).click();
		await expect(tabs.getByRole('tab')).toHaveText(['second.txt', 'first.txt']);
		await page.keyboard.press('Control+Shift+t');
		await expect(tabs.getByRole('tab')).toHaveText(reordered);
		await expect(tabs.getByRole('tab', { selected: true })).toHaveText('third.txt');
		await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();

		await running.close();
		running = await electron.launch(options);
		page = await running.firstWindow();
		tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		await expect(tabs.getByRole('tab')).toHaveText(reordered);
		await expect(tabs.getByRole('tab', { selected: true })).toHaveText('third.txt');
		await expect(page.getByText('Ln 3, Col 5', { exact: true })).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	} finally {
		await running?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('Explorer opens and reopens literal bracketed file names while preserving other drafts', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-literal-files-')));
	const workspace = join(root, 'workspace');
	await mkdir(workspace);
	await writeFile(join(workspace, 'file[1].txt'), 'literal\n');
	await writeFile(join(workspace, 'file1.txt'), 'other\n');
	const env = { ...process.env };
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
		const tree = page.getByRole('tree', { name: 'Project files' });
		const tabs = page.getByRole('tablist', { name: 'Files', exact: true });
		await tree.getByRole('treeitem', { name: 'file1.txt', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
		await page.keyboard.type('A draft');
		await page.keyboard.press('Escape');
		await tree.getByRole('treeitem', { name: 'file[1].txt', exact: true }).click();
		await expect(tabs.getByRole('tab', { selected: true })).toHaveText('file[1].txt');
		await expect(page.locator('canvas[aria-label="Neovim editor display"]')).toHaveAttribute(
			'aria-description',
			/literal/
		);
		await page.keyboard.type('A!');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+s');
		await expect.poll(() => readSavedFile(join(workspace, 'file[1].txt'))).toBe('literal!\n');
		expect(await readFile(join(workspace, 'file1.txt'), 'utf8')).toBe('other\n');
		await page.getByRole('button', { name: 'Close file file[1].txt', exact: true }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(1);
		await page.keyboard.press('Control+Shift+t');
		await expect(tabs.getByRole('tab', { selected: true })).toHaveText('file[1].txt');
		await tree.getByRole('treeitem', { name: 'file1.txt', exact: true }).click();
		await expect(page.locator('canvas[aria-label="Neovim editor display"]')).toHaveAttribute(
			'aria-description',
			/other draft/
		);
	} finally {
		await running.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await running.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
