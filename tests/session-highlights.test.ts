import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';
import { Grid } from '../src/renderer/src/grid/grid';

test('source previews use Neovim syntax colors without changing editor buffers or starting FileType plugins', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-source-colors-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		await session.client.request('nvim_exec_lua', [
			`vim.g.preview_filetypes = 0
vim.api.nvim_create_autocmd('FileType', {callback=function() vim.g.preview_filetypes = vim.g.preview_filetypes + 1 end})`,
			[]
		]);
		const snapshot =
			'return {vim.api.nvim_list_bufs(), vim.api.nvim_get_current_buf(), vim.bo.modified}';
		const buffers = await session.client.request('nvim_exec_lua', [snapshot, []]);
		for (const [path, source] of [
			['sample.rs', 'fn main() {\n/* comment\n日本語 🐱 */\nlet message = "<script>";\n}'],
			[
				'sample.ts',
				'const message = "日本語 🐱";\n/* comment\ncontinued */\nexport function run() { return 42; }'
			],
			['sample.tsx', 'const view = <div title="日本語">Hello</div>;']
		]) {
			const [before, after] = await session.highlightSources(path, source, source);
			assert.equal(
				before.map((line) => line.map((span) => span.text).join('')).join('\n'),
				source
			);
			assert.deepEqual(after, before);
			assert.ok(
				new Set(before.flat().map((span) => span.color)).size > 1,
				`${path} needs syntax colors`
			);
			if (!path.endsWith('.tsx')) {
				assert.equal(
					before[1][0].color,
					before[2][0].color,
					`${path} keeps multiline comment state`
				);
			}
		}
		const plain = await session.highlightSources(
			'unknown.nido-unknown',
			'',
			'plain <script>日本語</script>'
		);
		assert.deepEqual(plain[0], []);
		assert.equal(
			plain[1][0].map((span) => span.text).join(''),
			'plain <script>日本語</script>'
		);
		const longSource =
			'fn main() {}\n' +
			Array.from({ length: 150 }, (_, i) => `// ${i} ${'long diff line '.repeat(20)}`).join(
				'\n'
			);
		const longPreview = await session.highlightSources('main.rs', '', longSource);
		assert.equal(
			longPreview[1].map((line) => line.map((span) => span.text).join('')).join('\n'),
			longSource
		);
		assert.deepEqual(await session.client.request('nvim_exec_lua', [snapshot, []]), buffers);
		assert.equal(await session.client.request('nvim_eval', ['g:preview_filetypes']), 0);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test('TypeScript import bindings and type-only keywords use the reference theme colors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-import-colors-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const source = "import { run } from './lib';\nimport type {\n  Shape\n} from './lib';";
		for (const path of ['sample.ts', 'sample.tsx']) {
			const [lines] = await session.highlightSources(path, source, '');
			const ink = (row: number, word: string): string | undefined =>
				lines[row].find((span) => span.text.includes(word))?.color;
			assert.equal(ink(0, 'import'), '#c586c0', path);
			assert.equal(ink(0, 'run'), '#9cdcfe', path);
			assert.equal(ink(1, 'type'), '#569cd6', path);
			assert.equal(ink(2, 'Shape'), '#4ec9b0', path);
		}
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('TypeScript await uses the VS Code control-flow color without recoloring async or text', async () => {
	const session = await Session.create(process.cwd(), () => {});
	try {
		const source = [
			'async function load() {',
			"  await client.request('ok');",
			'  return await pending;',
			'}',
			'const loadMore = async () => await (pending);',
			'for await (const item of items) {}',
			'await using resource = open();',
			'object.await;',
			'const object = { await: pending };',
			'const text = "await";',
			'// await',
			'const template = `await`;'
		];
		const expected: [number, string, string][] = [
			[0, 'async', '#569cd6'],
			[1, 'await', '#c586c0'],
			[2, 'await', '#c586c0'],
			[4, 'async', '#569cd6'],
			[4, 'await', '#c586c0'],
			[5, 'await', '#c586c0'],
			[6, 'await', '#c586c0'],
			[9, 'await', '#ce9178'],
			[10, 'await', '#6a9955'],
			[11, 'await', '#ce9178']
		];
		for (const path of ['sample.ts', 'sample.tsx']) {
			const [lines] = await session.highlightSources(path, source.join('\n'), '');
			for (const [row, word, color] of expected) {
				const column = source[row].indexOf(word);
				let end = 0;
				const span = lines[row].find((span) => (end += span.text.length) > column);
				assert.equal(span?.color, color, `${path}:${row + 1}: ${word}`);
			}
			for (const row of [7, 8]) {
				assert.notEqual(
					lines[row].find((span) => span.text.includes('await'))?.color,
					'#c586c0',
					`${path}:${row + 1}: a property named await is not control flow`
				);
			}
		}
	} finally {
		await session.stop();
	}
});

test('TypeScript casts and satisfies use VS Code control-flow colors without recoloring properties or text', async () => {
	const session = await Session.create(process.cwd(), () => {});
	try {
		const source = [
			'const value = input as Shape;',
			'const config = input satisfies Shape;',
			'const tuple = [1] as const;',
			'const nested = (input as Shape);',
			'import { value as alias } from "./lib";',
			'export { value as alias };',
			'const object = { as : input, satisfies: input };',
			'object.as; object.satisfies;',
			'const text = "as satisfies";',
			'// as satisfies',
			'const template = `as satisfies`;',
			'const shorthand = { as, satisfies };',
			'const multiline = (input',
			'  as Shape) satisfies Shape;',
			'const methods = { as() {}, satisfies() {} };',
			'const callback = input as (() => void);',
			'const typed = input as (Shape);',
			'const nested = { value: input as Shape, config: input satisfies Shape };'
		];
		for (const path of ['sample.ts', 'sample.tsx']) {
			const [lines] = await session.highlightSources(path, source.join('\n'), '');
			const ink = (row: number, word: string): string | undefined => {
				const column = source[row].indexOf(word);
				let end = 0;
				return lines[row].find((span) => (end += span.text.length) > column)?.color;
			};
			for (const row of [0, 2, 3, 4, 5]) {
				assert.equal(ink(row, 'as'), '#c586c0', `${path}:${row + 1}: as`);
			}
			assert.equal(ink(1, 'satisfies'), '#c586c0', `${path}: satisfies`);
			for (const row of [0, 1, 3]) {
				assert.equal(ink(row, 'Shape'), '#4ec9b0', `${path}: user-defined types`);
			}
			assert.equal(ink(2, 'const;'), '#569cd6', `${path}: const assertion`);
			assert.equal(ink(13, 'as'), '#c586c0', `${path}: multiline assertion`);
			assert.equal(ink(13, 'satisfies'), '#c586c0', `${path}: parenthesized constraint`);
			for (const row of [15, 16, 17]) {
				assert.equal(ink(row, 'as'), '#c586c0', `${path}: nested assertion`);
			}
			assert.equal(ink(17, 'satisfies'), '#c586c0', `${path}: nested constraint`);
			assert.equal(ink(15, 'void'), '#4ec9b0', `${path}: function type`);
			assert.equal(ink(16, 'Shape'), '#4ec9b0', `${path}: parenthesized type`);
			for (const row of [6, 7, 11, 14]) {
				for (const word of ['as', 'satisfies']) {
					assert.equal(ink(row, word), '#9cdcfe', `${path}: property ${word}`);
				}
			}
			for (const [row, color] of [
				[8, '#ce9178'],
				[9, '#6a9955'],
				[10, '#ce9178']
			] as const) {
				for (const word of ['as', 'satisfies']) {
					assert.equal(ink(row, word), color, `${path}: text ${word}`);
				}
			}
		}
	} finally {
		await session.stop();
	}
});

test('Dark Modern syntax colors match the official palette in TypeScript, TSX and Rust previews', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-dark-modern-'));
	let session: Session | undefined;
	try {
		session = await Session.create(root, () => {});
		const cases: [string, string, [number, string, string][]][] = [
			[
				'sample.ts',
				'/** Documentation */\nfunction pick<T>(value: T): T { return value; }\nconst upper = "ok".toUpperCase();\nconst pattern = /hello/;\nconst escaped = "a\\nb";\nconst length = upper.length;\nclass Example { apply() { this.busy = true; } }\nconst style = styles?.theme.emptyTree;',
				[
					[0, 'Documentation', '#6a9955'],
					[1, 'pick', '#dcdcaa'],
					[1, 'T', '#4ec9b0'],
					[1, 'value', '#9cdcfe'],
					[1, 'return', '#c586c0'],
					[2, 'toUpperCase', '#dcdcaa'],
					[3, 'hello', '#d16969'],
					[4, '\\n', '#d7ba7d'],
					[5, 'length', '#9cdcfe'],
					[6, 'this', '#569cd6'],
					[7, 'theme', '#9cdcfe'],
					[7, 'emptyTree', '#9cdcfe']
				]
			],
			[
				'sample.tsx',
				'const view = <div title="ok">Hello</div>;\nclass Example { apply() { this.busy = true; } }\nconst component = <FeaturesPage onClose={focusEditor} />;\nconst nested = <Example><span /></Example>;\nconst styled = <ReactComponent className={styles.emptyTree} />;\nconst namespaced = <UI.View>\n</UI.View>;',
				[
					[0, 'div', '#569cd6'],
					[0, 'title', '#9cdcfe'],
					[0, 'ok', '#ce9178'],
					[1, 'this', '#569cd6'],
					[0, '</', '#808080'],
					[2, 'FeaturesPage', '#4ec9b0'],
					[2, '/>', '#808080'],
					[3, '/>', '#808080'],
					[3, 'Example', '#4ec9b0'],
					[4, 'ReactComponent', '#4ec9b0'],
					[4, 'emptyTree', '#9cdcfe'],
					[5, 'UI.View', '#4ec9b0'],
					[6, 'UI.View', '#4ec9b0']
				]
			],
			[
				'sample.rs',
				'fn greet(value: u32) -> bool { true }\nlet text: &str = "ok";\n// Documentation\n#[cfg(test)]\n#[test]\nfn example() { assert!(true); panic!("oops"); dbg!(text); }\nfn borrow<\'a>(value: &\'a str) -> &\'a str { value }\nfn fallible() { work()?; }',
				[
					[0, 'fn', '#569cd6'],
					[0, 'greet', '#dcdcaa'],
					[0, 'u32', '#4ec9b0'],
					[0, 'bool', '#4ec9b0'],
					[0, 'true', '#569cd6'],
					[1, 'str', '#4ec9b0'],
					[1, 'ok', '#ce9178'],
					[2, 'Documentation', '#6a9955'],
					[1, '&', '#d4d4d4'],
					[3, 'cfg', '#cccccc'],
					[4, 'test', '#cccccc'],
					[5, 'assert!', '#dcdcaa'],
					[5, 'panic!', '#dcdcaa'],
					[5, 'dbg!', '#dcdcaa'],
					[6, "'a", '#4ec9b0'],
					[7, '?', '#d4d4d4']
				]
			]
		];
		for (const [path, source, colors] of cases) {
			const [lines] = await session.highlightSources(path, source, '');
			for (const [row, word, color] of colors) {
				assert.equal(
					lines[row].find((span) => span.text.includes(word))?.color,
					color,
					`${path}: ${word}`
				);
			}
		}
		assert.equal(
			await session.client.request('nvim_exec_lua', [
				"return vim.api.nvim_get_hl(0, {name='Normal', link=false}).fg",
				[]
			]),
			0xcccccc
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('bracket pairs share depth colors, ignore strings and comments, and refresh after edits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-brackets-'));
	let session: Session | undefined;
	try {
		const content =
			'fn main() {\n  let x = ([1]);\n  let s = "([{}])"; // []\n  /* {\n  } */\n}\n';
		await writeFile(join(root, 'pairs.txt'), content);
		session = await Session.create(root, () => {});
		await session.openFile('pairs.txt');
		await session.client.request('nvim_exec_lua', ['vim.bo.syntax = "rust"', []]);
		const marks = async (): Promise<[number, number, number, { hl_group: string }][]> => {
			await session!.client.request('nvim_exec_lua', [
				'vim.wait(150); vim.cmd("redraw!")',
				[]
			]);
			return session!.client.request('nvim_exec_lua', [
				"return vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('nido_brackets'), 0, -1, {details=true})",
				[]
			]) as Promise<[number, number, number, { hl_group: string }][]>;
		};
		const result = await marks();
		assert.equal(result.length, 8);
		const color = (row: number, column: number): string | undefined =>
			result.find((mark) => mark[1] === row && mark[2] === column)?.[3].hl_group;
		assert.equal(color(0, 7), color(0, 8));
		assert.equal(color(0, 10), color(5, 0));
		assert.equal(color(1, 10), color(1, 14));
		assert.equal(color(1, 11), color(1, 13));
		assert.notEqual(color(0, 10), color(1, 10));
		assert.notEqual(color(1, 10), color(1, 11));
		await session.client.request('nvim_exec_lua', [
			"vim.api.nvim_buf_set_lines(0, 0, -1, false, {'()'}); vim.api.nvim_exec_autocmds('TextChanged', {buffer=0})",
			[]
		]);
		assert.equal((await marks()).length, 2);
		assert.equal(await readFile(join(root, 'pairs.txt'), 'utf8'), content);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('bracket guides follow the innermost scope, ignore quoted brackets and clear on buffer switches', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-bracket-guides-'));
	let session: Session | undefined;
	const grid = new Grid();
	try {
		await writeFile(
			join(root, 'scope.txt'),
			'function outer() {\n\tif (true) {\n\t\tconst s = "{ fake }"; // {\n\t\twork(\n\t\t\t"日",\n\t\t);\n\t}\n}\nconst empty = {};\n'
		);
		await writeFile(join(root, 'plain.txt'), 'plain text\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid.apply(event.events);
		});
		const lua = (code: string): ReturnType<Session['client']['request']> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		await session.openFile('scope.txt');
		await session.attach(100, 24);
		await lua(
			'vim.bo.syntax = "javascript"; vim.bo.tabstop = 4; vim.wait(200); vim.cmd("redraw!")'
		);
		await lua('return 1');
		assert.equal(grid.bracketGuides.length, 3);
		const before = await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)');
		await session.input('5G');
		await lua('vim.cmd("redraw!")');
		await lua('return 1');
		const active = grid.bracketGuides.filter((guide) => guide.active);
		assert.equal(active.length, 1);
		assert.deepEqual([active[0].top, active[0].bottom], [3, 5]);
		const offset = (await lua(
			'return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff'
		)) as number;
		assert.equal(active[0].column, offset + 8, 'tabs use display columns');
		assert.ok(active[0].opening > active[0].column);
		await session.input('3G');
		await lua('vim.cmd("redraw!")');
		await lua('return 1');
		assert.deepEqual(
			grid.bracketGuides
				.filter((guide) => guide.active)
				.map((guide) => [guide.top, guide.bottom]),
			[[1, 6]]
		);
		assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), before);
		await lua("vim.wo.foldmethod = 'manual'; vim.cmd('1,8fold'); vim.cmd('redraw!')");
		await lua('return 1');
		assert.equal(grid.bracketGuides.length, 0, 'folded scopes do not leave dangling guides');
		await session.input('zo');
		await lua('vim.cmd("redraw!")');
		await lua('return 1');
		assert.equal(grid.bracketGuides.length, 3);
		await session.openFile('plain.txt');
		await lua('vim.cmd("redraw!")');
		await lua('return 1');
		assert.equal(grid.bracketGuides.length, 0);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('bracket guides stay on their brackets from cursor movement into pixel scrolling', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-bracket-scroll-'));
	const grid = new Grid();
	const misplaced: string[] = [];
	let checking = false;
	let checked = 0;
	let session: Session | undefined;
	try {
		const scopes = Array.from({ length: 12 }, (_, index) =>
			[
				`fn scope_${index}() {`,
				'    if ready() {',
				'        collect(',
				...Array.from({ length: 6 }, (_, value) => `            value_${value},`),
				'        );',
				'    }',
				'}',
				''
			].join('\n')
		);
		await writeFile(join(root, 'scopes.rs'), scopes.join('\n'));
		session = await Session.create(root, (event) => {
			if (event.type !== 'redraw') return;
			grid.apply(event.events);
			if (!checking) return;
			for (const { top, bottom, opening, closing } of grid.bracketGuides) {
				for (const [row, column, brackets] of [
					[top, opening, '([{'],
					[bottom, closing, ')]}']
				] as const) {
					if (column < 0) continue;
					const text = grid.cells[row]?.[column]?.text;
					checked++;
					if (!text || !brackets.includes(text)) misplaced.push(`${row}:${column}`);
				}
			}
		});
		await session.openFile('scopes.rs');
		await session.attach(72, 20);
		await session.client.request('nvim_exec_lua', [
			`local buffer = vim.api.nvim_get_current_buf()
assert(vim.wait(5000, function() return require('nido_brackets').ready(buffer) end, 5))
vim.cmd.redraw({bang=true})`,
			[]
		]);
		checking = true;
		for (const line of [25, 37, 49]) {
			await Promise.all([session.input(`${line}Gzzj`), session.scroll(-0.3, false, true)]);
			await session.scroll(-1.85, false, true);
			await session.prefetchScroll(true);
			await Promise.all([session.input('2k'), session.scroll(0.2, false, true)]);
		}
		assert.ok(checked > 0, 'The test must see bracket guides while scrolling');
		assert.equal(misplaced.length, 0, `A guide arrived before its grid row at ${misplaced[0]}`);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test('indent guides follow depth, tabs and blank lines without changing text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-indent-'));
	const grid = new Grid();
	let session: Session | undefined;
	try {
		const content = 'root\n  child\n    nested\n\n    sibling\n\tchild\nroot\n';
		await writeFile(join(root, 'indent.txt'), content);
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') {
				grid.apply(event.events);
			}
		});
		await session.openFile('indent.txt');
		await session.client.request('nvim_exec_lua', [
			'vim.bo.shiftwidth = 2; vim.bo.tabstop = 2; vim.cmd("redraw!")',
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		const guides = (row: number): Grid['cells'][number] =>
			grid.cells[row].filter((cell) => cell.text === '│');
		assert.equal(guides(0).length, 0);
		assert.equal(guides(1).length, 1);
		assert.equal(guides(2).length, 2);
		assert.equal(guides(3).length, 2);
		assert.equal(guides(5).length, 1);
		const colors = guides(2).map((cell) => grid.highlights.get(cell.highlight)?.foreground);
		assert.deepEqual(colors, [0x75633f, 0x476a86]);
		await session.client.request('nvim_exec_lua', [
			'vim.wo.wrap = false; vim.api.nvim_win_set_cursor(0, {3, 4}); vim.fn.winrestview({leftcol=2}); vim.cmd("redraw!")',
			[]
		]);
		await session.client.request('nvim_eval', ['1']);
		assert.equal(guides(2).length, 1);
		assert.equal(grid.highlights.get(guides(2)[0].highlight)?.foreground, 0x476a86);
		assert.equal(await session.modified(), false);
		assert.equal(await readFile(join(root, 'indent.txt'), 'utf8'), content);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test('a renderer joining after Neovim startup receives syntax colors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-colors-'));
	let grid: Grid | undefined;
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'main.rs'), 'fn main() { let greeting = "hello"; }\n');
		session = await Session.create(root, (event) => {
			if (event.type === 'redraw') grid?.apply(event.events);
		});
		await session.openFile('main.rs');
		// The React renderer does not exist while Session.create initializes Neovim.
		grid = new Grid();
		await session.attach(90, 25);
		await session.client.request('nvim_eval', ['1']);
		const row = grid.cells.find((cells) =>
			cells
				.map((cell) => cell.text)
				.join('')
				.includes('fn main')
		);
		assert.ok(row);
		const start = row
			.map((cell) => cell.text)
			.join('')
			.indexOf('fn main');
		assert.equal(grid.highlights.get(row[start].highlight)?.foreground, 0x569cd6);
		const string = row
			.map((cell) => cell.text)
			.join('')
			.indexOf('hello');
		assert.equal(grid.highlights.get(row[string].highlight)?.foreground, 0xce9178);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});
