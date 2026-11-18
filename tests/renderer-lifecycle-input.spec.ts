import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import type {} from './renderer/harness';
import { recordedWindowActions } from './helpers/renderer-lifecycle-shared';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

const windowCommands = [
	{
		key: '-',
		stroke: 'Minus',
		action: 'minimize',
		en: 'Minimize window',
		ja: 'ウィンドウを最小化'
	},
	{
		key: '+',
		stroke: 'Shift+Equal',
		action: 'maximize',
		en: 'Maximize or restore window',
		ja: 'ウィンドウを最大化・元に戻す'
	},
	{ key: 'q', stroke: 'q', action: 'close', en: 'Quit Nido', ja: 'Nidoを終了' }
] as const;

for (const language of ['en', 'ja'] as const) {
	test(`window commands show translated leader keys and return editor focus in ${language}`, async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 850, height: 560 });
		await page.addInitScript((language) => {
			localStorage.setItem('nido.language', language);
			localStorage.setItem('nido.animations', 'false');
		}, language);
		await page.goto(`${origin}?view=app`);
		const input = page.getByRole('textbox', {
			name: language === 'ja' ? 'Neovim入力' : 'Neovim input',
			exact: true
		});
		const guide = page.getByRole('dialog', {
			name: language === 'ja' ? 'キーボードコマンド' : 'Keyboard commands',
			exact: true
		});
		const palette = page.getByRole('dialog', {
			name: language === 'ja' ? 'すべてのコマンド' : 'commands palette',
			exact: true
		});
		await expect(input).toBeFocused();
		const expected: string[][] = [];
		for (const command of windowCommands) {
			await page.keyboard.press('Space');
			await expect(guide).toBeVisible();
			const layout = await guide.evaluate((node) => {
				const bounds = node.getBoundingClientRect();
				return {
					inViewport:
						bounds.x >= 0 &&
						bounds.y >= 0 &&
						bounds.right <= innerWidth &&
						bounds.bottom <= innerHeight,
					wrapped: [...node.querySelectorAll('button')]
						.filter((button) =>
							[...button.childNodes].some((child) => {
								if (
									child.nodeType !== Node.TEXT_NODE ||
									!child.textContent?.trim()
								) {
									return false;
								}
								const range = document.createRange();
								range.selectNodeContents(child);
								return range.getClientRects().length > 1;
							})
						)
						.map((button) => button.textContent),
					clipped: [...node.querySelectorAll('button')]
						.filter((button) => {
							const range = document.createRange();
							range.selectNodeContents(button);
							const content = range.getBoundingClientRect();
							const box = button.getBoundingClientRect();
							return (
								button.scrollWidth > button.clientWidth + 1 ||
								button.scrollHeight > button.clientHeight + 1 ||
								content.left < box.left - 1 ||
								content.right > box.right + 1 ||
								content.top < box.top - 1 ||
								content.bottom > box.bottom + 1
							);
						})
						.map((button) => button.textContent)
				};
			});
			expect(layout).toEqual({ inViewport: true, wrapped: [], clipped: [] });
			if (command.key === '-') {
				await page.screenshot({
					path: testInfo.outputPath(`window-guide-${language}.png`)
				});
			}
			for (const entry of windowCommands) {
				const button = guide.getByRole('button').filter({ hasText: entry[language] });
				await expect(button).toHaveCount(1);
				await expect(button.locator('kbd')).toHaveText(entry.key);
			}
			await page.keyboard.press(command.stroke);
			expected.push([command.action]);
			await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
			await expect(guide).toHaveCount(0);
			await expect(palette).toHaveCount(0);
			await expect(input).toBeFocused();
		}
		for (const command of windowCommands) {
			await page.keyboard.press('Control+Shift+p');
			await expect(palette).toBeVisible();
			const filter = page.getByRole('textbox', {
				name: language === 'ja' ? '項目を絞り込む' : 'Filter items',
				exact: true
			});
			await filter.fill(command[language]);
			await expect(
				palette.getByRole('button').filter({ hasText: command[language] })
			).toHaveCount(1);
			await filter.press('Enter');
			expected.push([command.action]);
			await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
			await expect(palette).toHaveCount(0);
			await expect(guide).toHaveCount(0);
			await expect(input).toBeFocused();
		}
	});
}

