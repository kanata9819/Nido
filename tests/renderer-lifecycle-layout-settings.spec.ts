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

test('font family migrates the previous default while preserving custom settings', async ({
	page
}) => {
	const previousDefault = '"Cascadia Code", "Consolas", "Yu Gothic UI", monospace';
	const currentDefault = '"Cascadia Code", "Consolas", "Meiryo", "Yu Gothic UI", monospace';
	const cases = [
		{ saved: null, expected: currentDefault },
		{ saved: previousDefault, expected: currentDefault },
		{
			saved: '"Cascadia Code", "Yu Gothic UI", monospace',
			expected: '"Cascadia Code", "Yu Gothic UI", monospace'
		},
		{ saved: 'Consolas', expected: 'Consolas' },
		{ saved: '', expected: '' }
	];

	await page.goto(origin);
	for (const { saved, expected } of cases) {
		await page.evaluate((family) => {
			localStorage.clear();
			localStorage.setItem('nido.language', 'en');
			if (family !== null) localStorage.setItem('nido.fontFamily', family);
		}, saved);
		await page.goto(`${origin}?view=app`);
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		const input = page.getByRole('textbox', { name: 'Font family', exact: true });
		await expect(input).toHaveValue(expected);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('nido.fontFamily')))
			.toBe(expected);

		await page.reload();
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(input).toHaveValue(expected);
	}

	// After migration, explicitly selecting the former default must stick.
	const input = page.getByRole('textbox', { name: 'Font family', exact: true });
	await input.fill(previousDefault);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('nido.fontFamily')))
		.toBe(previousDefault);
	await page.reload();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(input).toHaveValue(previousDefault);
});

test('Extensions opens without a workspace, searches language packs and restores navigation focus', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: [],
			active: '',
			errors: []
		})
	);
	const trigger = page.getByRole('button', { name: 'Extensions', exact: true });
	await trigger.click();
	const extensions = page.getByRole('region', { name: 'Extensions', exact: true });
	const search = extensions.getByRole('textbox', { name: 'Search language packs' });
	await expect(search).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-pressed', 'true');
	await expect(extensions.locator('[data-pack]')).toHaveCount(2);
	await expect(extensions.getByRole('tab')).toHaveText(['Languages', 'Other extensions']);
	await expect(extensions.locator('[data-feature], [data-language]')).toHaveCount(0);
	await search.fill('Deno');
	await expect(extensions.locator('[data-pack]')).toHaveCount(0);
	await search.fill('.rs');
	await expect(extensions.locator('[data-pack]')).toHaveCount(1);
	await expect(extensions.locator('[data-pack="rust"]')).toBeVisible();
	await search.fill('does-not-exist');
	await expect(extensions.getByText('No language packs match your search.')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(extensions).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await page.keyboard.press('Control+Shift+x');
	await expect(extensions).toBeVisible();
	await page.keyboard.press('Control+Shift+x');
	await expect(extensions).toHaveCount(0);
});

test('Extensions shortcut preserves the editor and supports Japanese and command palette access', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('nido.language', 'ja'));
	await page.goto(`${origin}?view=app`);
	const editor = page.getByRole('textbox', { name: 'Neovim入力' });
	await expect(
		page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
	).toBeVisible();
	await page.keyboard.press('Control+Shift+x');
	const extensions = page.getByRole('region', { name: '拡張機能', exact: true });
	const search = extensions.getByRole('textbox', { name: '言語パックを検索' });
	await expect(search).toBeFocused();
	await search.fill('診断');
	await expect(extensions.locator('[data-pack]')).toHaveCount(2);
	await extensions.getByRole('tab', { name: 'その他の拡張', exact: true }).click();
	await expect(extensions.locator('[data-pack="deno"]')).toContainText('Denoの導入が必要');
	await expect(extensions.getByRole('textbox', { name: 'その他の拡張を検索' })).toHaveValue('');
	await expect(
		extensions.getByRole('button', { name: '拡張機能を追加', exact: true })
	).toBeVisible();
	await expect(extensions.locator('[data-feature]')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
	await expect(
		page.getByRole('tab', { name: 'ワークスペース Alpha', exact: true })
	).toBeVisible();
	await page.keyboard.press('Control+Shift+p');
	const palette = page.getByRole('dialog', { name: 'すべてのコマンド' });
	await palette.getByRole('textbox').fill('拡張');
	await palette.getByRole('button', { name: /拡張機能/ }).click();
	await expect(extensions).toBeVisible();
	await extensions.getByRole('button', { name: '拡張機能を閉じる' }).click();
	await expect(editor).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) =>
						['input', 'closeWorkspace', 'openFile'].includes(call.method)
					).length
			)
		)
		.toBe(0);
});

