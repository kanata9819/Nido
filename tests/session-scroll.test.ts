import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';
import { Grid } from '../src/renderer/src/grid/grid';
import { vimKey } from '../src/renderer/src/keyboard/keyboard';
import { accumulateScroll, scrollOffset } from '../src/renderer/src/editor/scroll';
import type { Redraw } from '../src/shared/types';

test('gutter numbers and current-line colors stay based on the edit anchor during pixel scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-relative-scroll-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 24);
		await session.openFile('lines.txt');
		await session.setRelativeLineNumbers(true);
		await session.input('80Gzz');
		const checkGutter = (anchor: number, relative: boolean): void => {
			let checked = 0;
			const ends = new Set<number>();
			for (const row of grid.cells) {
				const text = row.map((cell) => cell.text).join('');
				const match = text.match(/^\s*(\d+)\s+line (\d+)\s*$/);
				if (!match) continue;
				const line = Number(match[2]);
				assert.equal(
					Number(match[1]),
					!relative || line === anchor ? line : Math.abs(line - anchor),
					`gutter for line ${line}`
				);
				const first = text.indexOf(match[1]);
				// Every number ends in the same column, the cursor line's included.
				ends.add(first + match[1].length);
				for (const cell of row.slice(first, first + match[1].length)) {
					assert.equal(
						grid.highlights.get(cell.highlight)?.foreground,
						line === anchor ? 0xc6c6c6 : 0x858585,
						`gutter color for line ${line}`
					);
				}
				checked++;
			}
			assert.ok(checked > 10);
			assert.equal(ends.size, 1, `line numbers end in columns ${[...ends].join(', ')}`);
		};
		// One 'statuscolumn' for good: setting it again makes Neovim re-estimate its width, and
		// bracket guides published meanwhile were drawn a column to the left.
		const numberColumn = await session.client.request('nvim_exec_lua', [
			"return require('nido_scroll').column",
			[]
		]);
		const textOffset = (): Promise<unknown> =>
			session!.client.request('nvim_eval', ['getwininfo(win_getid())[0].textoff']);
		const offset = await textOffset();
		for (const relative of [true, false, true]) {
			await session.setRelativeLineNumbers(relative);
			await new Promise((done) => setTimeout(done, 30));
			checkGutter(80, relative);
		}
		for (const [lines, relative] of [
			[0.25, true],
			[26.25, true],
			[-24.5, true],
			[0.1, false],
			[0.1, true]
		] as const) {
			await session.setRelativeLineNumbers(relative);
			await session.scroll(lines, false, true);
			await new Promise((done) => setTimeout(done, 30));
			checkGutter(80, relative);
			assert.equal(
				await session.client.request('nvim_eval', ['&statuscolumn']),
				numberColumn
			);
			assert.equal(await textOffset(), offset);
		}
		await session.input('j');
		await session.client.request('nvim_eval', ['1']);
		assert.equal(await session.client.request('nvim_eval', ["line('.')"]), 81);
		assert.equal(await session.client.request('nvim_eval', ['&statuscolumn']), numberColumn);
		await new Promise((done) => setTimeout(done, 30));
		checkGutter(81, true);
		await session.scroll(30, false, true);
		await session.scroll(1, true, true);
		assert.equal(await session.client.request('nvim_eval', ['&statuscolumn']), numberColumn);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('wheel scrolling can retain the edit position and resumes input and paste at the anchor', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-anchor-'));
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, () => {});
		await session.openFile('lines.txt');
		await session.client.request('nvim_exec_lua', [
			'vim.api.nvim_win_set_cursor(0, {20, 0})',
			[]
		]);
		await session.scroll(60, false);
		assert.deepEqual(
			await session.client.request('nvim_exec_lua', [
				"return require('nido_scroll').cursor()",
				[]
			]),
			[20, 0]
		);
		assert.equal(
			await session.client.request('nvim_exec_lua', [
				"return require('nido_scroll').screen_cursor().row",
				[]
			]),
			-1
		);
		await session.input('iX<Esc>');
		await new Promise((done) => setTimeout(done, 50));
		assert.equal(await session.client.request('nvim_eval', ['getline(20)']), 'Xline 20');
		await session.scroll(60, false);
		await session.paste('Y');
		assert.match(String(await session.client.request('nvim_eval', ['getline(20)'])), /Y/);
		await session.scroll(60, true);
		assert.equal(
			await session.client.request('nvim_exec_lua', [
				"return require('nido_scroll').cursor()",
				[]
			]),
			null
		);
		assert.ok(Number(await session.client.request('nvim_eval', ["line('.')"])) > 20);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('word motions resume at the edit position without undoing vertical wheel scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-word-motion-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'lines.txt'), Array(200).fill('alpha beta gamma').join('\n'));
		session = await Session.create(root, () => {});
		await session.attach(80, 24);
		await session.openFile('lines.txt');
		const view = (): Promise<{ topline: number; botline: number; lnum: number; col: number }> =>
			session!.client.request('nvim_exec_lua', [
				"vim.cmd.redraw(); local view = vim.fn.winsaveview(); view.botline = vim.fn.line('w$'); return view",
				[]
			]);
		const line = 80;
		const margin = 4;
		const [window, buffer] = (await session.client.request('nvim_exec_lua', [
			'return {vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()}',
			[]
		])) as [number, number];
		for (const [key, column] of [
			['w', 11],
			['b', 0]
		] as const) {
			for (const [lines, rows] of [
				[7, 3],
				[7, 4],
				[7, 5],
				[60, 5],
				[2, 5],
				[-7, 5],
				...[-60, -10, -2, 10, 60].map((lines) => [lines, 0])
			]) {
				await session.input(`${line}Gzz0w`);
				await session.scroll(lines + 0.25, false, true);
				const { topline, botline } = await view();
				await session.input(key, rows ? { window, buffer, rows } : undefined);
				const after = await view();
				assert.equal(after.lnum, line);
				assert.equal(after.col, column);
				const expectedTop = topline + Math.max(0, line + margin - botline);
				assert.equal(
					after.topline,
					Math.min(expectedTop, line - Math.max(margin, rows)),
					`${key} after scrolling ${lines} lines with ${rows} rows covered`
				);
			}
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('keyboard movement and editing keep the cursor above pixel-scroll overscan', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-cursor-bottom-'));
	const grid = new Grid();
	grid.pixelScrollEnabled = true;
	let session: Session | undefined;
	const check = async (height: number, action: string): Promise<string> => {
		const mode = await session!.inputMode();
		await session!.client.request('nvim_command', ['redraw']);
		grid.prepareLayout(height, 8, 22);
		const bottom = grid.rowY(grid.cursor.row) + 22;
		assert.ok(bottom <= height, `${action}, height ${height}: cursor bottom ${bottom}`);
		assert.ok(grid.rowY(grid.cursor.row) >= 0);
		return mode;
	};
	try {
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.client.request('nvim_exec_lua', [
			'vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 160)))',
			[]
		]);
		for (const height of [396, 403, 1046]) {
			await session.resize(80, Math.ceil(height / 22) + 2);
			for (const [keys, mode] of [
				['ggG', 'n'],
				['gg159G', 'n'],
				['gg160G', 'n'],
				['ggGzb', 'n'],
				['gg150G10j', 'n'],
				['ggvG', 'v'],
				['ggVG', 'V'],
				['gg<C-v>G', '\u0016'],
				['ggGR', 'R'],
				['ggGoX', 'i']
			]) {
				await session.input(keys);
				assert.equal(await check(height, keys), mode);
				await session.input('<Esc>');
			}
		}
		await session.resize(80, Math.ceil(403 / 22) + 2);
		await check(403, 'resize at EOF');
		await session.client.request('nvim_exec_lua', [
			`local last = vim.api.nvim_buf_line_count(0)
      vim.api.nvim_buf_set_lines(0, last - 1, last, false, {string.rep('x', 160)})
      vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace('cursor-bottom-lens'), last - 1, 0, {
        virt_lines=vim.tbl_map(function() return {{'Run', 'NidoCodeLens'}} end, vim.fn.range(1, 5)),
        virt_lines_above=true,
      })`,
			[]
		]);
		await session.input('ggG$');
		await check(403, 'wrapped EOF');
		assert.ok(grid.extraRows > 0, 'compact annotations add native overscan rows');
		await session.resize(80, Math.ceil(403 / 22) + 2 + grid.extraRows);
		await check(403, 'compact annotations');
		const last = Number(await session.client.request('nvim_eval', ["line('$')"]));
		await session.input('2');
		const countedResize = session.resize(80, 20);
		await session.input('k');
		await countedResize;
		assert.equal(await session.client.request('nvim_eval', ["line('.')"]), last - 2);
		await session.input(':let g:nido_bottom_resize = ');
		const commandResize = session.resize(80, 24);
		await session.input('42<CR>');
		await commandResize;
		assert.equal(await session.client.request('nvim_eval', ['g:nido_bottom_resize']), 42);
		await session.input('G$');
		await session.inputMode();
		const before = await session.client.request('nvim_exec_lua', [
			'return vim.fn.winsaveview()',
			[]
		]);
		await session.prefetchScroll(false);
		await session.prefetchScroll(true);
		assert.deepEqual(
			await session.client.request('nvim_exec_lua', ['return vim.fn.winsaveview()', []]),
			before,
			'speculative rows must not move the editing viewport'
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('keyboard page scrolling reveals the last row hidden by pixel-scroll overscan', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-page-end-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		await session.client.request('nvim_exec_lua', [
			'vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 46)))',
			[]
		]);
		for (const rows of [24, 25, 44, 45]) {
			await session.resize(80, rows);
			for (const key of ['<C-d>', '2<C-d>', '<C-f>', '<PageDown>']) {
				await session.input('gg');
				for (let step = 0; step < 46; step++) await session.input(key);
				const screen = Number(
					await session.client.request('nvim_eval', [
						"screenpos(win_getid(), line('$'), 1).row"
					])
				);
				assert.ok(
					screen > 0 && screen <= rows - 2,
					`${key}, ${rows} rows: EOF at screen row ${screen}`
				);
			}
		}
		await session.client.request('nvim_exec_lua', [
			"vim.api.nvim_buf_set_lines(0, 45, 46, false, {string.rep('x', 160)})",
			[]
		]);
		await session.input('gg');
		for (let step = 0; step < 46; step++) await session.input('<C-d>');
		const wrappedEnd = Number(
			await session.client.request('nvim_eval', [
				"screenpos(win_getid(), line('$'), 160).row"
			])
		);
		assert.ok(wrappedEnd > 0 && wrappedEnd <= 43, `wrapped EOF at screen row ${wrappedEnd}`);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('zz centers the cursor in the visible viewport for odd and even grid heights', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-center-'));
	let session: Session | undefined;
	let fraction = 0;
	try {
		session = await Session.create(root, (event) => {
			if (event.type !== 'redraw') return;
			for (const [name, ...calls] of event.events) {
				if (name === 'nido_pixel_scroll') fraction = Number(calls.at(-1)![0]);
			}
		});
		await session.attach(80, 34);
		await session.client.request('nvim_exec_lua', [
			'vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 300)))',
			[]
		]);
		for (const rows of [34, 35, 36, 37]) {
			await session.resize(80, rows);
			await session.scroll(0.3, false, true);
			await session.input('150zz');
			await session.client.request('nvim_eval', ['1']);
			const row = Number(await session.client.request('nvim_eval', ['winline() - 1']));
			assert.equal(row + 0.5 - fraction, (rows - 2) / 2, `grid height ${rows}`);
			assert.equal(await session.client.request('nvim_eval', ["line('.')"]), 150);
			await session.input('gg');
			await session.client.request('nvim_eval', ['1']);
			assert.equal(fraction, 0, 'returning to the first line clears the centering offset');
			await session.input(`${Math.floor((rows - 2) / 2) + 1}zz`);
			await session.client.request('nvim_eval', ['1']);
			assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 1);
			assert.equal(fraction, 0, 'centering near the file start never clips the first line');
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('pixel scrolling publishes the grid, offset and anchored cursor in a single frame', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-frame-'));
	let session: Session | undefined;
	const frames: Redraw[] = [];
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') frames.push(event.events);
		});
		await session.attach(80, 25);
		await session.openFile('lines.txt');
		await session.client.request('nvim_exec_lua', [
			'vim.cmd("normal! 20Gzz"); vim.cmd.redraw()',
			[]
		]);
		frames.length = 0;
		for (const delta of [0.2, 0.9, 0.9, -0.3, -0.8]) {
			await session.scroll(delta, false, true);
			assert.equal(
				frames.length,
				1,
				'no frame may expose an old grid with a new fractional offset'
			);
			const offset = frames[0].find(([name]) => name === 'nido_pixel_scroll')![1];
			assert.deepEqual(
				offset[2],
				await session.client.request('nvim_exec_lua', [
					"return require('nido_scroll').screen_cursor()",
					[]
				])
			);
			assert.equal(frames[0].at(-1)![0], 'flush');
			frames.length = 0;
		}
		await Promise.all([session.scroll(0.4, false, true), session.scroll(0.8, false, true)]);
		assert.equal(
			frames.length,
			2,
			JSON.stringify(
				frames.map((frame) =>
					frame.map(([name, ...calls]) => [
						name,
						name === 'nido_pixel_scroll' ? calls : calls.length
					])
				)
			)
		);
		assert.ok(
			frames.every(
				(frame) => frame.filter(([name]) => name === 'nido_pixel_scroll').length === 1
			)
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('resizing during insert-mode wheel scrolling keeps the CodeLens viewport in place', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-resize-insert-scroll-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		await session.attach(100, 36);
		const lua = (script: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [script, []]);
		await lua(`
			local api = vim.api
			vim.o.scrolloff = 4
			api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 500)))
			local ns = api.nvim_create_namespace('resize-insert-scroll')
			for row = 0, 499, 4 do
				api.nvim_buf_set_extmark(0, ns, row, 0, {
					virt_lines = {{{'Run', 'NidoCodeLens'}}},
					virt_lines_above = true,
				})
			end
			vim.cmd.redraw()
		`);
		await session.input('100Gzti');
		assert.equal(await session.inputMode(), 'i');
		await session.scroll(1.2, true, true);
		const view = (): Promise<unknown> =>
			lua(`
			local v = vim.fn.winsaveview()
			return {v.topline, v.topfill, v.lnum, v.col}
		`);
		const before = await view();
		for (const rows of [35, 37]) {
			await session.resize(100, rows);
			assert.deepEqual(await view(), before);
		}
		assert.deepEqual(
			await lua(
				"return {vim.go.scrolloff, vim.api.nvim_get_option_value('scrolloff', {win=0, scope='local'})}"
			),
			[4, -1]
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('pixel scroll previews agree with native movement through CodeLens rows', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-codelens-scroll-'));
	let session: Session | undefined;
	const grid = new Grid();
	grid.pixelScrollEnabled = true;
	const height = 20;
	const lensHeight = 14;
	const prepare = (): void => grid.prepareLayout(500, 8, height);
	const position = (): number => {
		const row = grid.cells.findIndex((cells) =>
			cells
				.map((cell) => cell.text)
				.join('')
				.includes('ROW_')
		);
		const line = Number(
			grid.cells[row]
				.map((cell) => cell.text)
				.join('')
				.match(/ROW_(\d+)/)![1]
		);
		return (line - 1) * height + Math.ceil(line / 4) * lensHeight - grid.rowY(row);
	};
	const reports: object[] = [];
	try {
		await writeFile(
			join(root, 'rows.txt'),
			Array.from({ length: 200 }, (_, i) => `ROW_${i + 1} example(argument)`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type !== 'redraw') return;
			for (const [name, ...calls] of event.events) {
				if (name === 'nido_pixel_scroll') {
					grid.scrollFraction = Number(calls.at(-1)![0]);
					grid.scrollPreview = 0;
				}
			}
			grid.apply(event.events);
			prepare();
		});
		await session.attach(80, 25);
		await session.openFile('rows.txt');
		await session.client.request('nvim_exec_lua', [
			`local ns = vim.api.nvim_create_namespace('scroll-lens-test')
            for row = 0, 199, 4 do
              vim.api.nvim_buf_set_extmark(0, ns, row, 0, {
                virt_lines={{{'  Run Tests', 'NidoCodeLens'}, {' (gR) | Debug (gD)', 'NidoCodeLensHint'}}},
                virt_lines_above=true,
              })
            end
            vim.cmd('normal! 30Gzt'); vim.cmd.redraw()`,
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		await session.prefetchScroll(true);
		await session.prefetchScroll(false);
		for (const delta of [...Array<number>(80).fill(0.2), ...Array<number>(80).fill(-0.2)]) {
			grid.scrollPreview = delta;
			prepare();
			const preview = position();
			await session.scroll(delta, false, true);
			const actual = position();
			if (Math.abs(actual - preview) > 0.001) {
				reports.push({
					delta,
					preview,
					actual,
					fraction: grid.scrollFraction,
					view: await session.client.request('nvim_exec_lua', [
						'return vim.fn.winsaveview()',
						[]
					])
				});
			}
		}
		assert.deepEqual(reports, [], 'acknowledging a gesture must not jump at a CodeLens row');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('upward pixel scrolling at the beginning never exposes cached rows or a fractional offset', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-start-'));
	let session: Session | undefined;
	const grid = new Grid();
	const frames: Redraw[] = [];
	try {
		await writeFile(
			join(root, 'rows.txt'),
			Array.from({ length: 500 }, (_, index) => `ROW_${index + 1} text`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') {
				frames.push(event.events);
				grid.apply(event.events);
			}
		});
		await session.attach(80, 25);
		await session.openFile('rows.txt');
		await session.setRelativeLineNumbers(true);
		await session.input('200Gzt');
		await session.prefetchScroll();
		await session.scroll(-1000, false, true);
		await session.prefetchScroll();
		for (const delta of [-0.1, -0.3, -1, -2.5, -0.01]) {
			frames.length = 0;
			await session.scroll(delta, false, true);
			const view = (await session.client.request('nvim_exec_lua', [
				'return vim.fn.winsaveview()',
				[]
			])) as { topline: number; skipcol: number };
			const offsets = frames.flatMap((frame) =>
				frame.flatMap(([name, ...calls]) => (name === 'nido_pixel_scroll' ? calls : []))
			);
			assert.equal(view.topline, 1);
			assert.equal(view.skipcol, 0);
			assert.equal(offsets.at(-1)?.[0], 0, `delta ${delta}: ${JSON.stringify(frames)}`);
			assert.equal(grid.hasUpperRows, false, `delta ${delta}: ${JSON.stringify(frames)}`);
		}
		await session.input('200Gzt');
		await session.prefetchScroll();
		for (let step = 0; step < 180; step++) {
			await session.scroll(-1.3, false, true);
		}
		assert.equal(grid.hasUpperRows, false);
		await session.input('gg');
		await session.client.request('nvim_exec_lua', [
			`local ns = vim.api.nvim_create_namespace('top-test')
            vim.api.nvim_buf_set_extmark(0, ns, 0, 0, {virt_lines={{{'VIRTUAL_GHOST', 'Normal'}}}, virt_lines_above=true})
            vim.fn.winrestview({topline=1, topfill=1}); vim.cmd.redraw()`,
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		await session.client.request('nvim_exec_lua', [
			"vim.api.nvim_buf_clear_namespace(0, vim.api.nvim_create_namespace('top-test'), 0, -1); vim.cmd.redraw()",
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		assert.equal(grid.hasUpperRows, false, 'a decoration redraw is not viewport movement');
		await session.prefetchScroll();
		assert.equal(
			grid.hasUpperRows,
			false,
			'virtual-line redraws at the beginning must not leave stale history'
		);
		// A wrapped continuation of line one still has real content above it.
		await session.client.request('nvim_exec_lua', [
			"vim.api.nvim_buf_set_lines(0, 0, 1, false, {string.rep('wrapped ', 60)}); vim.cmd('normal! gg'); vim.cmd.redraw()",
			[]
		]);
		await session.scroll(1.2, false, true);
		const wrappedView = (await session.client.request('nvim_exec_lua', [
			'return vim.fn.winsaveview()',
			[]
		])) as { topline: number; skipcol: number };
		assert.equal(wrappedView.topline, 1);
		assert.ok(wrappedView.skipcol > 0);
		await session.prefetchScroll();
		assert.equal(grid.hasUpperRows, true, 'wrapped line one retains its earlier screen rows');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('scroll prefetch caches upper rows without changing the view, cursor or buffer', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-prefetch-'));
	let session: Session | undefined;
	const grid = new Grid();
	const frames: Redraw[] = [];
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') {
				grid.apply(event.events);
				frames.push(event.events);
			}
		});
		await session.attach(80, 25);
		await session.openFile('lines.txt');
		await session.input('50Gzt');
		const snapshot = (): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [
				"return {vim.fn.winsaveview(), vim.api.nvim_buf_get_lines(0, 0, -1, false), require('nido_scroll').screen_cursor()}",
				[]
			]);
		for (const detached of [false, true]) {
			if (detached) await session.scroll(0.2, false, true);
			const before = await snapshot();
			const cachedRows = grid.cells.slice();
			const cells = grid.cells.map((row) => row.map((cell) => cell.text).join(''));
			frames.length = 0;
			await session.prefetchScroll();
			assert.deepEqual(await snapshot(), before);
			assert.deepEqual(
				grid.cells.map((row) => row.map((cell) => cell.text).join('')),
				cells
			);
			for (let row = 0; row < grid.rows; row++) {
				assert.equal(
					grid.cells[row],
					cachedRows[row],
					'prefetch reuses unchanged row images'
				);
			}
			assert.equal(
				grid.needsUpperRows,
				false,
				'history reaches BOF without repeated refills'
			);
			assert.ok(frames.length <= 8, 'refills must use bounded strips and reuse known rows');
			assert.ok(
				frames.every((frame) => frame.at(-1)?.[0] === 'flush'),
				'each strip must remain inside one atomic redraw'
			);
			assert.equal(
				grid.hasUpperRows,
				true,
				JSON.stringify(
					frames.map((frame) =>
						frame.map(([name, ...calls]) => [
							name,
							name === 'grid_scroll' || name === 'nido_scroll' ? calls : calls.length
						])
					)
				)
			);
			for (let i = 0; i < 7; i++) {
				await session.scroll(-1, !detached, true);
				assert.equal(
					grid.hasUpperRows,
					true,
					'successive upward rows reuse the prefetched history'
				);
			}
		}
		await session.input('175Gzt');
		await session.prefetchScroll();
		await session.scroll(-70, true, true);
		assert.equal(grid.hasUpperRows, true, 'an upward page jump retains earlier cached rows');
		assert.equal(grid.needsUpperRows, false, 'the remaining history still reaches BOF');
		await session.input('2');
		await new Promise((resolve) => setTimeout(resolve, 20));
		await session.prefetchScroll();
		await session.input('0G');
		await session.client.request('nvim_eval', ['1']);
		assert.equal(
			((await session.client.request('nvim_win_get_cursor', [0])) as number[])[0],
			20
		);
		await session.input(':let g:nido_prefetch_check = 4');
		await session.prefetchScroll();
		await session.input('2<CR>');
		assert.equal(await session.client.request('nvim_eval', ['g:nido_prefetch_check']), 42);
		await session.input('i_');
		const inserting = await snapshot();
		frames.length = 0;
		await session.prefetchScroll();
		assert.deepEqual(
			await snapshot(),
			inserting,
			'Insert-mode prefetch preserves the view and text'
		);
		assert.equal(
			((await session.client.request('nvim_get_mode', [])) as { mode: string }).mode,
			'i'
		);
		assert.equal(
			grid.hasUpperRows,
			true,
			'editing must not permanently disable the upper cache'
		);
		assert.equal(
			frames.flat().filter((event) => event[0] === 'nido_edit').length,
			0,
			'prefetch must not republish an already delivered edit and cancel pending wheel movement'
		);
		await session.prefetchScroll(true);
		assert.deepEqual(
			await snapshot(),
			inserting,
			'downward prefetch also preserves Insert mode'
		);
		assert.equal(grid.needsLowerRows, false, 'the lower cache reaches EOF');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('scroll prefetch fills history for wrapped lines without repeated refills', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-wrapped-prefetch-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'wrapped.txt'),
			Array.from(
				{ length: 1500 },
				(_, i) => `ROW_${i + 1} ${'const value = example(argument); '.repeat(5)}`
			).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 25);
		await session.openFile('wrapped.txt');
		await session.input('1000Gzt');
		// The bracket scanner runs asynchronously. A later color change correctly invalidates
		// cached row images, so compare reuse only after the initial highlights are ready.
		await session.client.request('nvim_exec_lua', [
			`local namespace = vim.api.nvim_get_namespaces().nido_brackets
assert(vim.wait(3000, function()
  return #vim.api.nvim_buf_get_extmarks(0, namespace, 0, -1, {limit=1}) > 0
end, 10), 'Bracket highlighting did not become ready')
vim.cmd.redraw()`,
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		const before = grid.cells.map((row) => row.map((cell) => cell.text).join(''));
		await session.prefetchScroll();
		assert.deepEqual(
			grid.cells.map((row) => row.map((cell) => cell.text).join('')),
			before
		);
		assert.equal(grid.needsUpperRows, false, 'a wrapped viewport must fill the upper history');
		const images = new Set(grid.cells);
		await session.scroll(-3, false, true);
		assert.equal(grid.needsUpperRows, false, 'small upward deltas must reuse history');
		assert.ok(
			grid.cells.filter((row) => images.has(row)).length > grid.rows / 2,
			'wrapped scrolling must reuse unchanged text images instead of rasterizing the viewport'
		);
		await session.prefetchScroll(true);
		assert.equal(grid.needsLowerRows, false, 'wrapped rows also fill the lower cache');
		const future = grid.futureRows.slice(0, 3);
		await session.scroll(3, false, true);
		assert.deepEqual(
			grid.cells.slice(grid.rows - 4, grid.rows - 1),
			future,
			'downward movement reveals the prefetched wrapped screen rows'
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('split redraw notifications remain invisible until flush and keep scroll metadata', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-redraw-'));
	const frames: Redraw[] = [];
	let session: Session | undefined;
	try {
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') {
				frames.push(event.events);
			}
		});
		await session.client.request('nvim_eval', ['1']);
		frames.length = 0;
		const scroll = [1, 0, 23, 0, 80, -3, 0];
		const first: Redraw = [['grid_line', [1, 0, 0, [['first', 0]]]]];
		const second: Redraw = [['grid_line', [1, 1, 0, [['second', 0]]]]];
		session.client.emit('notification', 'nido:scroll', [scroll]);
		session.client.emit('notification', 'redraw', first);
		session.client.emit('notification', 'redraw', second);
		assert.equal(frames.length, 0);
		session.client.emit('notification', 'redraw', [['flush', []], ...first]);
		assert.deepEqual(frames, [[['nido_scroll', scroll], ...first, ...second, ['flush', []]]]);
		session.client.emit('notification', 'redraw', [['flush', []]]);
		assert.deepEqual(frames[1], [...first, ['flush', []]]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

for (const [kind, wide] of [
	['ASCII', 'abcdef0123456789'.repeat(30)],
	['wide characters and tabs', '\t日本語a'.repeat(60)]
] as const) {
	test(`horizontal scroll reaches long visible lines, preserves detached edits and combines with vertical scrolling (${kind})`, async () => {
		const root = await mkdtemp(join(tmpdir(), 'nido-horizontal-scroll-'));
		const file = join(root, 'wide.txt');
		const source = Array.from({ length: 100 }, (_, index) =>
			index % 2 ? `ROW_${index + 1} ` + wide + ' END' : 'short'
		).join('\n');
		let session: Session | undefined;
		const frames: Redraw[] = [];
		try {
			await writeFile(file, source);
			session = await Session.create(root, (event) => {
				if (event.type === 'redraw') frames.push(event.events);
			});
			await session.openFile('wide.txt');
			await session.attach(70, 20);
			await session.setWordWrap(false);
			const lua = (code: string): Promise<unknown> =>
				session!.client.request('nvim_exec_lua', [code, []]);
			const view = (): Promise<{ leftcol: number; topline: number }> =>
				lua('return vim.fn.winsaveview()') as Promise<{ leftcol: number; topline: number }>;
			for (const follow of [false, true]) {
				await session.input('<Esc>gg0');
				await session.client.request('nvim_eval', ['1']);
				await session.scroll(0, follow, true, 20);
				assert.equal(
					(await view()).leftcol,
					20,
					'A short cursor line must not cap the viewport'
				);
				if (!follow)
					assert.deepEqual(await lua("return require('nido_scroll').cursor()"), [1, 0]);
				await session.scroll(0, follow, true, -20);
				assert.equal((await view()).leftcol, 0);
				await session.scroll(0, follow, true, 1000);
				assert.ok((await view()).leftcol > 100);
				await session.scroll(0, follow, true, 1000);
				const right = await view();
				await session.scroll(0, follow, true, 1000);
				assert.deepEqual(await view(), right, 'Scrolling stops at the right edge');
				await session.scroll(0, follow, true, -1000);
				assert.equal((await view()).leftcol, 0);
			}
			await session.input('<Esc>gg0i');
			await session.client.request('nvim_eval', ['1']);
			await session.scroll(3.25, false, true, 12);
			const diagonal = await view();
			assert.equal(diagonal.leftcol, 12);
			assert.ok(diagonal.topline > 1);
			frames.length = 0;
			await session.scroll(0, false, true, 7);
			assert.equal((await view()).topline, diagonal.topline);
			assert.equal((await view()).leftcol, 19);
			assert.ok(
				frames
					.flat()
					.some(
						([name, ...calls]) =>
							name === 'nido_pixel_scroll' && (calls[0] as unknown[])[0] === 0.25
					)
			);
			const beforePrefetch = await view();
			await session.prefetchScroll(true);
			assert.deepEqual(await view(), beforePrefetch);
			await session.input('X<Esc>');
			await session.client.request('nvim_eval', ['1']);
			assert.equal(await lua('return vim.fn.getline(1)'), 'Xshort');
			assert.equal(await lua('return vim.fn.mode()'), 'n');
			assert.equal((await view()).leftcol, 0, 'Editing returns to the original anchor');
			await session.input('u');
			await session.setWordWrap(true);
			await session.client.request('nvim_eval', ['1']);
			const wrapped = await view();
			await session.scroll(0, false, true, 30);
			assert.deepEqual(await view(), wrapped, 'Horizontal input must not disable wrapping');
			assert.equal(await lua('return vim.wo.wrap'), true);
			assert.equal(await session.modified(), false);
			assert.equal(await readFile(file, 'utf8'), source);
		} finally {
			await session?.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test('horizontal panning preserves the vertical viewport and ignores text inside closed folds', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-horizontal-viewport-'));
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'wide.txt'),
			Array.from({ length: 100 }, () => 'short').join('\n')
		);
		session = await Session.create(root, () => {});
		await session.openFile('wide.txt');
		await session.attach(70, 20);
		await session.setWordWrap(false);
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await lua(
			"vim.wo.scrolloff = 8; local last = vim.fn.line('w$'); vim.api.nvim_buf_set_lines(0, last-1, last, false, {string.rep('wide ', 100)}); vim.cmd.redraw()"
		);
		const before = await lua('return vim.fn.winsaveview().topline');
		await session.scroll(0, false, true, 20);
		assert.equal(await lua('return vim.fn.winsaveview().topline'), before);
		assert.equal(await lua('return vim.fn.winsaveview().leftcol'), 20);
		assert.equal(await lua('return vim.wo.scrolloff'), 0);
		await session.input('<Esc>gg0');
		await session.client.request('nvim_eval', ['1']);
		assert.equal(await lua('return vim.wo.scrolloff'), 8);
		await lua("vim.wo.foldmethod = 'manual'; vim.cmd('2,99fold'); vim.cmd.redraw()");
		await session.scroll(0, false, true, 20);
		assert.equal(await lua('return vim.fn.foldclosed(2)'), 2);
		assert.equal(await lua('return vim.fn.winsaveview().leftcol'), 0);
		assert.equal(await lua('return vim.wo.scrolloff'), 8);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('settling sideways lookahead puts a pushed cursor where the gesture alone would', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-horizontal-lookahead-'));
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'wide.txt'),
			Array.from({ length: 30 }, (_, index) => `ROW_${index} ` + 'x'.repeat(400)).join('\n')
		);
		session = await Session.create(root, () => {});
		await session.openFile('wide.txt');
		await session.attach(70, 20);
		await session.setWordWrap(false);
		const state = (): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [
				"return {vim.fn.winsaveview().leftcol, vim.api.nvim_win_get_cursor(0), require('nido_scroll').cursor()}",
				[]
			]);
		const reset = async (column: number): Promise<void> => {
			await session!.input(`<Esc>gg0${column ? `${column}l` : ''}`);
			await session!.client.request('nvim_eval', ['1']);
		};
		// A cursor at the left edge, and one the gesture never reaches.
		for (const start of [0, 30]) {
			await reset(start);
			await session.scroll(0, true, true, 20);
			const direct = await state();
			await reset(start);
			// The renderer asks for columns ahead of the gesture, then settles back.
			await session.scroll(0, true, true, 12);
			await session.scroll(0, true, true, 20);
			await session.scroll(0, true, true, -12);
			assert.deepEqual(await state(), direct, `cursor starting at column ${start}`);
		}
		// A later gesture starts from where the cursor was left, like Vim's zh.
		await reset(0);
		await session.scroll(0, true, true, 40);
		await new Promise((resolve) => setTimeout(resolve, 600));
		await session.scroll(0, true, true, -20);
		assert.deepEqual(await state(), [20, [1, 40]]);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('vertical scrolling keeps the panned column when the cursor reaches short lines', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-vertical-leftcol-'));
	let session: Session | undefined;
	try {
		// Long lines first, then a block of short lines, then long lines again.
		const long = (index: number): string => `ROW_${index + 1} ` + 'x'.repeat(300);
		const source = Array.from({ length: 200 }, (_, index) =>
			index >= 60 && index < 140 && index % 3 ? 'short' : long(index)
		).join('\n');
		await writeFile(join(root, 'wide.txt'), source);
		session = await Session.create(root, () => {});
		await session.openFile('wide.txt');
		await session.attach(70, 20);
		await session.setWordWrap(false);
		const view = (): Promise<{ leftcol: number; topline: number }> =>
			session!.client.request('nvim_exec_lua', [
				'return vim.fn.winsaveview()',
				[]
			]) as Promise<{
				leftcol: number;
				topline: number;
			}>;
		for (const follow of [false, true]) {
			await session.input('<Esc>gg0');
			await session.client.request('nvim_eval', ['1']);
			await session.scroll(0, follow, true, 100);
			assert.equal((await view()).leftcol, 100);
			// Small touchpad-sized steps push the cursor through every line, short ones included.
			for (let step = 0; step < 120; step++) {
				await session.scroll(0.75, follow, true);
				assert.equal(
					(await view()).leftcol,
					100,
					`Vertical scrolling must not return to the left edge (step ${step})`
				);
			}
			for (let step = 0; step < 120; step++) {
				await session.scroll(-1.5, follow, true);
				assert.equal((await view()).leftcol, 100);
			}
			await session.prefetchScroll(true);
			assert.equal((await view()).leftcol, 100, 'Prefetching restores the panned view');
		}
		assert.equal(await session.modified(), false);
		assert.equal(await readFile(join(root, 'wide.txt'), 'utf8'), source);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('scroll follows pixel distance and preserves insert mode and file contents', async () => {
	assert.equal(scrollOffset(100, 0), 100);
	assert.equal(scrollOffset(100, 60), 12.5);
	assert.equal(scrollOffset(-100, 60), -12.5);
	assert.equal(scrollOffset(100, 120), 0);
	assert.equal(scrollOffset(100, 500), 0);
	let remainder = 0,
		lines = 0;
	for (let i = 0; i < 25; i++) {
		const result = accumulateScroll(remainder, 1, 0, 25, 500);
		remainder = result.remainder;
		lines += result.lines;
	}
	assert.equal(lines, 1);
	assert.deepEqual(accumulateScroll(0, 3, 1, 25, 500), { lines: 3, remainder: 0 });
	assert.equal(accumulateScroll(0, 1, 2, 25, 500).lines, 20);
	assert.equal(accumulateScroll(20, -25, 0, 25, 500).lines, -1);
	assert.equal(accumulateScroll(0, 0, 0, 25, 500).lines, 0);
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-'));
	let session: Session | undefined;
	try {
		const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
		await writeFile(join(root, 'scroll.txt'), content);
		session = await Session.create(root, () => {});
		await session.openFile('scroll.txt');
		await session.scroll(1);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 2);
		await session.input('i');
		await session.client.request('nvim_eval', ['1']);
		await session.scroll(2);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 4);
		assert.equal(await session.client.request('nvim_eval', ['mode()']), 'i');
		assert.equal(await session.modified(), false);
		await session.scroll(-1);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
		const offsets: number[] = [];
		session.client.on('notification', (method: string, args: unknown[]) => {
			if (method === 'nido:pixel_scroll') offsets.push(Number(args[0]));
		});
		await session.scroll(0.2, true, true);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
		assert.ok(Math.abs(offsets.at(-1)! - 0.2) < 0.001);
		await session.scroll(0.9, true, true);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 4);
		assert.ok(Math.abs(offsets.at(-1)! - 0.1) < 0.001);
		await session.scroll(-0.2, true, true);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
		assert.ok(Math.abs(offsets.at(-1)! - 0.9) < 0.001);
		await session.scroll(-100.3, true, true);
		assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 1);
		assert.equal(offsets.at(-1), 0);
		await session.scroll(1000, true, true);
		assert.equal(offsets.at(-1), 0);
		await session.scroll(0.2, true, true);
		assert.equal(offsets.at(-1), 0);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('CodeLens rows compact while clicks, fractional scrolling and the command line stay aligned', () => {
	const grid = new Grid();
	grid.busy = true;
	grid.pixelScrollEnabled = true;
	grid.apply([
		['grid_resize', [1, 3, 12]],
		['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
		['hl_attr_define', [2, {}, {}, [{ hi_name: 'NidoCodeLensHint' }]]],
		[
			'grid_line',
			[
				1,
				0,
				0,
				[
					['R', 1],
					[' ', 0, 2]
				]
			]
		],
		['grid_line', [1, 1, 0, [['a', 0]]]],
		[
			'grid_line',
			[
				1,
				2,
				0,
				[
					['D', 1],
					['h', 2]
				]
			]
		],
		[
			'grid_line',
			[
				1,
				3,
				0,
				[
					['R', 1],
					['x', 0]
				]
			]
		],
		['grid_line', [1, 4, 0, [[' ', 1, 3]]]],
		['grid_line', [1, 5, 0, [['R', 1]]]],
		['grid_line', [1, 6, 0, [['b', 0]]]],
		['grid_line', [1, 7, 0, [['h', 2]]]],
		['grid_line', [1, 9, 0, [['c', 0]]]],
		['grid_line', [1, 11, 0, [[':', 0]]]]
	]);
	const context = {
		measureText: () => ({ width: 8 }),
		...Object.fromEntries(
			[
				'setTransform',
				'fillRect',
				'save',
				'restore',
				'translate',
				'beginPath',
				'rect',
				'clip',
				'drawImage',
				'fillText'
			].map((name) => [name, () => {}])
		)
	} as unknown as CanvasRenderingContext2D;
	let glyphs = 0;
	context.fillText = () => {
		glyphs++;
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => context,
		ownerDocument: {
			createElement: () => ({
				width: 0,
				height: 0,
				getContext: (type: string) => (type === '2d' ? context : null),
				addEventListener: () => {}
			})
		}
	} as unknown as HTMLCanvasElement;
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		value: { devicePixelRatio: 2 },
		configurable: true
	});
	try {
		grid.draw(canvas, 160, 264, 14, 'monospace', false);
		assert.equal(grid.cellHeight, 24);
		assert.deepEqual(
			Array.from({ length: grid.rows }, (_, row) => grid.rowTop(row)),
			[0, 17, 41, 58, 82, 106, 123, 147, 164, 188, 212, 236]
		);
		assert.equal(grid.rowTop(0.5), 8.5);
		assert.equal(grid.rowTop(1.5), 29);
		assert.equal(grid.extraRows, 2);
		for (let row = 0; row < grid.rows - 1; row++) {
			const top = grid.rowY(row);
			assert.equal(grid.rowAt(top), row);
			assert.equal(grid.rowAt(top + (grid.rowTop(row + 1) - grid.rowTop(row)) / 2), row);
		}
		assert.equal(grid.rowY(grid.rows - 1), 264);
		assert.equal(grid.rowAt(238), -1);
		assert.equal(grid.rowAt(240), -1);
		grid.scrolling = true;
		grid.scrollFraction = 0.3;
		const originalGlyphs = glyphs;
		grid.draw(canvas, 160, 264, 14, 'monospace', false);
		assert.equal(glyphs, originalGlyphs, 'fractional scrolling reuses the row images');
		assert.equal(grid.rowY(1), 11.9);
		assert.equal(grid.rowAt(grid.rowY(1) + 12), 1);
		assert.equal(grid.rowY(grid.rows - 1), 264);
		grid.scrolling = false;
		grid.draw(canvas, 160, 264, 14, 'monospace', false);
		assert.equal(
			grid.rowY(1),
			11.9,
			'settling keeps fractional geometry and click targets stable'
		);
		assert.equal(grid.rowAt(11.89), 0);
		assert.equal(grid.rowAt(11.9), 1);
		assert.equal(grid.rowY(grid.rows - 1), 264);
		assert.equal(glyphs, originalGlyphs, 'settling reuses the native row images');
		grid.apply([['grid_line', [1, 0, 0, [['x', 0]]]], ['flush']]);
		grid.scrollFraction = 0;
		grid.draw(canvas, 160, 264, 14, 'monospace', false);
		assert.ok(glyphs > originalGlyphs, 'edited rows invalidate the cached text');
		assert.equal(grid.rowTop(1), 24);
		assert.equal(grid.extraRows, 1);
		assert.equal(grid.rowY(grid.rows - 1), 264);
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('grid updates preserve highlights, wide characters and scroll regions', () => {
	const grid = new Grid();
	grid.apply([
		['grid_resize', [1, 5, 3]],
		[
			'grid_line',
			[
				1,
				0,
				0,
				[
					['日', 2],
					['', 2],
					['x', 3, 3]
				]
			]
		],
		['grid_line', [1, 1, 0, [['b', 4, 5]]]],
		['grid_line', [1, 2, 0, [['c', 5, 5]]]],
		['grid_scroll', [1, 0, 3, 0, 5, 1, 0]]
	]);
	assert.deepEqual(grid.cells[0][0], { text: 'b', highlight: 4 });
	assert.equal(grid.cells[1][4].text, 'c');
	assert.equal(grid.cells[2][0].text, ' ');
	grid.apply([['grid_scroll', [1, 0, 3, 0, 5, -1, 0]]]);
	assert.equal(grid.cells[1][0].text, 'b');
	assert.equal(grid.apply([['flush']]), true);
	assert.equal(
		vimKey({
			key: '<',
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
			metaKey: false,
			isComposing: false
		}),
		'<LT>'
	);
	assert.equal(
		vimKey({
			key: 'Tab',
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
			metaKey: false,
			isComposing: false
		}),
		'<S-Tab>'
	);
	assert.equal(
		vimKey({
			key: 'F12',
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
			metaKey: false,
			isComposing: false
		}),
		'<S-F12>'
	);
	assert.equal(
		vimKey({
			key: 'Enter',
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			metaKey: false,
			isComposing: true
		}),
		null
	);
});

test('switching file tabs restores the scroll position, including a view scrolled away from the cursor', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-tab-view-'));
	let session: Session | undefined;
	try {
		for (const name of ['long.txt', 'other.txt']) {
			await writeFile(
				join(root, name),
				Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n')
			);
		}
		session = await Session.create(root, () => {});
		await session.openFile('other.txt');
		const other = (await session.client.request('nvim_get_current_buf', [])) as number;
		await session.openFile('long.txt');
		const long = (await session.client.request('nvim_get_current_buf', [])) as number;
		const view = async (): Promise<{ topline: number; lnum: number }> =>
			(await session!.client.request('nvim_eval', ['winsaveview()'])) as {
				topline: number;
				lnum: number;
			};
		const away = async (): Promise<void> => {
			await session!.selectBuffer(other);
			await session!.selectBuffer(long);
			await session!.client.request('nvim_eval', ['1']);
		};
		// A cursor near the bottom of the view stays there instead of being centered.
		await session.client.request('nvim_exec_lua', [
			'vim.fn.winrestview({topline=100, lnum=110, col=0})',
			[]
		]);
		await session.client.request('nvim_command', ['redraw']);
		const before = await view();
		await away();
		assert.deepEqual(await view(), before);

		// A view scrolled away by the wheel comes back, and editing resumes at the cursor.
		await session.scroll(200, false);
		const scrolled = await view();
		assert.ok(scrolled.topline > 250);
		await away();
		assert.equal((await view()).topline, scrolled.topline);
		assert.deepEqual(
			await session.client.request('nvim_exec_lua', [
				"return require('nido_scroll').cursor()",
				[]
			]),
			[before.lnum, 0]
		);
		await session.input('iX<Esc>');
		await new Promise((done) => setTimeout(done, 50));
		assert.equal(
			await session.client.request('nvim_eval', [`getline(${before.lnum})`]),
			`Xline ${before.lnum}`
		);

		// A jump made on returning wins over the remembered cursor.
		await session.scroll(200, false);
		await session.selectBuffer(other);
		await session.openFile('long.txt', 900, 1);
		await session.input('iY<Esc>');
		await new Promise((done) => setTimeout(done, 50));
		assert.equal(await session.client.request('nvim_eval', ['getline(900)']), 'Yline 900');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('opening a file into the empty start buffer drops the empty buffer scroll caches', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-reused-buffer-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 24);
		// A new workspace warms its caches on the empty buffer: both ends are reached at once.
		await session.prefetchScroll(true);
		assert.equal(grid.limitScroll(3), 0);
		const empty = await session.client.request('nvim_eval', ['bufnr()']);
		await session.openFile('lines.txt');
		// :edit reuses that buffer, so its number alone does not show the switch.
		assert.equal(await session.client.request('nvim_eval', ['bufnr()']), empty);
		await new Promise((done) => setTimeout(done, 30));
		assert.equal(grid.limitScroll(3), 3, 'the wheel must not stop at the empty buffer end');
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('opening folds drops scroll caches that ended at the folded end of the file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-fold-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 24);
		await session.openFile('lines.txt');
		await session.client.request('nvim_command', ['setlocal foldmethod=manual']);
		await session.client.request('nvim_command', ['30,190fold']);
		await session.input('gg');
		await new Promise((done) => setTimeout(done, 30));
		// The closed fold lets the refill reach the end of the file within a few rows.
		await session.prefetchScroll(true);
		await new Promise((done) => setTimeout(done, 30));
		const folded = grid.limitScroll(1000);
		assert.ok(folded < 100, `the folded file ends after ${folded} rows`);
		// Opening the fold neither edits the text nor moves the viewport.
		await session.input('zR');
		await new Promise((done) => setTimeout(done, 30));
		assert.ok(
			grid.limitScroll(1000) > folded,
			'the wheel must not stop where the closed fold used to end the file'
		);
		// The refill starts over from the viewport instead of the folded depth.
		await session.prefetchScroll(true);
		await new Promise((done) => setTimeout(done, 30));
		assert.ok(grid.futureRows.length > 150, `${grid.futureRows.length} opened rows cached`);
		// Closing it again must not leave the opened rows cached either.
		await session.input('zE');
		await session.client.request('nvim_command', ['30,190fold']);
		await new Promise((done) => setTimeout(done, 30));
		assert.ok(
			grid.futureRows.every(
				(row) => !/line (3\d|1[0-8]\d)\b/.test(row.map((cell) => cell.text).join(''))
			),
			'rows hidden by the new fold must not stay cached below the viewport'
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('toggling word wrap drops scroll caches measured with the other wrapping', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-wrap-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${'x'.repeat(150)}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 24);
		await session.openFile('lines.txt');
		await session.setWordWrap(false);
		await session.input('gg');
		await new Promise((done) => setTimeout(done, 30));
		await session.prefetchScroll(true);
		await new Promise((done) => setTimeout(done, 30));
		const unwrapped = grid.limitScroll(1000);
		assert.ok(unwrapped < 60, `the unwrapped file ends after ${unwrapped} rows`);
		await session.setWordWrap(true);
		await new Promise((done) => setTimeout(done, 30));
		assert.ok(
			grid.limitScroll(1000) > unwrapped,
			'the wheel must not stop where the unwrapped lines ended'
		);
		// The refill must start over too: continuing from the unwrapped depth would skip rows
		// and leave the renderer with an end-of-file mark but no rows to reach it.
		await session.prefetchScroll(true);
		await new Promise((done) => setTimeout(done, 30));
		assert.equal(grid.limitScroll(1000), grid.futureRows.length);
		assert.ok(grid.futureRows.length > 100, `${grid.futureRows.length} wrapped rows cached`);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('prefetched rows number their lines from the real cursor', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-scroll-prefetch-numbers-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		await writeFile(
			join(root, 'lines.txt'),
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
		);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		await session.attach(80, 24);
		await session.openFile('lines.txt');
		const checkCache = (relative: boolean): void => {
			let checked = 0;
			for (const row of grid.futureRows) {
				const text = row.map((cell) => cell.text).join('');
				const match = text.match(/^\s*(\d+)\s+line (\d+)\s*$/);
				if (!match) continue;
				const line = Number(match[2]);
				// The cursor stays on line 1, above every cached row.
				assert.equal(
					Number(match[1]),
					relative ? line - 1 : line,
					`number of line ${line}`
				);
				const first = text.indexOf(match[1]);
				for (const cell of row.slice(first, first + match[1].length)) {
					assert.equal(
						grid.highlights.get(cell.highlight)?.foreground,
						0x858585,
						`line ${line} is not the cursor line`
					);
				}
				checked++;
			}
			assert.ok(checked > 100, `checked ${checked} cached rows`);
		};
		for (const relative of [false, true]) {
			await session.setRelativeLineNumbers(relative);
			await session.input('gg');
			await new Promise((done) => setTimeout(done, 30));
			// An edit drops the caches, so the refill draws every row again.
			await session.input('x');
			await session.input('u');
			await new Promise((done) => setTimeout(done, 30));
			await session.prefetchScroll(true);
			await new Promise((done) => setTimeout(done, 30));
			checkCache(relative);
			assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [1, 0]);
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});
