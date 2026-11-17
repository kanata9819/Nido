import { test, expect } from './helpers/renderer-test';
import type { Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import type {} from './renderer/harness';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

/** Settle the next pending listing of `path`. */
async function list(
	page: Page,
	path: string,
	files: { name: string; path: string; directory: boolean }[]
): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				(path) =>
					window.rendererTest.pending.some(
						(call) => call.method === 'files' && call.args[1] === path
					),
				path
			)
		)
		.toBe(true);
	await page.evaluate(
		({ path, files }) => {
			const listings = window.rendererTest.pending.filter((call) => call.method === 'files');
			window.rendererTest.settle(
				'files',
				listings.findIndex((call) => call.args[1] === path),
				files
			);
		},
		{ path, files }
	);
}

/**
 * Drag files from the computer over the element matching `selector` (the tree itself when
 * omitted), as the operating system does: dragover, then optionally drop.
 */
async function drag(page: Page, selector: string | undefined, drop: boolean): Promise<void> {
	await page.evaluate(
		({ selector, drop }) => {
			const tree = document.querySelector('[role="tree"]')!;
			const target = selector ? document.querySelector(selector)! : tree;
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File(['a'], 'photo.png'));
			dataTransfer.items.add(new File([], 'docs'));
			for (const type of drop ? ['dragover', 'drop'] : ['dragover']) {
				target.dispatchEvent(
					new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true })
				);
			}
		},
		{ selector, drop }
	);
}

const imports = (page: Page): Promise<unknown[][]> =>
	page.evaluate(() =>
		window.rendererTest.calls
			.filter((call) => call.method === 'importFiles')
			.map((call) => call.args)
	);

test('Files dragged from the computer go into the folder under the pointer, which is highlighted', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=files,importFiles`);
	await list(page, '', [
		{ name: 'src', path: 'src', directory: true },
		{ name: 'readme.md', path: 'readme.md', directory: false }
	]);
	const tree = page.getByRole('tree', { name: 'Project files' });
	await tree.getByRole('treeitem', { name: 'src' }).click();
	await list(page, 'src', [
		{ name: 'app.ts', path: 'src/app.ts', directory: false },
		{ name: 'lib', path: 'src/lib', directory: true }
	]);
	const row = (path: string): string => `[id="file-alpha-${path}"]`;
	const highlighted = (): Promise<string[]> =>
		page.evaluate(() =>
			Array.from(document.querySelectorAll('[role="treeitem"][data-drop-target]'), (row) =>
				row.id.replace('file-alpha-', '')
			)
		);
	// The status line below the tree.
	const footer = tree.locator('xpath=following-sibling::div[1]');

	// Over a folder: that folder, with its rows.
	await drag(page, row('src'), false);
	await expect.poll(highlighted).toEqual(['src', 'src/app.ts', 'src/lib']);
	await expect(tree).not.toHaveAttribute('data-drop-target');
	await expect(footer).toHaveText('Copy into: src :');
	// Over a nested folder: only that folder.
	await drag(page, `${row('src/lib')} span`, false);
	await expect.poll(highlighted).toEqual(['src/lib']);
	// Over a file: the folder holding it.
	await drag(page, row('src/app.ts'), false);
	await expect.poll(highlighted).toEqual(['src', 'src/app.ts', 'src/lib']);
	// Over a file in the workspace folder, or the empty space: the whole tree.
	await drag(page, row('readme.md'), false);
	await expect.poll(highlighted).toEqual([]);
	await expect(tree).toHaveAttribute('data-drop-target', 'true');
	await expect(footer).toHaveText('Copy into: Alpha :');
	await drag(page, undefined, false);
	await expect(tree).toHaveAttribute('data-drop-target', 'true');
	// Leaving the tree clears the highlight.
	await page.evaluate(() =>
		document
			.querySelector('[role="tree"]')!
			.dispatchEvent(
				new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body })
			)
	);
	await expect(tree).not.toHaveAttribute('data-drop-target');
	await expect(footer).toHaveText('File commands :');

	// Drops copy the dragged paths into the same folders.
	await drag(page, row('src/app.ts'), true);
	await drag(page, row('src/lib'), true);
	await drag(page, undefined, true);
	const paths = ['C:\\Users\\me\\Desktop\\photo.png', 'C:\\Users\\me\\Desktop\\docs'];
	expect(await imports(page)).toEqual([
		['alpha', paths, 'src'],
		['alpha', paths, 'src/lib'],
		['alpha', paths, '']
	]);
	await expect.poll(highlighted).toEqual([]);
	await expect(tree).not.toHaveAttribute('data-drop-target');
});

test('Dragging text, not files, over the explorer neither highlights nor copies', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=files,importFiles`);
	await list(page, '', [{ name: 'src', path: 'src', directory: true }]);
	const tree = page.getByRole('tree', { name: 'Project files' });
	await expect(tree.getByRole('treeitem', { name: 'src' })).toBeVisible();
	const prevented = await page.evaluate(() => {
		const dataTransfer = new DataTransfer();
		dataTransfer.setData('text/plain', 'hello');
		const row = document.querySelector('[id="file-alpha-src"]')!;
		const over = new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true });
		row.dispatchEvent(over);
		row.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
		return over.defaultPrevented;
	});
	expect(prevented).toBe(false);
	await expect(tree.getByRole('treeitem', { name: 'src' })).not.toHaveAttribute(
		'data-drop-target'
	);
	expect(await imports(page)).toEqual([]);
});

test('A failed copy is reported, and a finished one selects the first copy', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=files,importFiles`);
	await list(page, '', [{ name: 'readme.md', path: 'readme.md', directory: false }]);
	const tree = page.getByRole('tree', { name: 'Project files' });
	await expect(tree.getByRole('treeitem', { name: 'readme.md' })).toBeVisible();
	await drag(page, undefined, true);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'importFiles',
			0,
			new Error(
				"Error invoking remote method 'nido:importFiles': Error: Cannot place a folder inside itself."
			),
			true
		)
	);
	await expect(page.getByRole('alert')).toContainText('Cannot place a folder inside itself.');
	await drag(page, undefined, true);
	await page.evaluate(() => window.rendererTest.settle('importFiles', 0, ['photo.png', 'docs']));
	await list(page, '', [
		{ name: 'docs', path: 'docs', directory: true },
		{ name: 'photo.png', path: 'photo.png', directory: false },
		{ name: 'readme.md', path: 'readme.md', directory: false }
	]);
	await expect(tree.getByRole('treeitem', { name: 'photo.png' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});
