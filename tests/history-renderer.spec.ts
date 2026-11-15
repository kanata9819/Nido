import { test, expect } from './helpers/renderer-test';
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

const versions = [
	{ id: 'draft', timestamp: 1735689610000, kind: 'draft', bytes: 9, lines: 1 },
	{ id: 'saved', timestamp: 1735689600000, kind: 'saved', bytes: 6, lines: 1 }
];

test('Time Machine ignores late previews and keeps restore disabled until the selected revision is ready', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${origin}?view=history&defer=history,historyPreview,historyRestore`);
	await page.evaluate(
		(versions) =>
			window.rendererTest.settle('history', 0, { path: '/alpha/notes.txt', versions }),
		versions
	);
	const list = page.getByRole('listbox', { name: 'Edit history' });
	const restore = page.getByRole('button', { name: /Restore to editor/ });
	await expect(list).toBeFocused();
	await expect(restore).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'historyPreview')
						.length
			)
		)
		.toBe(1);
	await list.press('Home');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'historyPreview')
						.length
			)
		)
		.toBe(2);
	await page.evaluate(
		(version) =>
			window.rendererTest.settle('historyPreview', 1, {
				path: '/alpha/notes.txt',
				version,
				token: 'buffer:latest',
				diff: '@@ -1 +1 @@\n-old\n+selected draft',
				identical: false
			}),
		versions[0]
	);
	await expect(restore).toBeEnabled();
	await page.evaluate(
		(version) =>
			window.rendererTest.settle('historyPreview', 0, {
				path: '/alpha/notes.txt',
				version,
				token: 'stale',
				diff: '@@ -1 +1 @@\n-obsolete\n+wrong selection',
				identical: false
			}),
		versions[1]
	);
	await expect(page.locator('[data-git-scroll="after"]')).toContainText('selected draft');
	await expect(page.locator('[data-git-scroll="after"]')).not.toContainText('wrong selection');
	await list.press('Control+Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'historyRestore')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', '/alpha/notes.txt', 'draft', 'buffer:latest']]);
	await list.press('Control+Enter');
	expect(
		await page.evaluate(
			() =>
				window.rendererTest.calls.filter((call) => call.method === 'historyRestore').length
		)
	).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle(
			'historyRestore',
			0,
			new Error('The file changed. Refresh the preview before restoring.').message,
			true
		)
	);
	await expect(page.getByRole('alert')).toHaveText(
		'The file changed. Refresh the preview before restoring.'
	);
	expect(errors).toEqual([]);
});

test('ten thousand diff rows stay bounded in the DOM while scrolling and jumping between distant changes', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${origin}?view=highlight`);
	await page.evaluate(() =>
		window.rendererTest.render({
			diff:
				'@@ -1,10000 +1,10000 @@\n' +
				Array.from({ length: 10000 }, (_, i) =>
					i === 2 || i === 9500 ? `-old ${i}\n+changed ${i}` : ` row ${i}`
				).join('\n')
		})
	);
	const after = page.locator('[data-git-scroll="after"]');
	await expect(after).toContainText('changed 2');
	expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
	await after.focus();
	await after.press('n');
	await after.press('n');
	await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 9500');
	expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
	const positions = await page
		.locator('[data-git-scroll]')
		.evaluateAll((nodes) => nodes.map((node) => node.scrollTop));
	expect(Math.abs(positions[0] - positions[1])).toBeLessThanOrEqual(1);
	await after.press('Shift+N');
	await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 2');
	await page.getByRole('button', { name: 'Next change (n)', exact: true }).click();
	await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 9500');
	await expect(after).toBeFocused();
	await page.getByRole('button', { name: 'Previous change (N)', exact: true }).click();
	await expect(after.locator('[data-diff-active="true"]')).toContainText('changed 2');
	const tops = await page
		.locator('[data-git-scroll]')
		.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
	expect(tops[0]).toBe(tops[1]);
	await after.evaluate((node) => {
		node.scrollTop = 5000 * 22;
	});
	await expect(after).toContainText('row 5000');
	await after.evaluate((node) => {
		const original = document.querySelector<HTMLElement>('[data-git-scroll="before"]')!;
		original.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'N', shiftKey: true, bubbles: true })
		);
		node.scrollTop = 5000 * 22;
		original.dispatchEvent(new Event('scroll', { bubbles: true }));
	});
	await expect(after).toContainText('row 5000');
	await expect.poll(() => after.evaluate((node) => node.scrollTop)).toBe(5000 * 22);
	expect(await page.locator('[data-diff-row]').count()).toBeLessThan(200);
	const mounted = await page.locator('[data-diff-row]').count();
	console.log(`10,000-row diff: ${mounted} mounted rows across both panes (previously 20,000).`);
});

