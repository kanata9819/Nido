import { test, expect } from './helpers/renderer-test';
import type { ViteDevServer } from 'vite';
import { harnessWarmupTimeout, startHarnessServer } from './helpers/harness-server';
import type {} from './renderer/harness';
import { applyNeovimUI, emptyNeovimUI } from '../src/shared/neovimUI';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(harnessWarmupTimeout);
	({ server, origin } = await startHarnessServer(browser));
});

test.afterAll(async () => {
	await server?.close();
});

test('external command cards preserve native input focus, UTF-8 cursor, nested prompts and completion', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	let state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
		[[0, 'echo "日本😀"']],
		15,
		':',
		'',
		0,
		1
	]);
	const emit = async (): Promise<void> => {
		await page.evaluate(
			(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
			state
		);
	};
	await emit();
	const command = page.getByRole('dialog', { name: 'Neovim command line', exact: true });
	await expect(command).toBeVisible();
	await expect(command.getByLabel('Command content')).toHaveText(':echo "日本😀"');
	await expect(command.locator('[data-neovim-caret]')).toHaveText('😀');
	await expect(input).toHaveAttribute('data-nvim-command-active', '');
	await expect(input).toBeFocused();
	await command.getByLabel('Command content').click();
	await expect(input).toBeFocused();
	const positions = await input.evaluate((node) => {
		const caret = document.querySelector('[data-neovim-caret]')!.getBoundingClientRect();
		const anchor = node.getBoundingClientRect();
		return { x: Math.abs(caret.x - anchor.x), y: Math.abs(caret.y - anchor.y) };
	});
	expect(positions.x).toBeLessThan(1);
	expect(positions.y).toBeLessThan(1);
	state = applyNeovimUI(state, 'cmdline_show', [[[0, '1+1']], 3, '=', '', 0, 2]);
	await emit();
	await expect(command.getByLabel('Command content')).toContainText('=1+1');
	state = applyNeovimUI(state, 'cmdline_hide', [2, false]);
	state = applyNeovimUI(state, 'popupmenu_show', [
		[
			['echo', '', '', ''],
			['echomsg', '', '', '']
		],
		0,
		0,
		0,
		-1
	]);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['popupmenu_show', [[['echo', '', '', '']], 0, 0, 0, -1]]]
		})
	);
	await emit();
	await expect(page.getByRole('listbox', { name: 'Code completion' })).toHaveCount(0);
	const completion = page.getByRole('listbox', { name: 'Command completion' });
	await expect(completion).toBeVisible();
	await completion.getByRole('option', { name: 'echomsg', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'selectCompletion')
						.at(-1)?.args
			)
		)
		.toEqual(['alpha', 1]);
	await expect(input).toBeFocused();
	await command.getByRole('button', { name: 'Cancel command' }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args
			)
		)
		.toEqual(['alpha', '<Esc>']);
	state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
	await emit();
	await expect(command).toHaveCount(0);
	await expect(input).not.toHaveAttribute('data-nvim-command-active');
});

test('command completion bounds large lists while preserving selection and manual scrolling', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	let state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [[[0, 'edit ']], 5, ':', '', 0, 1]);
	state = applyNeovimUI(state, 'popupmenu_show', [
		Array.from({ length: 10000 }, (_, index) => [
			`候補${index}日本😀`,
			'',
			`detail ${index}`,
			''
		]),
		0,
		0,
		0,
		-1
	]);
	const publish = async (): Promise<void> => {
		await page.evaluate(
			(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
			state
		);
	};
	await publish();
	const list = page.getByRole('listbox', { name: 'Command completion' });
	await expect(list).toBeVisible();
	const before = await list.evaluate((node) => ({
		count: node.querySelectorAll('[role="option"]').length,
		rowHeight: node.querySelector('[role="option"]')!.getBoundingClientRect().height
	}));
	console.log('command-completion-rows', JSON.stringify(before));
	expect(before.count).toBeLessThan(60);
	state = applyNeovimUI(state, 'popupmenu_select', [9999]);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'neovimUIPatch',
			id: 'alpha',
			state: { completion: { selected: 9999 } }
		})
	);
	const selected = list.locator('[aria-selected="true"]');
	await expect(selected).toContainText('候補9999日本😀');
	await expect(selected).toHaveAttribute('aria-posinset', '10000');
	await expect(selected).toHaveAttribute('aria-setsize', '10000');
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toHaveAttribute(
		'aria-activedescendant',
		'neovim-completion-alpha-9999'
	);
	const visible = async (): Promise<boolean> =>
		selected.evaluate((node) => {
			const bounds = node.getBoundingClientRect();
			const list = node.closest('[role="listbox"]')!.getBoundingClientRect();
			const pixel = 1 / devicePixelRatio;
			return bounds.top >= list.top - pixel && bounds.bottom <= list.bottom + pixel;
		});
	await expect.poll(visible).toBe(true);
	await list.evaluate((node) => {
		node.scrollTop = 0;
	});
	await expect(list.getByRole('option').first()).toContainText('候補0日本😀');
	await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
	expect(await list.getByRole('option').count()).toBeLessThan(60);
	await list.getByRole('option').first().click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls
						.filter((call) => call.method === 'selectCompletion')
						.at(-1)?.args
			)
		)
		.toEqual(['alpha', 0]);
	await expect(page.getByRole('textbox', { name: 'Neovim input', exact: true })).toBeFocused();
	state = applyNeovimUI(state, 'popupmenu_show', [[['short', '', '', '']], -1, 0, 0, -1]);
	await publish();
	await expect(list.getByRole('option')).toHaveCount(1);
	await expect(list.getByRole('option')).toContainText('short');
});