test('Extensions separates language packs from other extensions and supports keyboard tabs', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await page.keyboard.press('Control+Shift+x');
	const extensions = page.getByRole('region', { name: 'Extensions', exact: true });
	const languagesTab = extensions.getByRole('tab', { name: 'Languages', exact: true });
	await expect(languagesTab).toHaveAttribute('aria-selected', 'true');
	await expect(extensions.locator('[data-pack]')).toHaveCount(2);
	const search = extensions.getByRole('textbox', { name: 'Search language packs' });
	await search.fill('Rust');
	await expect(extensions.locator('[data-pack]')).toHaveCount(1);
	await languagesTab.focus();
	await page.keyboard.press('ArrowRight');
	const otherTab = extensions.getByRole('tab', { name: 'Other extensions', exact: true });
	await expect(otherTab).toBeFocused();
	await expect(otherTab).toHaveAttribute('aria-selected', 'true');
	await expect(extensions.getByRole('tabpanel', { name: 'Other extensions' })).toBeVisible();
	await expect(extensions.locator('[data-pack]')).toHaveCount(2);
	await expect(extensions.locator('[data-pack="github"]')).toBeVisible();
	await expect(extensions.locator('[data-pack="deno"]')).toBeVisible();
	const otherSearch = extensions.getByRole('textbox', { name: 'Search other extensions' });
	await expect(otherSearch).toHaveValue('');
	await otherSearch.fill('Rust');
	await expect(extensions.getByText('No extensions match your search.')).toBeVisible();
	await otherSearch.fill('Deno');
	await expect(extensions.locator('[data-pack="deno"]')).toBeVisible();
	await otherTab.focus();
	await page.keyboard.press('ArrowRight');
	await expect(languagesTab).toBeFocused();
	await expect(search).toHaveValue('');
	await expect(extensions.locator('[data-pack]')).toHaveCount(2);
	await page.keyboard.press('ArrowLeft');
	await expect(otherTab).toBeFocused();
	await page.keyboard.press('Home');
	await expect(languagesTab).toBeFocused();
	await page.keyboard.press('End');
	await expect(otherTab).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Neovim input' })).toBeFocused();
});

