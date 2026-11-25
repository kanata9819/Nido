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

const diagnosticItems = [
	{
		path: '/alpha/src/main.rs',
		line: 42,
		column: 18,
		severity: 1,
		source: 'rustc',
		code: 'E0277',
		message:
			'The trait bound `String: From<u8>` is not satisfied\n`String` implements `From<&str>`.\n\nConsider converting the byte to a character first.'
	},
	{
		path: '/alpha/src/main.rs',
		line: 42,
		column: 7,
		severity: 2,
		source: 'rustc',
		code: 'unused_parens',
		message:
			'Unnecessary parentheses around function argument\n`#[warn(unused_parens)]` is enabled by default.'
	}
];

async function showDiagnosticCard(page: Page): Promise<void> {
	await page.evaluate(
		(items) =>
			window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: true }),
		diagnosticItems
	);
}

test('diagnostic cards preserve brackets through Shift for first and last jumps', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await showDiagnosticCard(page);
	await expect(page.getByLabel('Diagnostic content', { exact: true })).toBeFocused();

	for (const bracket of ['[', ']']) {
		await page.keyboard.press(bracket);
		await page.keyboard.press('Shift+D');
	}
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual(['[D', ']D']);
});

test('native diagnostic cards show severity, source, codes and safe selectable text with keyboard navigation', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(editor).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'diagnostics',
			focus: true,
			id: 'other',
			items: [
				{
					path: '',
					line: 1,
					column: 1,
					severity: 1,
					source: '',
					code: '',
					message: 'Wrong workspace'
				}
			]
		})
	);
	const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
	await expect(popup).toHaveCount(0);
	await page.evaluate(
		(items) =>
			window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
		diagnosticItems
	);
	await expect(popup).toBeVisible();
	// A jump from the editor focuses the card so its scroll keys work.
	const content = page.getByLabel('Diagnostic content', { exact: true });
	await expect(content).toBeFocused();
	await showDiagnosticCard(page);
	await expect(content).toBeFocused();
	await expect(popup).toContainText('main.rs');
	await expect(popup).toContainText('Ln 42, Col 18');
	await expect(popup).toContainText('2 on this line');
	await expect(content.locator('article[data-severity="error"]')).toContainText('E0277');
	await expect(content.locator('article[data-severity="warning"]')).toContainText(
		'unused_parens'
	);
	await expect(content.locator('h3 code').first()).toHaveText('String: From<u8>');
	await content
		.locator('h3')
		.first()
		.evaluate((node) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
		});
	await page.keyboard.press('Control+c');
	await expect(popup).toBeVisible();
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	// y copies every diagnostic on the card as plain text and keeps the card open.
	await page.evaluate(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					(window as unknown as { copiedText: string }).copiedText = text;
				}
			}
		});
	});
	await page.keyboard.type('y');
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { copiedText?: string }).copiedText))
		.toBe(
			'main.rs:42:18: error[E0277] rustc: The trait bound `String: From<u8>` is not satisfied\n`String` implements `From<&str>`.\n\nConsider converting the byte to a character first.\n\n' +
				'main.rs:42:7: warning[unused_parens] rustc: Unnecessary parentheses around function argument\n`#[warn(unused_parens)]` is enabled by default.'
		);
	await expect(popup).toBeVisible();
	await expect(content).toBeFocused();
	await expect(
		popup.getByRole('button', { name: 'Copy diagnostics', exact: true })
	).toHaveAttribute('title', 'Copied (y)');
	await page.keyboard.type(']d');
	await page.keyboard.type('2[d');
	await page.keyboard.type(']');
	await page.evaluate(
		(items) =>
			window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
		diagnosticItems
	);
	await page.keyboard.type('d');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual([']d', '2[d', ']d']);
	await page.keyboard.press('Tab');
	await expect(
		popup.getByRole('button', { name: 'Copy diagnostics', exact: true })
	).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(
		popup.getByRole('button', { name: 'Previous diagnostic', exact: true })
	).toBeFocused();
	await page.keyboard.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args[1]
			)
		)
		.toBe('[d');
	await page.keyboard.press('Escape');
	await expect(popup).toHaveCount(0);
	await expect(editor).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'diagnostics',
			focus: true,
			id: 'alpha',
			items: [
				{
					path: '',
					line: 1,
					column: 1,
					severity: 4,
					source: '',
					code: '',
					message:
						'<script>window.diagnosticUnsafe = true</script>\n![Remote](https://example.com/image.png)'
				}
			]
		})
	);
	await expect(popup).toContainText('<script>');
	await expect(popup.locator('script, img, a')).toHaveCount(0);
	expect(await page.evaluate(() => 'diagnosticUnsafe' in window)).toBe(false);
	await page.keyboard.press('Control+c');
	await expect(popup).toHaveCount(0);
	await expect(editor).toBeFocused();
});