for (const view of ['welcome', 'terminal'] as const) {
	test(`window commands remain available from the ${view} command palette`, async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('nido.language', 'en');
			localStorage.setItem('nido.animations', 'false');
		});
		await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
		await page.evaluate((view) => {
			window.rendererTest.settle('restoreWorkspaces', 0, {
				workspaces:
					view === 'terminal'
						? [{ id: 'shell', root: '/alpha', name: 'Shell', kind: 'terminal' }]
						: [],
				active: view === 'terminal' ? 'shell' : '',
				errors: []
			});
		}, view);
		if (view === 'terminal') {
			await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
		} else {
			await expect(
				page.getByRole('heading', { name: 'Make yourself at home.' })
			).toBeVisible();
		}
		const expected: string[][] = [];
		for (const command of windowCommands) {
			await page.keyboard.press('Control+Shift+p');
			const palette = page.getByRole('dialog', { name: 'commands palette', exact: true });
			await expect(palette).toBeVisible();
			const filter = page.getByRole('textbox', { name: 'Filter items', exact: true });
			await filter.fill(command.en);
			await expect(palette.getByRole('button').filter({ hasText: command.en })).toHaveCount(
				1
			);
			await filter.press('Enter');
			expected.push([command.action]);
			await expect.poll(() => recordedWindowActions(page)).toEqual(expected);
			await expect(palette).toHaveCount(0);
			if (view === 'terminal') {
				await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
			}
		}
	});
}

test('window commands preserve Insert-mode spaces and punctuation during a pending mode check', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.type(' -+q');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.pending.filter((call) => call.method === 'inputMode')
						.length
			)
		)
		.toBe(1);
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
					.join('')
			)
		)
		.toBe(' -+q');
	expect(await recordedWindowActions(page)).toEqual([]);
	await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('window commands leave IME-owned spaces and punctuation with composition', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	const accepted = await input.evaluate((node: HTMLTextAreaElement) => {
		node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		const accepted = [' ', '-', '+', 'q'].map((key) =>
			node.dispatchEvent(
				new KeyboardEvent('keydown', {
					key,
					keyCode: 229,
					isComposing: true,
					bubbles: true,
					cancelable: true
				})
			)
		);
		node.value = ' -+q 日本語';
		node.dispatchEvent(
			new InputEvent('input', {
				data: node.value,
				inputType: 'insertCompositionText',
				isComposing: true,
				bubbles: true
			})
		);
		node.dispatchEvent(
			new CompositionEvent('compositionend', { data: node.value, bubbles: true })
		);
		return accepted;
	});
	expect(accepted).toEqual([true, true, true, true]);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual([' -+q 日本語']);
	expect(await recordedWindowActions(page)).toEqual([]);
	await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('window commands preserve AltGr spaces and punctuation as editor input', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	await input.evaluate((node) => {
		for (const key of [' ', '-', '+', 'q']) {
			node.dispatchEvent(
				new KeyboardEvent('keydown', {
					key,
					ctrlKey: true,
					altKey: true,
					modifierAltGraph: true,
					bubbles: true,
					cancelable: true
				})
			);
		}
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
					.join('')
			)
		)
		.toBe(' -+q');
	expect(await recordedWindowActions(page)).toEqual([]);
	await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('IME transition keys stay with composition before its start and after its commit', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	const prevented = await input.evaluate((node: HTMLTextAreaElement) => {
		const imeKey = (key: string): boolean =>
			!node.dispatchEvent(
				new KeyboardEvent('keydown', {
					key,
					keyCode: 229,
					bubbles: true,
					cancelable: true
				})
			);
		const before = imeKey('a');
		node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		node.value = '日本語<入力>';
		node.dispatchEvent(
			new InputEvent('input', {
				data: node.value,
				inputType: 'insertCompositionText',
				isComposing: true,
				bubbles: true
			})
		);
		node.dispatchEvent(
			new CompositionEvent('compositionend', { data: node.value, bubbles: true })
		);
		return [before, imeKey('Enter')];
	});
	expect(prevented, 'the browser must keep control of IME-owned key events').toEqual([
		false,
		false
	]);
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual(['日本語<LT>入力>']);
	await expect(input).toHaveValue('');
});

test('interrupted IME input recovers on focus return and ignores an obsolete commit', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	for (const boundary of ['element', 'window']) {
		await input.evaluate((node: HTMLTextAreaElement, boundary) => {
			node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			node.value = '未確定';
			if (boundary === 'element') node.blur();
			else window.dispatchEvent(new Event('blur'));
		}, boundary);
		await input.focus();
		await page.keyboard.type('az');
		const expected = boundary === 'element' ? ['a', 'z'] : ['a', 'z', 'a', 'z'];
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'input')
						.map((call) => call.args[1])
				)
			)
			.toEqual(expected);
		await input.evaluate((node: HTMLTextAreaElement) =>
			node.dispatchEvent(
				new CompositionEvent('compositionend', { data: '未確定', bubbles: true })
			)
		);
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		).toEqual(expected);
		await expect(input).toHaveValue('');
	}
});