test('compact mode keeps every session visible and fixes bar heights during hover and keyboard navigation', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
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
	const header = page.getByRole('banner');
	const alpha = header.getByRole('tab', { name: 'Workspace Alpha', exact: true });
	const beta = header.getByRole('tab', { name: 'Workspace Beta', exact: true });
	const editor = page.getByRole('textbox', { name: 'Neovim input' });
	const files = page.getByRole('tablist', { name: 'Files', exact: true });
	const status = page.getByRole('contentinfo');
	const layout = (): Promise<unknown[]> =>
		Promise.all(
			[header, files, status, page.locator('main')].map((element) => element.boundingBox())
		);
	await expect(editor).toBeFocused();
	await expect(header).toHaveCSS('height', '38px');
	await expect(files).toHaveCSS('height', '34px');
	await expect(status).toHaveCSS('height', '32px');
	await expect(beta).toBeVisible();
	const normalEditorTop = (await page.locator('main').boundingBox())!.y;
	await header.getByRole('button', { name: 'Settings', exact: true }).click();
	const option = page.getByRole('checkbox', { name: 'Compact mode' });
	await expect(option).not.toBeChecked();
	await option.check();
	await page.keyboard.press('Escape');
	await page.mouse.move(500, 300);
	await expect(beta).toBeVisible();
	await expect(alpha).toBeVisible();
	await expect(header).toHaveCSS('height', '24px');
	await expect(files).toHaveCSS('height', '28px');
	await expect(status).toHaveCSS('height', '26px');
	expect((await page.locator('main').boundingBox())!.y).toBe(normalEditorTop - 14);
	const compactLayout = await layout();
	await alpha.hover();
	await expect(beta).toBeVisible();
	expect(await layout()).toEqual(compactLayout);
	await beta.hover();
	expect(await layout()).toEqual(compactLayout);
	await page.mouse.move(500, 300);
	expect(await layout()).toEqual(compactLayout);
	await page.keyboard.press('Alt+Shift+w');
	await expect(alpha).toBeFocused();
	await expect(beta).toBeVisible();
	expect(await layout()).toEqual(compactLayout);
	for (
		let step = 0;
		step < 8 && !(await beta.evaluate((button) => button === document.activeElement));
		step++
	) {
		await page.keyboard.press('Tab');
	}
	await expect(beta).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(beta).toHaveAttribute('aria-selected', 'true');
	await expect(editor).toBeFocused();
	await expect(alpha).toBeVisible();
	await page.keyboard.press('Alt+Shift+w');
	await expect(beta).toBeFocused();
	const minimize = header.getByRole('button', { name: 'Minimize', exact: true });
	for (
		let step = 0;
		step < 16 && !(await minimize.evaluate((button) => button === document.activeElement));
		step++
	) {
		await page.keyboard.press('Tab');
	}
	for (const [index, name] of ['Minimize', 'Maximize', 'Close Nido'].entries()) {
		if (index) {
			await page.keyboard.press('Tab');
		}
		await expect(header.getByRole('button', { name, exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
	}
	expect(await recordedWindowActions(page)).toEqual([['minimize'], ['maximize'], ['close']]);
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
	await expect(alpha).toBeVisible();
	expect(await layout()).toEqual(compactLayout);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
		.toBe('true');
});

test('compact mode migrates the old setting and respects a saved disabled value after restarting in Japanese', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem('nido.autoHideSessionTabs', 'true');
		localStorage.setItem('nido.language', 'ja');
	});
	await page.goto(`${origin}?view=app`);
	const header = page.getByRole('banner');
	await expect(page.getByRole('textbox', { name: 'Neovim入力' })).toBeFocused();
	await page.mouse.move(500, 300);
	expect((await header.boundingBox())!.height).toBe(24);
	await header.getByRole('button', { name: '設定', exact: true }).click();
	const option = page.getByRole('checkbox', { name: 'コンパクトモード' });
	await expect(option).toBeChecked();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
		.toBe('true');
	await option.uncheck();
	await page.keyboard.press('Escape');
	expect((await header.boundingBox())!.height).toBe(38);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('nido.compactMode')))
		.toBe('false');
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Neovim入力' })).toBeFocused();
	await expect(header).toHaveCSS('height', '38px');
	await expect(page.getByRole('tablist', { name: 'ファイル', exact: true })).toHaveCSS(
		'height',
		'34px'
	);
	await expect(page.getByRole('contentinfo')).toHaveCSS('height', '32px');
});

test('compact mode scrolls the active session into view after selection or reordering', async ({
	page
}) => {
	await page.setViewportSize({ width: 720, height: 600 });
	await page.addInitScript(() => localStorage.setItem('nido.compactMode', 'true'));
	await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() =>
		window.rendererTest.settle('restoreWorkspaces', 0, {
			workspaces: Array.from({ length: 12 }, (_, i) => ({
				id: `session-${i}`,
				root: `/session-${i}`,
				name: `Session ${i + 1}`
			})),
			active: 'session-11',
			errors: []
		})
	);
	const tabs = page.getByRole('tablist', { name: 'Workspaces', exact: true });
	await expect(tabs.getByRole('tab')).toHaveCount(12);
	for (const [index, key] of [
		[11, ''],
		[0, 'Alt+1'],
		[8, 'Alt+9'],
		[8, 'Alt+Shift+PageDown']
	] as const) {
		if (key) await page.keyboard.press(key);
		const selected = tabs.getByRole('tab', {
			name: `Workspace Session ${index + 1}`,
			exact: true
		});
		await expect(selected).toHaveAttribute('aria-selected', 'true');
		await expect
			.poll(() =>
				selected.evaluate((element) => {
					const tab = element.getBoundingClientRect();
					const list = element.closest('[role="tablist"]')!.getBoundingClientRect();
					return tab.left >= list.left - 1 && tab.right <= list.right + 1;
				})
			)
			.toBe(true);
	}
	await expect(tabs.getByRole('tab').nth(9)).toHaveAccessibleName('Workspace Session 9');
	await expect(page.getByRole('banner')).toHaveCSS('height', '24px');
});