test('external command input keeps spaces, Unicode and control keys in order', async ({ page }) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	const state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
		[[0, 'echomsg "']],
		9,
		':',
		'',
		0,
		1
	]);
	await page.evaluate(
		(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
		state
	);
	await expect(input).toHaveAttribute('data-nvim-command-active', '');
	await page.keyboard.type('Native message 日本語"');
	await page.keyboard.press('Control+p');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'c'));
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.rendererTest?.calls
					.filter((call) => call.method === 'input')
					.map((call) => call.args[1])
					.join('')
			)
		)
		.toBe('Native message 日本語"<C-p>');
	await page.keyboard.press('Control+Shift+m');
	await expect(page.getByRole('listbox', { name: 'Problems', exact: true })).toBeFocused();
});

test('file picker opens after command submission before the command card redraws', async ({
	page
}) => {
	await page.goto(`${origin}?view=app&defer=inputMode`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	const state = applyNeovimUI(emptyNeovimUI(), 'cmdline_show', [
		[[0, 'echo 1']],
		6,
		':',
		'',
		0,
		1
	]);
	await page.evaluate((state) => {
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['mode_change', ['cmdline_normal', 0]]]
		});
		window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state });
	}, state);
	await expect(input).toHaveAttribute('data-nvim-command-active', '');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Control+p');
	await expect.poll(() => page.evaluate(() => window.rendererTest?.pending.length)).toBe(1);
	// Neovim processed Enter, but its redraw and the old command card are still pending.
	await page.evaluate(() => window.rendererTest.settle('inputMode', 0, 'n'));
	// The file picker opens on its list, as in Vim's Normal mode.
	await expect(page.getByRole('group', { name: 'Palette results' })).toBeFocused();
});

test('external messages show safe selectable output, severity, history and keyboard scrolling', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	let state = applyNeovimUI(emptyNeovimUI(), 'msg_show', [
		'emsg',
		[[0, '<img src=x onerror=alert(1)>\nE492: Unknown command']],
		false
	]);
	const emit = async (): Promise<void> => {
		await page.evaluate(
			(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
			state
		);
	};
	await page.evaluate(
		(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'other', state }),
		state
	);
	const messages = page.getByRole('dialog', { name: 'Neovim messages', exact: true });
	await expect(messages).toHaveCount(0);
	await emit();
	await expect(messages).toBeVisible();
	await expect(messages.locator('article[data-severity="error"]')).toContainText('E492');
	await expect(messages.locator('img')).toHaveCount(0);
	await expect(input).toBeFocused();
	state = applyNeovimUI(state, 'msg_show', [
		'shell_out',
		[[0, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')]],
		false
	]);
	await emit();
	await page.keyboard.press('Alt+Shift+m');
	const body = page.getByLabel('Message content', { exact: true });
	await expect(body).toBeFocused();
	await expect
		.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight))
		.toBe(true);
	await page.keyboard.press('Control+u');
	const before = await body.evaluate((node) => node.scrollTop);
	await page.keyboard.press('Control+u');
	await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(before);
	await body.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.press('Control+c');
	await expect(messages).toBeVisible();
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	await page.keyboard.press('Escape');
	await expect(messages).toHaveCount(0);
	await expect(input).toBeFocused();
	state = applyNeovimUI(state, 'cmdline_show', [[[0, 'echo']], 4, ':', '', 0, 1]);
	await emit();
	await expect(messages).toHaveCount(0);
	state = applyNeovimUI(state, 'msg_show', ['wmsg', [[0, 'New warning']], false]);
	await emit();
	await expect(messages.locator('article[data-severity="warning"]')).toContainText('New warning');
	state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
	state = applyNeovimUI(state, 'msg_history_show', [[['echomsg', [[0, 'retained history']]]]]);
	await emit();
	const history = page.getByRole('dialog', { name: 'Message history' });
	await expect(history).toContainText('retained history');
	await history.getByRole('button', { name: 'Close messages' }).click();
	await expect(history).toHaveCount(0);
});