test('native IME text is visible as it changes and only committed text reaches Neovim', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	const ime = await page.context().newCDPSession(page);
	try {
		let previousWidth = 0;
		for (const text of ['に', 'にほ', '日本語<入力>']) {
			await ime.send('Input.imeSetComposition', {
				text,
				selectionStart: text.length,
				selectionEnd: text.length
			});
			await expect(input).toHaveValue(text);
			await expect(input).toHaveCSS('opacity', '1');
			await expect(input).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
			const width = await input.evaluate((node) => node.clientWidth);
			expect(width).toBeGreaterThan(previousWidth);
			previousWidth = width;
			expect(
				await page.evaluate(() =>
					window.rendererTest.calls.filter((call) => call.method === 'input')
				)
			).toEqual([]);
		}
		await page.screenshot({ path: test.info().outputPath('japanese-composition.png') });
		await ime.send('Input.insertText', { text: '日本語<入力>' });
		await expect(input).toHaveValue('');
		await expect(input).not.toHaveAttribute('data-composing');
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		).toEqual(['日本語<LT>入力>']);
		await ime.send('Input.imeSetComposition', {
			text: '未確定',
			selectionStart: 3,
			selectionEnd: 3
		});
		await expect(input).toHaveCSS('opacity', '1');
		const longText = '未確定の日本語'.repeat(100);
		await ime.send('Input.imeSetComposition', {
			text: longText,
			selectionStart: longText.length,
			selectionEnd: longText.length
		});
		expect(await input.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
		expect(await input.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
		expect(
			await input.evaluate(
				(node) =>
					node.getBoundingClientRect().right <=
					node.parentElement!.getBoundingClientRect().right + 1
			)
		).toBe(true);
		await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
		await expect(input).toHaveValue('');
		await expect(input).not.toHaveAttribute('data-composing');
		expect(
			await page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		).toEqual(['日本語<LT>入力>']);
	} finally {
		await ime.detach();
	}
});

test('native IME commits remain intact when editor focus moves', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	const ime = await page.context().newCDPSession(page);
	try {
		await ime.send('Input.imeSetComposition', {
			text: '日本語<入力>',
			selectionStart: 7,
			selectionEnd: 7
		});
		await ime.send('Input.insertText', { text: '日本語<入力>' });
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'input')
						.map((call) => call.args[1])
				)
			)
			.toEqual(['日本語<LT>入力>']);
		await ime.send('Input.imeSetComposition', {
			text: '次の入力',
			selectionStart: 4,
			selectionEnd: 4
		});
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'input')
						.map((call) => call.args[1])
				)
			)
			.toEqual(['日本語<LT>入力>', '次の入力']);
	} finally {
		await ime.detach();
	}
});

test('blocked editors ignore late text, composition commits and paste events', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	await input.dispatchEvent('compositionstart');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
	await input.evaluate((node: HTMLTextAreaElement) => {
		node.dispatchEvent(
			new CompositionEvent('compositionend', { data: '遅れて確定', bubbles: true })
		);
		node.value = 'late text';
		node.dispatchEvent(new InputEvent('input', { bubbles: true }));
		const clipboard = new DataTransfer();
		clipboard.setData('text/plain', 'late paste');
		node.dispatchEvent(
			new ClipboardEvent('paste', {
				clipboardData: clipboard,
				bubbles: true,
				cancelable: true
			})
		);
	});
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls.filter((call) => ['input', 'paste'].includes(call.method))
		)
	).toEqual([]);
	await expect(input).toHaveValue('');
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await page.keyboard.type('az');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
			)
		)
		.toEqual(['a', 'z']);
});

test('hidden editors discard late IME input while another workspace accepts typing', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta' }
			],
			active: 'alpha',
			errors: []
		})
	);
	const alpha = page.locator('[data-editor-input="editor"]').first();
	await expect(alpha).toBeFocused();
	await alpha.dispatchEvent('compositionstart');
	await page.keyboard.press('Alt+2');
	const beta = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(beta).toBeFocused();
	await alpha.evaluate((node: HTMLTextAreaElement) => {
		node.dispatchEvent(
			new CompositionEvent('compositionend', { data: '前の作業', bubbles: true })
		);
		node.value = 'obsolete';
		node.dispatchEvent(new InputEvent('input', { bubbles: true }));
	});
	await page.keyboard.type('az');
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args)
			)
		)
		.toEqual([
			['beta', 'a'],
			['beta', 'z']
		]);
	await page.keyboard.press('Alt+1');
	await expect(alpha).toBeFocused();
	await expect(alpha).toHaveValue('');
});