test('diagnostic cards scroll long messages, stay inside the editor and clear on replacement or invalidation', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(editor).toBeFocused();
	await page.evaluate(
		(items) =>
			window.rendererTest.emit({
				type: 'diagnostics',
				focus: true,
				id: 'alpha',
				items: [
					{
						...items[0],
						message:
							items[0].message + '\n' + 'Detailed compiler explanation.\n'.repeat(60)
					}
				]
			}),
		diagnosticItems
	);
	const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
	const content = page.getByLabel('Diagnostic content', { exact: true });
	await expect(content).toBeFocused();
	await page.keyboard.press('Control+d');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	await page.keyboard.press('End');
	await expect
		.poll(() =>
			content.evaluate((node) =>
				Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)
			)
		)
		.toBeLessThan(2);
	await page.keyboard.press('Home');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
	await page.setViewportSize({ width: 680, height: 460 });
	await expect
		.poll(() =>
			popup.evaluate((node) => {
				const host = node.parentElement!.getBoundingClientRect();
				const rect = node.getBoundingClientRect();
				return (
					rect.left >= host.left &&
					rect.top >= host.top &&
					rect.right <= host.right &&
					rect.bottom <= host.bottom
				);
			})
		)
		.toBe(true);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'hover',
			id: 'alpha',
			markdown: 'Replacement type information',
			filetype: 'rust',
			codeBlocks: []
		})
	);
	await expect(popup).toHaveCount(0);
	await expect(page.getByLabel('Type information content', { exact: true })).toBeFocused();
	await showDiagnosticCard(page);
	await expect(page.getByRole('dialog', { name: 'Type information', exact: true })).toHaveCount(
		0
	);
	await expect(content).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items: [], focus: false })
	);
	await expect(popup).toHaveCount(0);
	await expect(editor).toBeFocused();
	await showDiagnosticCard(page);
	await page.locator('canvas:visible').click({ position: { x: 2, y: 2 } });
	await expect(popup).toHaveCount(0);
	await expect(editor).toBeFocused();
});