test('activity bar moves above the explorer, preserves navigation and persists its placement', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
	const explorer = page.getByRole('complementary', { name: 'File explorer' });
	await expect(navigation).toHaveAttribute('data-position', 'left');
	const titlebar = page.getByRole('banner');
	for (const name of ['Command palette', 'Settings']) {
		await expect(navigation.getByRole('button', { name, exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
		const button = (await titlebar.getByRole('button', { name, exact: true }).boundingBox())!;
		const minimize = (await titlebar.getByRole('button', { name: 'Minimize' }).boundingBox())!;
		expect(button.x + button.width).toBeLessThanOrEqual(minimize.x);
		expect(button.y + button.height / 2).toBe(minimize.y + minimize.height / 2);
	}
	await titlebar.getByRole('button', { name: 'Command palette', exact: true }).click();
	const commands = page.getByRole('dialog', { name: 'commands palette', exact: true });
	await expect(commands).toBeVisible();
	await commands.getByRole('button', { name: 'Close palette' }).click();
	await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('combobox', { name: 'Activity bar position' }).selectOption('top');
	await page.keyboard.press('Escape');
	await expect(navigation).toHaveAttribute('data-position', 'top');
	await expect
		.poll(async () => {
			const bar = (await navigation.boundingBox())!;
			const side = (await explorer.boundingBox())!;
			const editor = (await page.locator('main').boundingBox())!;
			return {
				sameLeft: bar.x === side.x,
				sameWidth: bar.width === side.width,
				above: bar.y + bar.height <= side.y,
				editorBeside: editor.x >= side.x + side.width
			};
		})
		.toEqual({ sameLeft: true, sameWidth: true, above: true, editorBeside: true });
	await expect(page.getByRole('navigation')).toHaveCount(1);
	await navigation.getByRole('button', { name: 'Source control', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'git palette', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await navigation.getByRole('button', { name: 'Extensions', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Extensions', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await navigation.getByRole('button', { name: 'Explorer', exact: true }).click();
	await expect(page.getByRole('tree', { name: 'Project files' })).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'restoreWorkspaces')
						.length
			)
		)
		.toBe(1);
	await page.reload();
	await expect(navigation).toHaveAttribute('data-position', 'top');
	await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'Activity bar position' })).toHaveValue('top');
	await page.getByRole('checkbox', { name: 'Show file explorer' }).uncheck();
	await page.keyboard.press('Escape');
	await expect(explorer).toHaveCount(0);
	await expect(navigation).toBeVisible();
	await navigation.getByRole('button', { name: 'Explorer', exact: true }).click();
	await expect(explorer).toBeVisible();
	await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
	const position = page.getByRole('combobox', { name: 'アクティビティバーの位置' });
	await expect(position).toHaveValue('top');
	await expect(position.getByRole('option', { name: 'エクスプローラーの上部' })).toBeAttached();
	await position.selectOption('left');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('navigation')).toHaveAttribute('data-position', 'left');
	await page.reload();
	await expect(page.getByRole('navigation')).toHaveAttribute('data-position', 'left');
});

test('top activity bar keeps every action inside a narrow explorer', async ({ page }) => {
	await page.setViewportSize({ width: 720, height: 720 });
	await page.goto(`${origin}?view=app`);
	await page.evaluate(() => {
		localStorage.setItem('nido.activityBarPosition', 'top');
		localStorage.setItem('nido.sidebarWidth', '160');
	});
	await page.reload();
	const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
	await expect(navigation).toHaveCSS('width', '160px');
	const bounds = (await navigation.boundingBox())!;
	for (const button of await navigation.getByRole('button').all()) {
		const box = (await button.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(bounds.x);
		expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
		expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
	}
	await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('separator', { name: 'Explorer width' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(navigation).toHaveCSS('width', '180px');
});

for (const view of ['welcome', 'terminal'] as const) {
	test(`top activity bar remains accessible on the ${view} screen`, async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('nido.activityBarPosition', 'top'));
		await page.goto(`${origin}?view=app&defer=restoreWorkspaces`);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.rendererTest?.pending.filter(
							(call) => call.method === 'restoreWorkspaces'
						).length
				)
			)
			.toBe(1);
		await page.evaluate((view) => {
			const terminal = { id: 'shell', root: '/alpha', name: 'Shell', kind: 'terminal' };
			window.rendererTest.settle('restoreWorkspaces', 0, {
				workspaces: view === 'terminal' ? [terminal] : [],
				active: view === 'terminal' ? 'shell' : '',
				errors: []
			});
		}, view);
		await expect(page.getByRole('complementary', { name: 'File explorer' })).toHaveCount(0);
		const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
		await expect(navigation).toHaveAttribute('data-position', 'top');
		await expect
			.poll(async () => {
				const bar = (await navigation.boundingBox())!;
				const main = (await page.locator('main').boundingBox())!;
				return bar.width === main.width && bar.y + bar.height <= main.y;
			})
			.toBe(true);
		await page
			.getByRole('banner')
			.getByRole('button', { name: 'Settings', exact: true })
			.click();
		await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
	});
}