test('switching workspaces drops keys waiting for the previous editor mode', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces,inputMode`);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [
				{ id: 'alpha', root: '/alpha', name: 'Alpha' },
				{ id: 'beta', root: '/beta', name: 'Beta' }
			],
			active: 'alpha',
			errors: []
		})
	);
	const pending = (): Promise<unknown[]> =>
		page.evaluate(() =>
			window.rendererTest.pending
				.filter((call) => call.method === 'inputMode')
				.map(({ args }) => args[0])
		);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	await page.keyboard.type(' x');
	await expect.poll(pending).toEqual(['alpha']);
	await page.getByRole('tab', { name: 'Workspace Beta' }).click();
	await expect(input).toBeFocused();
	await page.keyboard.type('b z');
	await expect.poll(pending).toEqual(['alpha', 'beta']);
	await page.evaluate(() => {
		window.rendererTest.settle('inputMode', 0, 'i');
		window.rendererTest.settle('inputMode', 0, 'i');
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest.calls
					.filter((call) => call.method === 'input')
					.map(({ args }) => args)
			)
		)
		.toEqual([
			['beta', 'b'],
			['beta', ' '],
			['beta', 'z']
		]);
});

test('moving focus leaves a pending editor mode check behind', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	await page.keyboard.type(' x');
	await expect
		.poll(() => page.evaluate(() => window.rendererTest.pending[0]?.method))
		.toBe('inputMode');
	const settings = page.getByRole('button', { name: 'Settings', exact: true });
	await settings.press('Enter');
	const option = page.getByRole('checkbox', { name: 'Cursor follows scrolling' });
	await expect(option).toBeVisible();
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
	await expect(option).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.rendererTest.calls.filter(({ method }) => method === 'input')
		)
	).toEqual([]);
});

test('canvas clicks keep their place between earlier and later editor input', async ({ page }) => {
	await page.clock.install();
	await page.goto(`${origin}?view=app&defer=click`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	await expect(page.getByLabel('Neovim editor display')).toHaveAttribute(
		'aria-description',
		/./s
	);
	await page.clock.runFor(50);
	const actions = (): Promise<string[]> =>
		page.evaluate(() =>
			window.rendererTest.calls.flatMap(({ method, args }) => {
				if (method === 'input') return [String(args[1])];
				return ['click', 'paste', 'save', 'inputMode'].includes(method) ? [method] : [];
			})
		);
	await page.evaluate(() => {
		const input = document.querySelector('textarea[data-editor-input="editor"]')!;
		const canvas = document.querySelector('canvas[aria-label="Neovim editor display"]')!;
		const bounds = canvas.getBoundingClientRect();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
		canvas.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				clientX: bounds.left + 50,
				clientY: bounds.top + 30
			})
		);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
		const text = new DataTransfer();
		text.setData('text/plain', 'pasted after click');
		input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: text }));
		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })
		);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
	});
	await page.clock.runFor(50);
	await expect.poll(actions).toEqual(['h', 'click']);
	await page.evaluate(() => window.rendererTest.settle('click', 0, undefined));
	await expect.poll(actions).toEqual(['h', 'click', 'x', 'paste', 'save', 'inputMode']);
});

test('Rapid insert text keeps spaces and following keys while a mode check is pending', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await expect(input).toBeFocused();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['mode_change', ['normal', 0]]]
		})
	);
	await page.keyboard.type('Go## Unsaved heading');
	await input.evaluate((node) =>
		node.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: '@',
				code: 'KeyQ',
				ctrlKey: true,
				altKey: true,
				modifierAltGraph: true,
				bubbles: true,
				cancelable: true
			})
		)
	);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'i'));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
					.join('')
			)
		)
		.toBe('Go## Unsaved heading@');
	await expect(page.getByRole('dialog', { name: 'Keyboard commands' })).toHaveCount(0);
});

test('Rapid Normal-mode menu keys open the debugger and keep its focus', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
	await page.keyboard.type(' D');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'n'));
	const debuggerPanel = page.getByRole('region', { name: 'Debugger', exact: true });
	await expect(debuggerPanel).toBeVisible();
	await expect
		.poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
		.toBe(true);
	await page.keyboard.press('Space');
	await page.keyboard.press('d');
	await expect(debuggerPanel).toHaveCount(0);
	await page.keyboard.press('Control+Shift+p');
	await page.getByRole('textbox', { name: 'Filter items' }).fill('Open debug panel');
	await page.keyboard.press('Enter');
	await expect(debuggerPanel).toBeVisible();
	await expect
		.poll(() => debuggerPanel.evaluate((node) => node.contains(document.activeElement)))
		.toBe(true);
});