test('side-by-side diffs mirror horizontal scrolling from either pane', async ({ page }) => {
	await page.goto(`${origin}?view=highlight`);
	await page.evaluate(() =>
		window.rendererTest.render({
			diff: `@@ -1 +1 @@\n-old\n+${'long line '.repeat(40)}`
		})
	);
	const before = page.locator('[data-git-scroll="before"]');
	const after = page.locator('[data-git-scroll="after"]');
	const offsets = (): Promise<number[]> =>
		page
			.locator('pre[data-git-scroll]')
			.evaluateAll((panes) => panes.map((pane) => pane.scrollLeft));
	await before.evaluate((pane) => {
		pane.scrollLeft = 160;
	});
	await expect.poll(offsets).toEqual([160, 160]);
	await after.evaluate((pane) => {
		pane.scrollLeft = 80;
	});
	await expect.poll(offsets).toEqual([80, 80]);
	await after.press('v');
	await expect(before).toHaveCount(0);
	await after.press('v');
	await expect.poll(offsets).toEqual([80, 80]);
});

test('diff syntax colors follow excerpt positions when a hunk starts far into the file', async ({
	page
}) => {
	await page.goto(`${origin}?view=highlight&defer=highlightSources`);
	await page.evaluate(() =>
		window.rendererTest.render({
			diff: '@@ -50,2 +80,2 @@\n-const old = 1;\n+const next = 2;\n shared'
		})
	);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter(
						(call) => call.method === 'highlightSources'
					).length
			)
		)
		.toBeGreaterThan(0);
	await page.evaluate(() => {
		const pending = window.rendererTest.pending.filter(
			(call) => call.method === 'highlightSources'
		);
		window.rendererTest.settle('highlightSources', pending.length - 1, [
			[
				[{ text: 'const old = 1;', color: '#ff0000' }],
				[{ text: 'shared', color: '#0000ff' }]
			],
			[
				[{ text: 'const next = 2;', color: '#00ff00' }],
				[{ text: 'shared', color: '#0000ff' }]
			]
		]);
	});
	await expect(page.locator('[data-git-scroll="before"] code span').first()).toHaveCSS(
		'color',
		'rgb(255, 0, 0)'
	);
	await expect(page.locator('[data-git-scroll="after"] code span').first()).toHaveCSS(
		'color',
		'rgb(0, 255, 0)'
	);
	await expect(page.locator('[data-git-scroll="after"]')).toContainText('80');
});

test('diffs mark skipped lines and changed words, and v switches to an inline layout that is remembered', async ({
	page
}) => {
	await page.goto(`${origin}?view=highlight`);
	await page.evaluate(() => localStorage.removeItem('nido.diffLayout'));
	await page.evaluate(() =>
		window.rendererTest.render({
			diff:
				'@@ -10,3 +10,4 @@ function setup()\n' +
				' keep one\n-const wrap = false;\n+const wrap = true;\n+const extra = 1;\n keep two\n' +
				'@@ -40,2 +41,2 @@ function later()\n-old tail\n+new tail\n keep three'
		})
	);
	const after = page.locator('[data-git-scroll="after"]');
	const before = page.locator('[data-git-scroll="before"]');
	await expect(after).toContainText('const extra = 1;');
	// Separators say how many unchanged lines each hunk skips, with Git's context.
	await expect(after).toContainText('9 unchanged lines');
	await expect(after).toContainText('function setup()');
	await expect(after).toContainText('27 unchanged lines');
	await expect(after).toContainText('function later()');
	// Only the changed words of a replaced line are marked.
	await expect(before.locator('[class*="emphasis"]')).toHaveText(['false', 'old']);
	await expect(after.locator('[class*="emphasis"]')).toHaveText(['true', 'new']);
	await expect(page.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await after.focus();
	await after.press('v');
	// Inline, one pane shows the removed line above the added ones, with both line numbers.
	await expect(before).toHaveCount(0);
	await expect(after).toBeFocused();
	await expect(page.getByRole('button', { name: 'Inline' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	const lines = await after
		.locator('[data-diff-row] code')
		.evaluateAll((nodes) => nodes.map((node) => node.textContent));
	expect(lines).toEqual([
		'keep one',
		'const wrap = false;',
		'const wrap = true;',
		'const extra = 1;',
		'keep two',
		'old tail',
		'new tail',
		'keep three'
	]);
	await after.press('n');
	await expect(after.locator('[data-diff-active="true"]')).toContainText('const wrap = false;');
	expect(await page.evaluate(() => localStorage.getItem('nido.diffLayout'))).toBe('unified');
	await page.reload();
	await page.evaluate(() => window.rendererTest.render({ diff: '@@ -1 +1 @@\n-a\n+b' }));
	await expect(page.locator('[data-git-scroll="before"]')).toHaveCount(0);
	await page.getByRole('button', { name: 'Side by side' }).click();
	await expect(page.locator('[data-git-scroll="before"]')).toHaveCount(1);
	expect(await page.evaluate(() => localStorage.getItem('nido.diffLayout'))).toBe('split');
});