test('settings switch the UI language immediately, persist it and switch back to English', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toBeFocused();
	const saving = settings.getByRole('region', { name: 'Saving and history', exact: true });
	await expect(saving.getByRole('checkbox', { name: 'Use EditorConfig' })).toBeChecked();
	await settings.getByRole('checkbox', { name: 'Word wrap', exact: true }).uncheck();
	await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
	await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
	const japaneseSettings = page.getByRole('dialog', { name: '設定', exact: true });
	await expect(
		japaneseSettings.getByRole('checkbox', { name: '行の折り返し', exact: true })
	).not.toBeChecked();
	await expect(japaneseSettings.getByRole('combobox', { name: '言語', exact: true })).toHaveValue(
		'ja'
	);
	await expect(japaneseSettings.getByRole('heading', { level: 3 })).toHaveText([
		'全般・レイアウト',
		'エディター表示',
		'カーソル・操作',
		'保存・履歴',
		'ターミナル'
	]);
	await expect(
		japaneseSettings
			.getByRole('region', { name: '保存・履歴', exact: true })
			.getByRole('checkbox', { name: 'EditorConfigを使用' })
	).toBeChecked();
	await expect(
		page.getByRole('button', { name: 'エクスプローラー', exact: true })
	).toHaveAttribute('title', 'エクスプローラー（Space e）');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('ja');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'setLanguage')
						.at(-1)?.args[0]
			)
		)
		.toBe('ja');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'restoreWorkspaces')
						.length
			)
		)
		.toBe(1);

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
	await page.getByRole('button', { name: '設定', exact: true }).click();
	await page.getByRole('combobox', { name: '言語', exact: true }).selectOption('en');
	await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.language'))).toBe('en');
});