test('type information ignores documentation failures from replaced or closed cards', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app&defer=openDocumentation`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	const card = page.getByRole('dialog', { name: 'Type information', exact: true });
	await expect(editor).toBeFocused();
	const show = async (markdown: string): Promise<void> => {
		await page.evaluate(
			(markdown) =>
				window.rendererTest.emit({
					type: 'hover',
					id: 'alpha',
					markdown,
					filetype: 'rust',
					codeBlocks: []
				}),
			markdown
		);
		await expect(card).toContainText(markdown.match(/\[([^\]]+)\]/)?.[1] || markdown);
	};
	await show('[Old docs](https://example.com/old)');
	await card.getByRole('link', { name: 'Old docs', exact: true }).click();
	await show('[Current docs](https://example.com/current)');
	await card.getByRole('link', { name: 'Current docs', exact: true }).click();
	await page.evaluate(() =>
		window.rendererTest.settle('openDocumentation', 0, 'Obsolete documentation failure', true)
	);
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(card.getByRole('alert')).toHaveCount(0);
	await page.evaluate(() =>
		window.rendererTest.settle('openDocumentation', 0, 'Current documentation failure', true)
	);
	await expect(card.getByRole('alert')).toHaveText('Current documentation failure');
	await show('[Closing docs](https://example.com/closing)');
	await card.getByRole('link', { name: 'Closing docs', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(card).toHaveCount(0);
	await expect(editor).toBeFocused();
	await show('A newly opened type card');
	await page.evaluate(() =>
		window.rendererTest.settle('openDocumentation', 0, 'Closed documentation failure', true)
	);
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	await expect(card.getByRole('alert')).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'openDocumentation')
				.map((call) => call.args)
		)
	).toEqual([
		['https://example.com/old'],
		['https://example.com/current'],
		['https://example.com/closing']
	]);
});

test('passive diagnostics return focus from replaced type information without stealing outside focus', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	const card = page.getByRole('dialog', { name: 'Type information', exact: true });
	const diagnostics = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
	const showType = async (): Promise<void> => {
		await page.evaluate(() =>
			window.rendererTest.emit({
				type: 'hover',
				id: 'alpha',
				markdown: 'Type details being read',
				filetype: 'rust',
				codeBlocks: []
			})
		);
		await expect(page.getByLabel('Type information content', { exact: true })).toBeFocused();
	};
	const showPassiveDiagnostics = async (): Promise<void> => {
		await page.evaluate(
			(items) =>
				window.rendererTest.emit({ type: 'diagnostics', id: 'alpha', items, focus: false }),
			diagnosticItems
		);
		await expect(card).toHaveCount(0);
		await expect(diagnostics).toBeVisible();
	};
	await expect(editor).toBeFocused();
	await showType();
	await showPassiveDiagnostics();
	await expect(page.getByLabel('Diagnostic content', { exact: true })).toBeFocused();
	// Any key other than the card's own closes it and reaches the editor.
	await page.keyboard.type('a');
	await expect(diagnostics).toHaveCount(0);
	await expect(editor).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args)
			)
		)
		.toEqual([['alpha', 'a']]);
	await showType();
	const settings = page.getByRole('button', { name: 'Settings', exact: true });
	await settings.focus();
	await showPassiveDiagnostics();
	await expect(settings).toBeFocused();
	await showType();
	await showDiagnosticCard(page);
	await expect(card).toHaveCount(0);
	await expect(page.getByLabel('Diagnostic content', { exact: true })).toBeFocused();
});

test('Japanese diagnostics use translated labels and leave compiler text intact', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
	await showDiagnosticCard(page);
	const popup = page.getByRole('dialog', { name: '診断の詳細', exact: true });
	await expect(popup).toContainText('エラー');
	await expect(popup).toContainText('警告');
	await expect(popup).toContainText('42 行、18 列');
	await expect(popup).toContainText('The trait bound');
	await expect(popup.getByRole('button', { name: '次の診断', exact: true })).toBeVisible();
});

test('scroll keys move type information and any other key closes it and continues in the editor', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	const card = page.getByRole('dialog', { name: 'Type information', exact: true });
	const content = page.getByLabel('Type information content', { exact: true });
	await expect(editor).toBeFocused();
	const show = (): Promise<void> =>
		page.evaluate(() =>
			window.rendererTest.emit({
				type: 'hover',
				id: 'alpha',
				markdown: Array.from({ length: 80 }, (_, line) => `Line ${line}`).join('\n\n'),
				filetype: 'rust',
				codeBlocks: []
			})
		);
	const inputs = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'input')
				.map((call) => call.args)
		);
	await show();
	await expect(content).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	await page.keyboard.press('ArrowUp');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
	await page.keyboard.press('j');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	await page.keyboard.press('k');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
	await page.keyboard.press('h');
	await page.keyboard.press('l');
	await page.keyboard.press('Control+d');
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	// Shift alone and Tab stay in the card.
	await page.keyboard.press('Shift');
	await page.keyboard.press('Tab');
	await expect(card).toBeVisible();
	expect(await inputs()).toEqual([]);
	for (const key of ['w', 'e', 'b', 'Shift+G', 'i', 'Enter', 'Control+o', ':']) {
		await show();
		await expect(content).toBeFocused();
		await page.keyboard.press(key);
		await expect(card).toHaveCount(0);
		await expect(editor).toBeFocused();
	}
	await expect
		.poll(inputs)
		.toEqual(['w', 'e', 'b', 'G', 'i', '<CR>', '<C-o>', ':'].map((key) => ['alpha', key]));
});

test('type information code uses the editor font', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'hover',
			id: 'alpha',
			markdown: '```rust\npub fn row(&self) -> usize\n```\n\nReturns the `row`.',
			filetype: 'rust',
			codeBlocks: []
		})
	);
	const card = page.getByRole('dialog', { name: 'Type information', exact: true });
	await expect(card).toContainText('pub fn row');
	const fonts = await card.evaluate((element) => ({
		editor: getComputedStyle(element).getPropertyValue('--editor-font').trim(),
		block: getComputedStyle(element.querySelector('pre code')!).fontFamily,
		inline: getComputedStyle(element.querySelector('p code')!).fontFamily
	}));
	expect(fonts.editor).not.toBe('');
	expect(fonts.block).not.toBe('monospace');
	// Compare as the browser normalizes the font list.
	const normalized = await page.evaluate((family) => {
		const probe = document.createElement('span');
		probe.style.fontFamily = family;
		document.body.append(probe);
		const value = getComputedStyle(probe).fontFamily;
		probe.remove();
		return value;
	}, fonts.editor);
	expect(fonts.block).toBe(normalized);
	expect(fonts.inline).toBe(normalized);
});

test('diagnostic cards scroll with their own keys and hand any other key to the editor', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.animations', 'false'));
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	const popup = page.getByRole('dialog', { name: 'Diagnostic details', exact: true });
	const content = page.getByLabel('Diagnostic content', { exact: true });
	await expect(editor).toBeFocused();
	const jump = (): Promise<void> =>
		page.evaluate(
			(items) =>
				window.rendererTest.emit({
					type: 'diagnostics',
					id: 'alpha',
					// A long list so the card can scroll.
					items: Array.from({ length: 20 }, () => items).flat(),
					focus: false
				}),
			diagnosticItems
		);
	const inputs = (): Promise<unknown[]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'input')
				.map((call) => call.args[1])
		);
	await jump();
	await expect(content).toBeFocused();
	for (const key of ['j', 'ArrowDown', 'Control+d']) {
		await page.keyboard.press(key);
	}
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
	for (const key of ['k', 'h', 'l', 'ArrowUp', 'Home', 'Shift']) {
		await page.keyboard.press(key);
	}
	await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
	await expect(popup).toBeVisible();
	expect(await inputs()).toEqual([]);
	// A pending count or bracket travels with the key that ends it.
	for (const keys of ['w', '3w', ']x', 'i']) {
		await jump();
		await expect(content).toBeFocused();
		await page.keyboard.type(keys);
		await expect(popup).toHaveCount(0);
		await expect(editor).toBeFocused();
	}
	await expect.poll(inputs).toEqual(['w', '3w', ']x', 'i']);
	// Focus outside the editor stays where it is.
	const settings = page.getByRole('button', { name: 'Settings', exact: true });
	await settings.focus();
	await jump();
	await expect(popup).toBeVisible();
	await expect(settings).toBeFocused();
});

test('diagnostic cards forward uppercase Y without copying diagnostics', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(editor).toBeFocused();
	await page.evaluate(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async () => {
					document.body.dataset.copiedDiagnostics = 'true';
				}
			}
		});
	});
	await showDiagnosticCard(page);
	await expect(page.getByLabel('Diagnostic content', { exact: true })).toBeFocused();

	await page.keyboard.press('Shift+Y');
	await expect(editor).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual(['Y']);
	expect(await page.evaluate(() => document.body.dataset.copiedDiagnostics)).toBeUndefined();
});