test('external confirmation and hit-enter cards send replies to Neovim before dismissing', async ({
	page
}) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	let state = applyNeovimUI(emptyNeovimUI(), 'msg_show', [
		'confirm',
		[[0, 'Continue? [Y]es, (N)o: ']],
		false
	]);
	const emit = async (): Promise<void> => {
		await page.evaluate(
			(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
			state
		);
	};
	await emit();
	await page.keyboard.press('Alt+Shift+m');
	await page.keyboard.press('n');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args
			)
		)
		.toEqual(['alpha', 'n']);
	await expect(input).toBeFocused();
	state = applyNeovimUI(state, 'msg_clear', []);
	state = applyNeovimUI(state, 'msg_show', [
		'return_prompt',
		[[0, 'Press ENTER or type command to continue']],
		false
	]);
	await emit();
	const messages = page.getByRole('dialog', { name: 'Neovim messages' });
	await messages.getByRole('button', { name: 'Enter Continue' }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args
			)
		)
		.toEqual(['alpha', '<CR>']);
	await expect(messages).toBeVisible();
	state = applyNeovimUI(state, 'msg_clear', []);
	await emit();
	await expect(messages).toHaveCount(0);

	state = applyNeovimUI(state, 'cmdline_show', [
		[[0, '']],
		0,
		'',
		'Do you really want to write to it (y/n)?',
		0,
		1
	]);
	await emit();
	const command = page.getByRole('dialog', { name: 'Neovim command line' });
	await expect(command).toBeVisible();
	await page.keyboard.press('n');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args
			)
		)
		.toEqual(['alpha', 'n']);
	await command.getByRole('button', { name: 'Cancel command', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.rendererTest?.calls.filter((call) => call.method === 'input').at(-1)
						?.args
			)
		)
		.toEqual(['alpha', '<Esc>']);
	state = applyNeovimUI(state, 'cmdline_hide', [1, true]);
	await emit();
	await expect(command).toHaveCount(0);
	await expect(input).toBeFocused();
});

test('cursor-only patches preserve completion and a normal-mode patch dismisses it', async ({
	page
}) => {
	await page.goto(`${origin}?view=completion`);
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['popupmenu_show', [[['word', 'Text', '', '']], 0, 1, 1]]]
		})
	);
	const menu = page.getByRole('listbox', { name: 'Code completion' });
	await expect(menu).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { line: 2, column: 3 } })
	);
	await expect(menu).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({ type: 'statePatch', id: 'alpha', state: { mode: 'n' } })
	);
	await expect(menu).toHaveCount(0);
});

test('Completion keeps pending navigation blocked and closes on punctuation', async ({ page }) => {
	await page.goto(`${origin}?view=completion`);
	const input = page.getByRole('textbox', { name: 'Neovim input' });
	await input.focus();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [['popupmenu_show', [[['word', 'Text', '', '']], 0, 1, 1]]]
		})
	);
	const menu = page.getByRole('listbox', { name: 'Code completion' });
	await expect(menu).toBeVisible();
	await page.evaluate(() =>
		window.rendererTest.emit({
			type: 'redraw',
			id: 'alpha',
			events: [
				['nido_completion_refresh', [true]],
				['popupmenu_hide', []]
			]
		})
	);
	await expect(menu).toHaveAttribute('aria-busy', 'true');
	await input.press('Tab');
	await expect(input).toBeFocused();
	await expect(menu).toBeVisible();
	await input.press('.');
	await expect(menu).toHaveCount(0);
});

test('messages show in the bottom right and Esc in the editor closes them', async ({ page }) => {
	await page.goto(`${origin}?view=app`);
	const input = page.getByRole('textbox', { name: 'Neovim input', exact: true });
	await expect(input).toBeFocused();
	let state = applyNeovimUI(emptyNeovimUI(), 'msg_show', ['', [[0, '4 more lines']], false]);
	const emit = async (): Promise<void> => {
		await page.evaluate(
			(state) => window.rendererTest.emit({ type: 'neovimUI', id: 'alpha', state }),
			state
		);
	};
	await emit();
	const messages = page.getByRole('dialog', { name: 'Neovim messages', exact: true });
	await expect(messages).toContainText('4 more lines');
	await expect(messages).toContainText('Esc');
	const card = (await messages.boundingBox())!;
	const editor = (await page.locator('canvas:visible').first().boundingBox())!;
	// Right-aligned within the editor, clear of its left edge.
	expect(editor.x + editor.width - (card.x + card.width)).toBeLessThan(40);
	expect(card.x - editor.x).toBeGreaterThan(40);

	const inputs = (): Promise<unknown[][]> =>
		page.evaluate(() =>
			window.rendererTest.calls
				.filter((call) => call.method === 'input')
				.map((call) => call.args)
		);
	const before = (await inputs()).length;
	await page.keyboard.press('Escape');
	await expect(messages).toHaveCount(0);
	await expect(input).toBeFocused();
	// Neovim still receives the Esc.
	await expect
		.poll(async () => (await inputs()).slice(before))
		.toContainEqual(['alpha', '<Esc>']);

	// A newer message opens the card again.
	state = applyNeovimUI(state, 'msg_show', ['', [[0, 'Written']], false]);
	await emit();
	await expect(messages).toContainText('Written');

	// While Neovim waits at a prompt, Esc is its answer, given through the dialog.
	state = applyNeovimUI(state, 'msg_show', [
		'confirm',
		[[0, 'Save changes? [Y]es, (N)o: ']],
		false
	]);
	await emit();
	await expect(messages).not.toContainText('Esc Close');
});