test('Japanese command search and keyboard navigation keep working after a language change', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ja');
	await page.getByRole('button', { name: 'パレットを閉じる', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
	await page.keyboard.press('Space');
	await expect(
		page.getByRole('dialog', { name: 'キーボードコマンド', exact: true })
	).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Control+Shift+p');
	await page.getByRole('textbox', { name: '項目を絞り込む', exact: true }).fill('設定');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Neovim入力', exact: true })).toBeFocused();
	await page.keyboard.press('Control+Shift+g');
	await expect(page.getByRole('dialog', { name: 'ソース管理', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Gitの変更', exact: true })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await expect(
		page.getByRole('listbox', { name: '変更されたファイル', exact: true })
	).toBeFocused();
	await expect(page.getByRole('button', { name: 'ブランチ', exact: true })).toBeEnabled();
	await page.keyboard.press('3');
	await expect(page.getByRole('button', { name: 'ブランチ', exact: true })).toHaveAttribute(
		'aria-current',
		'page'
	);
});

test('file icons recognize common formats, exact names and Windows paths', async ({ page }) => {
	await page.goto(`${origin}?view=icons`);
	for (const [path, icon] of [
		['C:\\logs\\CHIBI.LOG', 'scroll-text'],
		['logs/chibi.log.2', 'scroll-text'],
		['Cargo.toml', 'package'],
		['Cargo.lock', 'package'],
		['package.json', 'package'],
		['.env.local', 'file-key'],
		['.gitignore', 'git-branch'],
		['.editorconfig', 'file-cog'],
		['.eslintrc.js', 'file-cog'],
		['README.md', 'book-open'],
		['Dockerfile.prod', 'container'],
		['compose.yaml', 'container'],
		['data.JSON', 'braces'],
		['settings.yml', 'file-cog'],
		['server.ps1', 'file-terminal'],
		['photo.PNG', 'file-image'],
		['sound.mp3', 'file-music'],
		['video.mp4', 'file-video-camera'],
		['archive.tar.gz', 'file-archive'],
		['data.sqlite3', 'database'],
		['data.csv', 'file-spreadsheet'],
		['notes.md', 'file-text'],
		['report.pdf', 'file-type'],
		['server.key', 'file-lock'],
		['file.unknown', 'file-code-2']
	]) {
		await page.evaluate((path) => window.rendererTest.render({ path }), path);
		const image = page.locator('[data-file-icon] svg');
		await expect(image).toHaveClass(new RegExp(`lucide-${icon}\\b`));
		await expect(image).toHaveAttribute('aria-hidden', 'true');
	}
	await page.evaluate(() => window.rendererTest.render({ path: 'C:\\project\\main.RS' }));
	await expect(page.locator('[data-file-icon] img')).toHaveAttribute('src', /rust\.svg/);
	await page.evaluate(() => window.rendererTest.render({ path: 'component.TSX' }));
	await expect(page.locator('[data-file-icon] img')).toHaveAttribute(
		'src',
		/react\.svg|^data:image\/svg\+xml,/
	);
});

test('folder icons distinguish project roles and keep ordinary folder open states', async ({
	page
}) => {
	await page.goto(`${origin}?view=icons`);
	for (const [path, icon] of [
		['C:\\project\\SRC', 'folder-code'],
		['project/tests', 'folder-check'],
		['logs', 'folder-clock'],
		['logger', 'folder-clock'],
		['.vscode', 'folder-cog'],
		['.github', 'folder-git-2'],
		['target', 'folder-archive'],
		['screen', 'folder-tree'],
		['consts', 'folder-lock']
	]) {
		await page.evaluate((path) => window.rendererTest.render({ path }), path);
		for (const selector of ['[data-folder-closed] svg', '[data-folder-open] svg']) {
			await expect(page.locator(selector)).toHaveClass(new RegExp(`lucide-${icon}\\b`));
			await expect(page.locator(selector)).toHaveAttribute('aria-hidden', 'true');
		}
	}
	await page.evaluate(() => window.rendererTest.render({ path: 'my-project' }));
	await expect(page.locator('[data-folder-closed] svg')).toHaveClass(/lucide-folder$/);
	await expect(page.locator('[data-folder-open] svg')).toHaveClass(/lucide-folder-open\b/);
});

test('Explorer and editor tabs use the same log icon without changing file accessibility', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=files`);
	const tree = page.getByRole('tree', { name: 'Project files' });
	await expect(tree).toBeVisible();
	await page.evaluate(() => {
		window.rendererTest.settle('files', 0, [
			{ name: 'logs', path: 'logs', directory: true, ignored: true },
			{ name: 'src', path: 'src', directory: true },
			{ name: 'chibi.log', path: 'chibi.log', directory: false }
		]);
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [{ id: 1, name: '/alpha/chibi.log', modified: false }],
				current: 1,
				mode: 'n',
				line: 1,
				column: 1,
				filetype: 'log'
			}
		});
	});
	const log = tree.getByRole('treeitem', { name: 'chibi.log', exact: true });
	await expect(log.locator('.lucide-scroll-text')).toBeVisible();
	await expect(
		page.getByRole('tab', { name: 'chibi.log', exact: true }).locator('.lucide-scroll-text')
	).toBeVisible();
	await expect(
		tree.getByRole('treeitem', { name: 'src', exact: true }).locator('.lucide-folder-code')
	).toBeVisible();
	const folder = tree.getByRole('treeitem', { name: 'logs', exact: true });
	await expect(folder).toHaveAttribute('aria-expanded', 'false');
	await expect(folder.locator('.lucide-folder-clock')).toHaveCSS('opacity', '0.55');
});

test('an invalid saved language safely opens the English interface', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('nido.language', 'unsupported'));
	await page.goto(`${origin}?view=app`);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});

test('editor font size accepts half sizes and keeps the last valid one', async ({ page }) => {
	await page.addInitScript(() => {
		if (!sessionStorage.getItem('nido.test.reloaded')) {
			localStorage.setItem('nido.fontSize', '9.25');
		}
	});
	await page.goto(`${origin}?view=app`);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const size = page.getByRole('spinbutton', { name: 'Editor font size' });
	// A stored size that is not a whole or half size falls back to the default.
	await expect(size).toHaveValue('15');
	await size.fill('9.5');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('nido.fontSize'))).toBe('9.5');
	await size.fill('9.3');
	await size.blur();
	await expect(size).toHaveValue('9.5');
	await page.keyboard.press('Escape');
	await page.evaluate(() => sessionStorage.setItem('nido.test.reloaded', '1'));
	await page.reload();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('spinbutton', { name: 'Editor font size' })).toHaveValue('9.5');
});

test('settings shortcuts leave IME transition keys with the focused control', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	const font = settings.getByRole('textbox', { name: 'Font family', exact: true });
	const size = settings.getByRole('spinbutton', { name: 'Editor font size' });
	await font.focus();
	await font.dispatchEvent('keydown', { key: 'ArrowDown', keyCode: 229 });
	await expect(font).toBeFocused();
	await font.press('ArrowDown');
	await expect(size).toBeFocused();

	const wrap = settings.getByRole('checkbox', { name: 'Word wrap', exact: true });
	await wrap.focus();
	await expect(wrap).toBeChecked();
	await wrap.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
	await expect(wrap).toBeChecked();
	await wrap.press('Enter');
	await expect(wrap).not.toBeChecked();
});

test('number settings can be cleared and retyped', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	for (const [name, key, typed] of [
		['Editor font size', 'nido.fontSize', '18'],
		['Editor font weight', 'nido.fontWeight', '400'],
		['Editor line height', 'nido.lineHeight', '22'],
		['Sticky Scroll maximum lines', 'nido.stickyScrollMaxLines', '8']
	]) {
		const input = page.getByRole('spinbutton', { name });
		await input.click();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.press('Backspace');
		// An empty field waits for the next number instead of springing back to the old one.
		await expect(input).toHaveValue('');
		await page.keyboard.type(typed);
		await expect(input).toHaveValue(typed);
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key)).toBe(typed);
	}
	// Leaving a field that holds an invalid number shows the last valid one again.
	const lines = page.getByRole('spinbutton', { name: 'Sticky Scroll maximum lines' });
	await lines.fill('11');
	await lines.blur();
	await expect(lines).toHaveValue('8');
});

test('Indentation shows in the status bar and changes from the palette by mouse or keyboard', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	await expect(page.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'state',
			id: 'alpha',
			state: {
				buffers: [{ id: 1, name: '/alpha/main.rs', modified: false }],
				current: 1,
				mode: 'n',
				line: 1,
				column: 1,
				filetype: 'rust',
				indentation: { spaces: true, size: 4 }
			}
		})
	);
	const status = page.getByRole('button', { name: 'Indentation: Spaces: 4' });
	await expect(status).toHaveText('Spaces: 4');
	const setIndentation = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'setIndentation')
				.map((call) => call.args)
		);

	// The status item opens the palette filtered to the indentation commands.
	await status.click();
	const palette = page.getByRole('dialog', { name: 'commands palette' });
	await expect(palette.getByRole('textbox')).toHaveValue('Indentation');
	await expect(palette.getByText('Indent using tabs', { exact: true })).toBeVisible();
	await expect(palette.getByText('Quit Nido', { exact: true })).toHaveCount(0);
	await palette.getByText('Indent using tabs', { exact: true }).click();
	await expect.poll(setIndentation).toEqual([['alpha', { spaces: false, size: 4 }, false]]);

	// Every command is reachable from the keyboard alone.
	await page.keyboard.press('Control+Shift+p');
	await page.keyboard.type('Indent width 2');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Control+Shift+p');
	await page.keyboard.type('Convert indentation to tabs');
	await page.keyboard.press('Enter');
	await expect.poll(setIndentation).toEqual([
		['alpha', { spaces: false, size: 4 }, false],
		['alpha', { spaces: true, size: 2 }, false],
		['alpha', { spaces: false, size: 4 }, true]
	]);

	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'statePatch',
			id: 'alpha',
			state: { indentation: { spaces: false, size: 8 } }
		})
	);
	await expect(page.getByRole('button', { name: 'Indentation: Tab size: 8' })).toBeVisible();
});
